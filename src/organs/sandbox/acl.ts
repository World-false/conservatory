/**
 * Directory-ACL editing for the Windows command sandbox.
 *
 * The confined child runs under a restricted token: every access it makes must
 * be granted twice, once by the ordinary token SIDs and once by the token's
 * restricting SIDs. The sandbox's capability SID is one of those restricting
 * SIDs, so an ACE naming it is the only lever that can single out the child
 * while leaving the supervisor (which never carries that SID) untouched:
 *
 *  - an ALLOW ACE for the capability SID on a directory makes that directory
 *    reachable for the child (this is how the notebook becomes writable);
 *  - a DENY ACE for the capability SID makes it unreachable, and because deny
 *    entries are evaluated first an inheritable deny hides a whole subtree —
 *    that is what makes `SUPERVISOR/` and another agent's home invisible.
 *
 * Every Win32 call is checked. Any failure throws with the API name, the exact
 * Win32 code and the affected path; nothing half-applied is left behind
 * silently. Edits are read-merge-write against the directory's current DACL,
 * so pre-existing explicit entries survive, and each edit is skipped when the
 * exact ACE is already present (the cheap idempotent path repeated commands
 * take).
 */

import {
  ACCESS_ALLOWED_ACE_TYPE,
  ACCESS_DENIED_ACE_TYPE,
  ACL_HEADER_SIZE,
  ACL_REVISION,
  CONTAINER_INHERIT_ACE,
  DACL_SECURITY_INFORMATION,
  DENY_ACCESS,
  ERROR_SUCCESS,
  EXPLICIT_ACCESS_W_SIZE,
  GRANT_ACCESS,
  LABEL_SECURITY_INFORMATION,
  LPTR,
  MANDATORY_ACE_OVERHEAD,
  NO_MULTIPLE_TRUSTEE,
  REVOKE_ACCESS,
  SE_FILE_OBJECT,
  SUB_CONTAINERS_AND_OBJECTS_INHERIT,
  SYSTEM_MANDATORY_LABEL_ACE_TYPE,
  SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
  TRUSTEE_IS_SID,
  TRUSTEE_IS_UNKNOWN,
  allocPtrSlot,
  decodePtr,
  decodeUint8At,
  decodeUint16At,
  decodeUint32At,
  isNullPtr,
  ptrAddress,
  sameSidAt,
  throwLastError,
  throwWin32,
} from './win32';
import type { NativePtr, Win32Bindings } from './win32';

/** Generic read access (WinNT.h FILE_GENERIC_READ). */
const FILE_GENERIC_READ = 0x00120089;
/** Generic write access (WinNT.h FILE_GENERIC_WRITE). */
const FILE_GENERIC_WRITE = 0x00120116;
/** Generic execute access (WinNT.h FILE_GENERIC_EXECUTE). */
const FILE_GENERIC_EXECUTE = 0x001200a0;
/** Delete the object itself. */
const DELETE = 0x00010000;
/** Delete a child of a directory. */
const FILE_DELETE_CHILD = 0x00000040;
/** Rewrite the object's DACL. */
const WRITE_DAC = 0x00040000;
/** Take ownership of the object. */
const WRITE_OWNER = 0x00080000;
/** Read the object's security descriptor. */
const READ_CONTROL = 0x00020000;

/**
 * The access the capability SID receives on an allowed directory: read, write,
 * execute and delete, everything but WRITE_DAC and WRITE_OWNER. Those two stay
 * out so a confined child can never rewrite an ACL or take ownership to widen
 * its own allowlist.
 */
export const CAPABILITY_ACCESS =
  (FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD) &
  ~(WRITE_DAC | WRITE_OWNER);

/** Everything a confined child may do to a protected path: none of it. */
export const FULL_DENY_ACCESS = CAPABILITY_ACCESS;

/** Read and execute, without write, for a directory that stays read-only. */
export const READ_ONLY_ACCESS = (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE) & ~WRITE_DAC;

/**
 * The write-class rights denied on a file that must stay read-only (`MEMORY`):
 * write data, append, extended attributes, write attributes, delete, rewrite
 * the DACL, take ownership. Nothing a read handle asks for is in this mask —
 * READ_CONTROL and SYNCHRONIZE especially are absent, because denying either
 * refuses the open itself rather than the write.
 */
