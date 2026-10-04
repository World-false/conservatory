/**
 * Restricted-token construction for the Windows command sandbox.
 *
 * The token the confined child runs under is built from the supervisor's own
 * primary token with `CreateRestrictedToken`. Three properties make it the
 * boundary the rest of the system relies on:
 *
 *  1. `DISABLE_MAX_PRIVILEGE | LUA_TOKEN` make it a *restricted* token: every
 *     access is checked twice, once against the ordinary token SIDs and once
 *     against the restricting SIDs. The sandbox's capability SID is one of
 *     the restricting SIDs, so a DENY ACE naming it hides a directory from the
 *     child alone — the supervisor never carries that SID.
 *  2. The restricting list keeps the logon SID, `Everyone` and `BUILTIN\Users`
 *     so ordinary reads (system DLLs, the shell, the project tree) still pass
 *     the second check. Without them a confined `cmd.exe` cannot even load its
 *     own libraries.
 *  3. `TOKEN_ADJUST_DEFAULT` lets the token's default DACL gain one
 *     full-access ACE for the capability SID, so every *new* object the child
 *     creates (anonymous stdio pipes, temporary files) passes the second check
 *     while its creation stays gated by the parent directory's DACL.
 *
 * Fail closed: any Win32 failure throws with the API name and code, and the
 * caller never spawns an unrestricted child.
 */

import { createHash } from 'node:crypto';

import {
  DISABLE_MAX_PRIVILEGE,
  ERROR_SUCCESS,
  FILE_ALL_ACCESS,
  GRANT_ACCESS,
  LUA_TOKEN,
  PROCESS_QUERY_INFORMATION,
  SE_GROUP_INTEGRITY,
  SE_GROUP_LOGON_ID,
  SID_AND_ATTRIBUTES_SIZE,
  TOKEN_ADJUST_DEFAULT,
  TOKEN_ASSIGN_PRIMARY,
  TOKEN_DUPLICATE,
  TOKEN_GROUPS_OFFSET,
  TOKEN_MANDATORY_LABEL_SIZE,
  TOKEN_QUERY,
  TokenDefaultDacl,
  TokenGroups,
  TokenIntegrityLevel,
  allocBytes,
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodePtrAt,
  decodeUint32,
  encodeUint32,
  isNullPtr,
  ptrAddress,
  throwLastError,
  throwWin32,
} from './win32';
import type { NativePtr, Win32Bindings } from './win32';
import { buildExplicitAccess } from './acl';

/** WELL_KNOWN_SID_TYPE value for BUILTIN\Users (S-1-5-32-545). */
export const WinBuiltinUsersSid = 27;
/** WELL_KNOWN_SID_TYPE value for Everyone (S-1-1-0). */
export const WinWorldSid = 1;
/** WELL_KNOWN_SID_TYPE value for NT AUTHORITY\RESTRICTED (S-1-5-12). */
export const WinRestrictedCodeSid = 18;
/** WELL_KNOWN_SID_TYPE value for the Low mandatory level (S-1-16-4096). */
export const WinLowLabelSid = 66;

/**
 * Derive the sandbox capability SID (`S-1-4-x-y`) for one workspace. The
 * identity is deterministic from the canonical workspace path, so every
 * command of the same agent reuses the same ACEs instead of minting a new
 * principal per call.
 */
export function capabilitySidFor(workspacePath: string): string {
  const digest = createHash('sha256').update(workspacePath, 'utf8').digest();
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return `S-1-4-${first}-${second}`;
}

/** Parse an SDDL SID string into a LocalAlloc'd SID the caller must free. */
export function parseSidString(api: Win32Bindings, sddl: string): NativePtr {
  const slot = allocPtrSlot();
  if (api.convertStringSidToSidW(sddl, slot) === 0) {
    throwLastError(api, 'ConvertStringSidToSidW', sddl);
  }
  const sid = decodePtr(slot);
  if (sid === null) {
    throwWin32(api, 'ConvertStringSidToSidW', api.getLastError(), `null SID for ${sddl}`);
  }
  return sid;
}

/** Create one well-known SID and assert its validity. */
export function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(68);
  const sizeSlot = allocUint32();
  encodeUint32(sizeSlot, 68);
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) {
    throwLastError(api, 'CreateWellKnownSid', `type ${type}`);
  }
  if (api.isValidSid(sid) === 0) {
    throwLastError(api, 'IsValidSid', `CreateWellKnownSid type ${type}`);
  }
  return sid;
}

/**
 * Open this process's primary token with the rights the restricted-token
 * construction needs. The handle is obtained through a real OpenProcess handle
 * because Koffi cannot address the GetCurrentProcess pseudo-handle.
 */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid);
  if (isNullPtr(processHandle)) {
    throwLastError(api, 'OpenProcess', `pid ${process.pid}`);
  }
  const tokenSlot = allocPtrSlot();
  const opened = api.openProcessToken(
    processHandle,
    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  );
  if (opened === 0) {
    const code = api.getLastError();
    api.closeHandle(processHandle);
    throwWin32(api, 'OpenProcessToken', code, `pid ${process.pid}`);
  }
  if (api.closeHandle(processHandle) === 0) {
    throwLastError(api, 'CloseHandle', 'OpenProcess handle');
  }
  const token = decodePtr(tokenSlot);
  if (token === null) {
    throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle');
  }
  return token;
}

/**
 * Find and copy the token's logon session SID (S-1-5-5-x-y, attribute
 * SE_GROUP_LOGON_ID). The restricted token needs it for the per-logon objects
 * a console child touches.
 */
export function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, TokenGroups, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups size query');
  }
  if (needed < TOKEN_GROUPS_OFFSET) {
    throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenGroups size ${needed}`);
  }
  const groups = Buffer.alloc(needed);
  if (api.getTokenInformation(token, TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups');
  }
  const groupCount = groups.readUInt32LE(0);
  for (let index = 0; index < groupCount; index += 1) {
    const base = TOKEN_GROUPS_OFFSET + index * SID_AND_ATTRIBUTES_SIZE;
    const sidPtr = decodePtrAt(groups, base);
    const attributes = groups.readUInt32LE(base + 8);
    // >>> 0: JS bitwise & is signed 32-bit and SE_GROUP_LOGON_ID has bit 31 set.
    const isLogonId = ((attributes & SE_GROUP_LOGON_ID) >>> 0) === (SE_GROUP_LOGON_ID >>> 0);
    if (sidPtr === null || !isLogonId) {
      continue;
    }
    const sidLength = api.getLengthSid(sidPtr);
    if (sidLength === 0) {
      throwLastError(api, 'GetLengthSid', `logon SID group ${index}`);
    }
    const copy = allocBytes(sidLength);
    if (api.copySid(sidLength, copy, sidPtr) === 0) {
      throwLastError(api, 'CopySid', `logon SID group ${index}`);
    }
    return copy;
  }
  throw new Error(`no logon SID found among ${groupCount} token groups`);
}

/**
 * Merge one full-access allow ACE for `sidPtr` into the token's DEFAULT DACL,
 * the DACL every new object the token holder creates takes. Without it the
 * child's own anonymous pipes fail the second access check at creation.
 */
export function setTokenDefaultDaclGrant(api: Win32Bindings, token: NativePtr, sidPtr: NativePtr): void {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, TokenDefaultDacl, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl size query');
  }
  const buffer = Buffer.alloc(needed);
  if (api.getTokenInformation(token, TokenDefaultDacl, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl');
  }
  const currentDacl = decodePtrAt(buffer, 0);
  if (currentDacl === null) {
    throw new Error('the process token carries no default DACL to extend');
  }
  const newDaclSlot = allocPtrSlot();
  const result = api.setEntriesInAclW(
    1,
    buildExplicitAccess(sidPtr, GRANT_ACCESS, FILE_ALL_ACCESS),
    currentDacl,
    newDaclSlot,
  );
  if (result !== ERROR_SUCCESS) {
    throwWin32(api, 'SetEntriesInAclW', result, 'default DACL merge');
  }
  const newDacl = decodePtr(newDaclSlot);
  if (newDacl === null) {
    throwWin32(api, 'SetEntriesInAclW', result, 'null merged default DACL');
  }
  // TOKEN_DEFAULT_DACL { PACL DefaultDacl; } is exactly the pointer.
  const info = Buffer.alloc(8);
  info.writeBigUInt64LE(newDacl, 0);
  if (api.setTokenInformation(token, TokenDefaultDacl, info, info.length) === 0) {
    const code = api.getLastError();
    api.localFree(newDacl);
    throwWin32(api, 'SetTokenInformation', code, 'TokenDefaultDacl');
  }
  api.localFree(newDacl);
}

/**
 * Lower a token's integrity level to Low (S-1-16-4096).
 *
 * The command sandbox deliberately does NOT call this. Writing the matching
 * Low label on a directory is a SACL write: permitted inside the operator's
 * own temp tree on this host but refused under the project tree, so the same
 * command would run at two different integrity levels depending on where the
 * workspace happens to live — and a Low child under the restricted token is
 * the configuration in which `pwsh` dies at load with STATUS_DLL_INIT_FAILED
 * (0xC0000142). It stays here as the ported primitive, for a host where the
 * label can be written everywhere and the shell tolerates the lower level.
 */
export function restrictTokenIntegrity(api: Win32Bindings, token: NativePtr, lowLabelSidPtr: NativePtr): void {
  const sidLength = api.getLengthSid(lowLabelSidPtr);
  if (sidLength === 0) {
    throwLastError(api, 'GetLengthSid', 'Low integrity label SID');
  }
  const info = Buffer.alloc(TOKEN_MANDATORY_LABEL_SIZE + sidLength);
  info.writeBigUInt64LE(ptrAddress(lowLabelSidPtr), 0);
  info.writeUInt32LE(SE_GROUP_INTEGRITY, 8);
  if (api.setTokenInformation(token, TokenIntegrityLevel, info, info.length) === 0) {
    throwLastError(api, 'SetTokenInformation', 'TokenIntegrityLevel (Low)');
  }
}

/** Pack `SID_AND_ATTRIBUTES[count]` (16-byte stride; Attributes stay 0). */
function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(SID_AND_ATTRIBUTES_SIZE * sids.length);
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), SID_AND_ATTRIBUTES_SIZE * index);
  });
  return buffer;
}

/**
 * Create the restricted token with the given restricting SID list and flags.
 * The list must contain at least one SID; an empty list is a programming error
 * (it would deny the child everything, including its own shell).
 */
export function createRestrictedToken(
  api: Win32Bindings,
  currentToken: NativePtr,
  restrictingSids: readonly NativePtr[],
  flags: number = DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
): NativePtr {
  if (restrictingSids.length === 0) {
    throw new Error('createRestrictedToken: the restricting SID list must not be empty');
  }
  const sidBlock = buildRestrictingSids(restrictingSids);
  const tokenSlot = allocPtrSlot();
  const created = api.createRestrictedToken(
    currentToken,
    flags,
    0,
    null,
    0,
    null,
    restrictingSids.length,
    sidBlock,
    tokenSlot,
  );
  if (created === 0) {
    throwLastError(api, 'CreateRestrictedToken', `restricting SIDs: ${restrictingSids.length}`);
  }
  const token = decodePtr(tokenSlot);
  if (token === null) {
    throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle');
  }
  return token;
}