export const WRITE_DENY_ACCESS =
  0x00000002 | 0x00000004 | 0x00000010 | 0x00000100 | DELETE | WRITE_DAC | WRITE_OWNER;

/** Pack one non-inherited deny entry (a single file, not a subtree). */
export const NO_INHERITANCE = 0;

/** One ACL entry to merge into a path's DACL. */
export interface AceEdit {
  /** Trustee SID. */
  sid: NativePtr;
  /** GRANT_ACCESS, DENY_ACCESS or REVOKE_ACCESS. */
  mode: number;
  /** Access mask to grant or deny; ignored by REVOKE_ACCESS. */
  mask: number;
  /** ACE inheritance flags; defaults to subcontainers and objects. */
  inheritance?: number;
}

/** Optional Low mandatory label applied together with a DACL edit. */
export interface AclEditOptions {
  /**
   * When given, the Low integrity label naming this SID is applied in the same
   * SetNamedSecurityInfoW call. Only meaningful when the confined token was
   * actually lowered to Low integrity.
   */
  lowLabelSid?: NativePtr;
}

/**
 * Pack one EXPLICIT_ACCESS_W (48 bytes on x64): permissions@0, mode@4,
 * inheritance@8, Trustee@16 { pMultipleTrustee, MultipleTrusteeOperation@24,
 * TrusteeForm@28, TrusteeType@32, ptstrName@40 }.
 */
export function buildExplicitAccess(
  sidPtr: NativePtr,
  mode: number,
  permissions: number,
  inheritance: number = SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): Buffer {
  const entry = Buffer.alloc(EXPLICIT_ACCESS_W_SIZE);
  entry.writeUInt32LE(permissions, 0);
  entry.writeUInt32LE(mode, 4);
  entry.writeUInt32LE(inheritance, 8);
  entry.writeUInt32LE(NO_MULTIPLE_TRUSTEE, 24);
  entry.writeUInt32LE(TRUSTEE_IS_SID, 28);
  entry.writeUInt32LE(TRUSTEE_IS_UNKNOWN, 32);
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40);
  return entry;
}

interface CurrentSecurity {
  /** The directory's explicit DACL, or null when it carries none. */
  dacl: NativePtr | null;
  /** The directory's mandatory-label ACL, or null when it carries none. */
  label: NativePtr | null;
  /** The security descriptor allocation that owns both ACL pointers. */
  descriptor: NativePtr | null;
}

/**
 * Read a path's DACL and mandatory label. The returned ACL pointers live
 * inside the descriptor allocation: only the descriptor may be freed, and not
 * before SetEntriesInAclW has consumed the DACL.
 */
function readCurrentSecurity(api: Win32Bindings, path: string): CurrentSecurity {
  const ownerSlot = allocPtrSlot();
  const groupSlot = allocPtrSlot();
  const daclSlot = allocPtrSlot();
  const saclSlot = allocPtrSlot();
  const descriptorSlot = allocPtrSlot();
  const result = api.getNamedSecurityInfoW(
    path,
    SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
    ownerSlot,
    groupSlot,
    daclSlot,
    saclSlot,
    descriptorSlot,
  );
  if (result !== ERROR_SUCCESS) {
    throwWin32(api, 'GetNamedSecurityInfoW', result, path);
  }
  return { dacl: decodePtr(daclSlot), label: decodePtr(saclSlot), descriptor: decodePtr(descriptorSlot) };
}

/**
 * Build the Low mandatory label that accompanies a write grant: one
 * SYSTEM_MANDATORY_LABEL_ACE naming the Low integrity SID with the
 * no-write-up policy, inheriting to subcontainers and objects. The caller
 * frees the returned ACL with LocalFree once SetNamedSecurityInfoW has copied
 * it.
 */
export function buildLowLabelAcl(api: Win32Bindings, lowLabelSidPtr: NativePtr): NativePtr {
  const sidLength = api.getLengthSid(lowLabelSidPtr);
  if (sidLength === 0) throwLastError(api, 'GetLengthSid', 'Low mandatory label SID');
  const aclLength = ACL_HEADER_SIZE + MANDATORY_ACE_OVERHEAD + sidLength;
  const acl = api.localAlloc(LPTR, aclLength);
  if (isNullPtr(acl)) throwLastError(api, 'LocalAlloc', 'Low mandatory label ACL');
  if (api.initializeAcl(acl, aclLength, ACL_REVISION) === 0) {
    const code = api.getLastError();
    api.localFree(acl);
    throwWin32(api, 'InitializeAcl', code, 'Low mandatory label ACL');
  }
  if (
    api.addMandatoryAce(
      acl,
      ACL_REVISION,
      SUB_CONTAINERS_AND_OBJECTS_INHERIT,
      SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
      lowLabelSidPtr,
    ) === 0
  ) {
    const code = api.getLastError();
    api.localFree(acl);
    throwWin32(api, 'AddMandatoryAce', code, 'Low mandatory label ACL');
  }
  return acl;
}

/**
 * True when an ACL already carries the exact entry `(aceType, inheritance,
 * mask, trustee SID)`. Allowed and denied ACEs share the Mask@4/SID@8 layout;
 * the ACE's SID is inline, so it is compared field-by-field through bounded
 * offset reads. A malformed header reads as "not present" so the caller falls
 * back to the merge path, which owns the robust failure handling.
 */
export function hasExactEntry(
  acl: NativePtr,
  aceType: number,
  inheritance: number,
  mask: number,
  sidPtr: NativePtr,
): boolean {
  const aclSize = decodeUint16At(acl, 2);
  const aceCount = decodeUint16At(acl, 4);
  if (aclSize < ACL_HEADER_SIZE || aclSize > 1_048_576) {
    return false;
  }
  let offset = ACL_HEADER_SIZE;
  for (let index = 0; index < aceCount; index += 1) {
    const aceSize = decodeUint16At(acl, offset + 2);
    if (aceSize < 8 || offset + aceSize > aclSize) {
      return false;
    }
    const exact =
      decodeUint8At(acl, offset) === aceType &&
      decodeUint8At(acl, offset + 1) === inheritance &&
      decodeUint32At(acl, offset + 4) === mask;
    if (exact && sameSidAt(acl, offset + 8, sidPtr, 0)) {
      return true;
    }
    offset += aceSize;
  }
  return false;
}

/** True when an ACL already carries any entry naming this trustee. */
function hasAnyEntry(acl: NativePtr, sidPtr: NativePtr): boolean {
  return listEntriesForSid(acl, sidPtr).length > 0;
}

/** One ACE naming a trustee, as the sandbox reads it back. */
interface TrusteeEntry {
  aceType: number;
  inheritance: number;
  mask: number;
}

/**
 * Every ACE naming one trustee, read field by field through bounded offset
 * reads. The ACE's SID is inline, so there is no pointer to follow.
 */
function listEntriesForSid(acl: NativePtr, sidPtr: NativePtr): TrusteeEntry[] {
  const out: TrusteeEntry[] = [];
  const aclSize = decodeUint16At(acl, 2);
  const aceCount = decodeUint16At(acl, 4);
  if (aclSize < ACL_HEADER_SIZE || aclSize > 1_048_576) {
    return out;
  }
  let offset = ACL_HEADER_SIZE;
  for (let index = 0; index < aceCount; index += 1) {
    const aceSize = decodeUint16At(acl, offset + 2);
    if (aceSize < 8 || offset + aceSize > aclSize) {
      return out;
    }
    if (sameSidAt(acl, offset + 8, sidPtr, 0)) {
      out.push({
        aceType: decodeUint8At(acl, offset),
        inheritance: decodeUint8At(acl, offset + 1),
        mask: decodeUint32At(acl, offset + 4),
      });
    }
    offset += aceSize;
  }
  return out;
}

/**
 * Build the merge for one edit against the current DACL. An edit whose exact
 * ACE already stands contributes nothing; an edit whose trustee carries a
 * *different* ACE (an older mask, a stale grant) contributes a REVOKE followed
 * by the wanted entry, so a directory converges on the wanted ACEs instead of
 * accumulating history. Entry order is preserved by SetEntriesInAclW, so the
 * revoke lands before the entry that replaces it.
 */
function planEntry(existing: readonly TrusteeEntry[], edit: AceEdit): Buffer | null {
  const inheritance = edit.inheritance ?? SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  if (edit.mode === REVOKE_ACCESS) {
    return buildExplicitAccess(edit.sid, REVOKE_ACCESS, 0, inheritance);
  }
  const aceType = edit.mode === DENY_ACCESS ? ACCESS_DENIED_ACE_TYPE : ACCESS_ALLOWED_ACE_TYPE;
  const exact =
    existing.length === 1 &&
    existing[0].aceType === aceType &&
    existing[0].inheritance === inheritance &&
    existing[0].mask === edit.mask;
  if (exact) {
    return null;
  }
  const wanted = buildExplicitAccess(edit.sid, edit.mode, edit.mask, inheritance);
  if (existing.length === 0) {
    return wanted;
  }
  return Buffer.concat([buildExplicitAccess(edit.sid, REVOKE_ACCESS, 0, inheritance), wanted]);
}

/** True when every edit already stands exactly as asked and nothing else names its trustee. */
function isFullyApplied(dacl: NativePtr | null, edits: readonly AceEdit[]): boolean {
  if (dacl === null || edits.some((edit) => edit.mode === REVOKE_ACCESS)) {
    return false;
  }
  return edits.every((edit) => planEntry(listEntriesForSid(dacl, edit.sid), edit) === null);
}

/** True when the label ACL already carries the exact Low no-write-up label. */
function hasExactLowLabel(labelAcl: NativePtr, lowLabelSidPtr: NativePtr): boolean {
  return hasExactEntry(
    labelAcl,
    SYSTEM_MANDATORY_LABEL_ACE_TYPE,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
    lowLabelSidPtr,
  );
}

/** The mandatory-label half of one merge. Labels are applied or left alone; a
 * label is never cleared, because clearing a SACL needs a privilege this
 * process does not hold and a leftover Low label is harmless. */
type LabelEdit = { kind: 'apply'; acl: NativePtr } | { kind: 'keep' };

/**
 * Merge `edits` into the path's DACL and apply the label change in one
 * SetNamedSecurityInfoW call, then free every allocation this call owns. The
 * entry count derives from the packed buffer, so one merge can carry a grant,
 * a deny and a revoke at once.
 */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entries: Buffer,
  oldDacl: NativePtr | null,
  labelEdit: LabelEdit,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot();
  const mergeResult = api.setEntriesInAclW(
    entries.length / EXPLICIT_ACCESS_W_SIZE,
    entries,
    oldDacl,
    newAclSlot,
  );
  if (mergeResult !== ERROR_SUCCESS) {
    if (descriptor !== null) {
      api.localFree(descriptor);
    }
    if (labelEdit.kind === 'apply') {
      api.localFree(labelEdit.acl);
    }
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`);
  }
  const newAcl = decodePtr(newAclSlot);
  if (newAcl === null) {
    if (descriptor !== null) {
      api.localFree(descriptor);
    }
    if (labelEdit.kind === 'apply') {
      api.localFree(labelEdit.acl);
    }
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null merged DACL`);
  }

  // The descriptor (and the old DACL inside it) is dead after the merge.
  const freedDescriptor = descriptor === null ? null : api.localFree(descriptor);
  const applyResult = api.setNamedSecurityInfoW(
    path,
    SE_FILE_OBJECT,
    labelEdit.kind === 'keep'
      ? DACL_SECURITY_INFORMATION
      : DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
    null,
    null,
    newAcl,
    labelEdit.kind === 'apply' ? labelEdit.acl : null,
  );
  const freedNewAcl = api.localFree(newAcl);
  const freedLabel = labelEdit.kind === 'apply' ? api.localFree(labelEdit.acl) : null;
  if (applyResult !== ERROR_SUCCESS) {
    throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`);
  }
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) {
    throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`);
  }
  if (!isNullPtr(freedNewAcl)) {
    throwLastError(api, 'LocalFree', `${label}(${path}) DACL`);
  }
  if (freedLabel !== null && !isNullPtr(freedLabel)) {
    throwLastError(api, 'LocalFree', `${label}(${path}) label ACL`);
  }
}

/**
 * Rewrite one path's DACL with a set of ACE edits, optionally applying the Low
 * integrity label in the same call. Idempotent for grant/deny edits: when every
 * requested ACE (and the label, when one is requested) already stands exactly
 * as asked, the call is a no-op apart from releasing the descriptor it read.
 *
 * REVOKE_ACCESS removes every entry naming that trustee; a revoke request is
 * never skipped as redundant because the caller may be removing an entry whose
 * mask it does not know.
 */
export function applyAclEdits(
  api: Win32Bindings,
  path: string,
  edits: readonly AceEdit[],
  options: AclEditOptions = {},
): void {
  if (edits.length === 0) {
    return;
  }
  const { dacl, label, descriptor } = readCurrentSecurity(api, path);
  const labelWanted = options.lowLabelSid !== undefined;
  const alreadyApplied =
    isFullyApplied(dacl, edits) &&
    (!labelWanted || (label !== null && hasExactLowLabel(label, options.lowLabelSid as NativePtr)));

  if (alreadyApplied) {
    if (descriptor !== null) {
      const freed = api.localFree(descriptor);
      if (!isNullPtr(freed)) {
        throwLastError(api, 'LocalFree', `applyAclEdits(${path}) descriptor`);
      }
    }
    return;
  }

  let labelEdit: LabelEdit = { kind: 'keep' };
  if (labelWanted) {
    try {
      labelEdit = { kind: 'apply', acl: buildLowLabelAcl(api, options.lowLabelSid as NativePtr) };
    } catch (error) {
      if (descriptor !== null) {
        api.localFree(descriptor);
      }
      throw error;
    }
  }

  const planned: Buffer[] = [];
  for (const edit of edits) {
    const entry = planEntry(dacl === null ? [] : listEntriesForSid(dacl, edit.sid), edit);
    if (entry !== null) {
      planned.push(entry);
    }
  }
  // A requested label always goes through the call even when the DACL is
  // already correct: whether the label can be written is exactly what the
  // caller must find out, and a silent success here would lower the confined
  // token to Low against a directory that never got the matching label.
  if (planned.length === 0 && labelEdit.kind !== 'apply') {
    if (descriptor !== null) {
      api.localFree(descriptor);
    }
    return;
  }
  mergeAndApply(api, path, Buffer.concat(planned), dacl, labelEdit, descriptor, 'applyAclEdits');
}

/**
 * Grant the capability SID full access on a writable directory, deny the world
 * SID the ambient FILE_DELETE_CHILD right (so a sibling directory's inherited
 * delete right cannot be used to remove files inside this one) and apply the
 * Low mandatory label when one is supplied — one merge.
 */
export function grantCapability(
  api: Win32Bindings,
  path: string,
  capabilitySid: NativePtr,
  worldSid: NativePtr,
  lowLabelSid?: NativePtr,
): void {
  applyAclEdits(
    api,
    path,
    [
      {
        sid: worldSid,
        mode: DENY_ACCESS,
        mask: FILE_DELETE_CHILD,
        inheritance: CONTAINER_INHERIT_ACE,
      },
      { sid: capabilitySid, mode: GRANT_ACCESS, mask: CAPABILITY_ACCESS },
    ],
    lowLabelSid === undefined ? {} : { lowLabelSid },
  );
}

/** Deny the capability SID every right on a path; the whole subtree when inheriting. */
export function denyCapability(
  api: Win32Bindings,
  path: string,
  capabilitySid: NativePtr,
  mask: number = FULL_DENY_ACCESS,
  inheritance: number = SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): void {
  applyAclEdits(api, path, [{ sid: capabilitySid, mode: DENY_ACCESS, mask, inheritance }]);
}

/**
 * Grant the capability SID read and execute on a directory it may look at but
 * never change — the agent's own home, whose `MEMORY` it reads, and every
 * directory the operator whitelisted for reading. The grant inherits to
 * children so files inside are covered.
 */
export function grantReadOnly(
  api: Win32Bindings,
  path: string,
  capabilitySid: NativePtr,
  worldSid: NativePtr,
): void {
  applyAclEdits(api, path, [
    { sid: worldSid, mode: DENY_ACCESS, mask: FILE_DELETE_CHILD, inheritance: CONTAINER_INHERIT_ACE },
    { sid: capabilitySid, mode: GRANT_ACCESS, mask: READ_ONLY_ACCESS },
  ]);
}

/** Remove every entry naming the trustee from a path's DACL. */
export function revokeTrustee(api: Win32Bindings, path: string, sid: NativePtr): void {
  applyAclEdits(api, path, [{ sid, mode: REVOKE_ACCESS, mask: 0 }]);
}

/** True when the path's DACL already names the trustee at all. */
export function pathMentionsTrustee(api: Win32Bindings, path: string, sid: NativePtr): boolean {
  const { dacl, descriptor } = readCurrentSecurity(api, path);
  const present = dacl !== null && hasAnyEntry(dacl, sid);
  if (descriptor !== null) {
    api.localFree(descriptor);
  }
  return present;
}
