/**
 * Merged Win32 FFI binding layer for the sandbox organ.
 *
 * Ported from `@deepseek-ai/dsh-win32-process` (abi.ts / errors.ts / ffi.ts) and
 * `@deepseek-ai/dsh-sandbox-windows-acl` (win32-abi.ts / ffi.ts) into a single
 * module. Koffi is imported directly; every native library, struct layout, and
 * function prototype is materialised on first use, so importing this module
 * does not load a Win32 library or bind a single native function.
 */

import type koffiModule from 'koffi' with { 'resolution-mode': 'import' };

/**
 * Koffi's CommonJS entry, loaded once at module scope.
 * `import koffi = require('koffi')` and a plain default import are both rejected
 * by TypeScript under `module: node16` because koffi's published `index.d.ts`
 * lives in a `"type": "module"` package; the runtime entry (`index.cjs`) is
 * still CommonJS, so it is required and typed through the declaration's default
 * export.
 */
const koffi: typeof koffiModule = require('koffi') as typeof koffiModule;

/* -------------------------------------------------------------------------- */
/* Generic process, stdio, and Job Object constants (verified on x64)          */
/* -------------------------------------------------------------------------- */

/** STARTUPINFOW uses the standard input, output, and error handles. */
export const STARTF_USESTDHANDLES = 0x00000100;
/** STARTUPINFOW applies wShowWindow when creating a console window. */
export const STARTF_USESHOWWINDOW = 0x00000001;
/** Initial window visibility that preserves the child's console attachment. */
export const SW_HIDE = 0;
/** HandleInformation flag that permits child inheritance. */
export const HANDLE_FLAG_INHERIT = 0x1;
/** Infinite WaitForSingleObject timeout. */
export const INFINITE = 0xffffffff;
/** WaitForSingleObject returned because a zero-time probe is not signalled. */
export const WAIT_TIMEOUT = 258;
/** CreateProcess flag that prevents user code from running before resume. */
export const CREATE_SUSPENDED = 0x4;
/** CreateProcess flag selecting a UTF-16 environment block. */
export const CREATE_UNICODE_ENVIRONMENT = 0x400;
/** GetStdHandle selector for standard input. */
export const STD_INPUT_HANDLE = -10;
/** GetStdHandle selector for standard output. */
export const STD_OUTPUT_HANDLE = -11;
/** GetStdHandle selector for standard error. */
export const STD_ERROR_HANDLE = -12;
/** FormatMessage reads the operating system message table. */
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
/** FormatMessage leaves insertion placeholders uninterpreted. */
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;
/** Win32 code reporting a caller-provided buffer is too small. */
export const ERROR_INSUFFICIENT_BUFFER = 122;
/** Win32 code reporting that the other pipe end closed. */
export const ERROR_BROKEN_PIPE = 109;
/** Win32 code reporting that a pipe has no remaining data. */
export const ERROR_NO_DATA = 232;
/** Job limit that terminates every member when the final Job handle closes. */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
/** QueryInformationJobObject class for basic accounting and active-process count. */
export const JobObjectBasicAccountingInformation = 1;
/** SetInformationJobObject class for JOBOBJECT_EXTENDED_LIMIT_INFORMATION. */
export const JobObjectExtendedLimitInformation = 9;
/** x64 JOBOBJECT_BASIC_ACCOUNTING_INFORMATION byte size. */
export const JOBOBJECT_BASIC_ACCOUNTING_SIZE = 48;
/** Byte offset of ActiveProcesses in JOBOBJECT_BASIC_ACCOUNTING_INFORMATION. */
export const JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET = 40;
/** x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION byte size. */
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144;
/** Byte offset of BasicLimitInformation.LimitFlags in the extended Job record. */
export const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16;
/** x64 STARTUPINFOW byte size verified by the native probe. */
export const STARTUPINFOW_SIZE = 104;
/** x64 PROCESS_INFORMATION byte size verified by the native probe. */
export const PROCESS_INFORMATION_SIZE = 24;

/* -------------------------------------------------------------------------- */
/* ACL/token/security constants                                                */
/* -------------------------------------------------------------------------- */

/** OpenProcess access required to query the current process token. */
export const PROCESS_QUERY_INFORMATION = 0x0400;
/** Token right required by CreateProcessAsUserW. */
export const TOKEN_ASSIGN_PRIMARY = 0x0001;
/** Token right required by DuplicateTokenEx. */
export const TOKEN_DUPLICATE = 0x0002;
/** Token right required to read token information. */
export const TOKEN_QUERY = 0x0008;
/** Token right required to replace the token default DACL. */
export const TOKEN_ADJUST_DEFAULT = 0x0080;
/** Group attribute identifying the token logon SID. */
export const SE_GROUP_LOGON_ID = 0xc0000000;
/** Standard-rights portion excluded from the write capability grant. */
export const STANDARD_RIGHTS_WRITE = 0x00020000;
/** Generic file write access bits. */
export const FILE_GENERIC_WRITE = 0x00120116;
/** Delete or rename an object. */
export const DELETE = 0x00010000;
/** Delete or rename a directory child. */
export const FILE_DELETE_CHILD = 0x0040;
/**
 * Capability-SID access mask granting write, delete, and child deletion.
 * WRITE_DAC and WRITE_OWNER stay excluded so a confined child cannot rewrite
 * DACLs or take ownership to escape the allowlist.
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE;
/** Full access used in the restricted token default DACL. */
export const FILE_ALL_ACCESS = 0x1f01ff;
/** CreateRestrictedToken flag that disables maximum privileges. */
export const DISABLE_MAX_PRIVILEGE = 0x1;
/** CreateRestrictedToken limited-user flag. */
export const LUA_TOKEN = 0x4;
/** Restrict write access to the listed restricting SIDs. */
export const WRITE_RESTRICTED = 0x8;
/** WELL_KNOWN_SID_TYPE value for Everyone. */
export const WinWorldSid = 1;
/** TOKEN_INFORMATION_CLASS value for token groups. */
export const TokenGroups = 2;
/** TOKEN_INFORMATION_CLASS value for the token default DACL. */
export const TokenDefaultDacl = 6;
/** SECURITY_INFORMATION flag selecting the DACL. */
export const DACL_SECURITY_INFORMATION = 0x00000004;
/** SECURITY_INFORMATION flag selecting the mandatory integrity label. */
export const LABEL_SECURITY_INFORMATION = 0x00000010;
/** ACE type carrying a mandatory integrity label. */
export const SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11;
/**
 * Mandatory policy denying write-class access to higher-integrity objects.
 * The kernel applies it inside the access check, so it also covers writes and
 * deletes granted through a parent directory's FILE_DELETE_CHILD right —
 * the path the write-restricted pass-2 intersection does not reach.
 */
export const SYSTEM_MANDATORY_LABEL_NO_WRITE_UP = 0x00000001;
/** TOKEN_INFORMATION_CLASS value for the token's integrity level. */
export const TokenIntegrityLevel = 25;
/** Group attribute marking the integrity SID of a TOKEN_MANDATORY_LABEL. */
export const SE_GROUP_INTEGRITY = 0x00000020;
/** WELL_KNOWN_SID_TYPE value for the Low mandatory level (S-1-16-4096). */
export const WinLowLabelSid = 66;
/** x64 TOKEN_MANDATORY_LABEL byte size (the SID is referenced, not embedded). */
export const TOKEN_MANDATORY_LABEL_SIZE = 16;
/** x64 ACL header byte size (AclRevision, Sbz1, AclSize, AceCount, Sbz2). */
export const ACL_HEADER_SIZE = 8;
/** Bytes a SYSTEM_MANDATORY_LABEL_ACE occupies beyond the ACL header and its SID. */
export const MANDATORY_ACE_OVERHEAD = 8;
/** ACL revision accepted by InitializeAcl and AddMandatoryAce. */
export const ACL_REVISION = 2;
/** LocalAlloc flag selecting zero-initialized fixed memory (LMEM_FIXED | LMEM_ZEROINIT). */
export const LPTR = 0x0040;
/** SE_OBJECT_TYPE value for filesystem objects. */
export const SE_FILE_OBJECT = 1;
/** TRUSTEE_TYPE value used when trustee classification is unknown. */
export const TRUSTEE_IS_UNKNOWN = 0;
/** TRUSTEE_FORM value indicating a SID pointer. */
export const TRUSTEE_IS_SID = 0;
/** Trustee record has no chained trustee. */
export const NO_MULTIPLE_TRUSTEE = 0;
/** EXPLICIT_ACCESS mode that grants access. */
export const GRANT_ACCESS = 1;
/** EXPLICIT_ACCESS mode that denies access. */
export const DENY_ACCESS = 3;
/** EXPLICIT_ACCESS mode that revokes access. */
export const REVOKE_ACCESS = 4;
/** ACE inheritance flags for child containers and objects. */
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
/** ACE inheritance flag for child containers only (directories; files do not inherit). */
export const CONTAINER_INHERIT_ACE = 0x2;
/** Legacy Win32 maximum path character count used by GetTempPathW. */
export const MAX_PATH = 260;
/** Successful Win32 status code. */
export const ERROR_SUCCESS = 0;
/** Win32 error reported when an immediate byte-range lock cannot be obtained. */
export const ERROR_LOCK_VIOLATION = 33;
/** Generic read access bit. */
export const GENERIC_READ = 0x80000000;
/** Generic write access bit. */
export const GENERIC_WRITE = 0x40000000;
/** CreateFile share-read flag. */
export const FILE_SHARE_READ = 0x00000001;
/** CreateFile share-write flag. */
export const FILE_SHARE_WRITE = 0x00000002;
/** CreateFile share-delete flag. */
export const FILE_SHARE_DELETE = 0x00000004;
/** CreateFile disposition that opens or creates the file. */
export const OPEN_ALWAYS = 4;
/** LockFileEx exclusive-lock flag. */
export const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
/** LockFileEx immediate-failure flag. */
export const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
/** ACE type for an allowed-access entry. */
export const ACCESS_ALLOWED_ACE_TYPE = 0;
/** ACE type for a denied-access entry (shares the allowed ACE's Mask/SID layout). */
export const ACCESS_DENIED_ACE_TYPE = 1;
/** Maximum SID sub-authority count. */
export const SID_MAX_SUB_AUTHORITIES = 15;
/** ACE flag marking inherited entries. */
export const INHERITED_ACE = 0x10;
/** Maximum SID allocation size in bytes. */
export const SECURITY_MAX_SID_SIZE = 68;
/** x64 SID_AND_ATTRIBUTES byte size. */
export const SID_AND_ATTRIBUTES_SIZE = 16;
/** x64 TOKEN_GROUPS offset of the first group entry. */
export const TOKEN_GROUPS_OFFSET = 8;
/** x64 EXPLICIT_ACCESS_W byte size. */
export const EXPLICIT_ACCESS_W_SIZE = 48;
/** x64 offset of TRUSTEE_W inside EXPLICIT_ACCESS_W. */
export const TRUSTEE_W_OFFSET = 16;
/** x64 offset of ptstrName inside TRUSTEE_W. */
export const TRUSTEE_W_PTSTRNAME_OFFSET = 24;

/* -------------------------------------------------------------------------- */
/* Additional access masks required by the sandbox caller                      */
/* -------------------------------------------------------------------------- */

/**
 * STANDARD_RIGHTS_READ | FILE_READ_DATA | FILE_READ_ATTRIBUTES | FILE_READ_EA | SYNCHRONIZE.
 * WinNT.h defines FILE_GENERIC_READ with exactly these bits.
 */
export const FILE_GENERIC_READ = 0x00120089;
/**
 * STANDARD_RIGHTS_EXECUTE | FILE_EXECUTE | FILE_READ_ATTRIBUTES | SYNCHRONIZE.
 * WinNT.h defines FILE_GENERIC_EXECUTE with exactly these bits.
 */
export const FILE_GENERIC_EXECUTE = 0x001200a0;
/** Read the security descriptor's owner, group, and DACL (STANDARD_RIGHTS_READ). */
export const READ_CONTROL = 0x00020000;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** Win32 call failure with the exact API name and error code. */
export class Win32Error extends Error {
  /** Win32 function whose checked result failed. */
  readonly api: string;
  /** Exact GetLastError value or direct Win32 API error code. */
  readonly win32Code: number;

  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'Win32Error';
    this.api = api;
    this.win32Code = win32Code;
  }
}

/* -------------------------------------------------------------------------- */
/* Native pointer brand and Koffi types                                        */
/* -------------------------------------------------------------------------- */

declare const nativePtr: unique symbol;
/** Koffi native pointer branded against accidental numeric use. */
export type NativePtr = bigint & { readonly [nativePtr]: true };

/** Koffi runtime export type. */
type Koffi = typeof koffi;
/** A Koffi pointer type object. */
type Ptr = ReturnType<Koffi['pointer']>;
/** A loaded Koffi library handle. */
type LibraryHandle = ReturnType<Koffi['load']>;
/** A Koffi struct type object. */
type StructHandle = ReturnType<Koffi['struct']>;

interface Win32Types {
  PVOID: Ptr;
  PPVOID: Ptr;
  STARTUPINFOW: StructHandle;
  PROCESS_INFORMATION: StructHandle;
}

let cachedTypes: Win32Types | undefined;

/**
 * Resolve Koffi pointer and process layouts on the first native operation.
 * @returns cached Koffi types with the ABI sizes asserted.
 */
function win32Types(): Win32Types {
  if (cachedTypes !== undefined) return cachedTypes;
  const PVOID = koffi.pointer('void');
  const PPVOID = koffi.pointer(PVOID);
  const STARTUPINFOW = koffi.struct('DSH_STARTUPINFOW', {
    cb: 'uint32',
    lpReserved: 'str16',
    lpDesktop: 'str16',
    lpTitle: 'str16',
    dwX: 'uint32',
    dwY: 'uint32',
    dwXSize: 'uint32',
    dwYSize: 'uint32',
    dwXCountChars: 'uint32',
    dwYCountChars: 'uint32',
    dwFillAttribute: 'uint32',
    dwFlags: 'uint32',
    wShowWindow: 'uint16',
    cbReserved2: 'uint16',
    lpReserved2: koffi.pointer('uint8'),
    hStdInput: PVOID,
    hStdOutput: PVOID,
    hStdError: PVOID,
  });
  const PROCESS_INFORMATION = koffi.struct('DSH_PROCESS_INFORMATION', {
    hProcess: PVOID,
    hThread: PVOID,
    dwProcessId: 'uint32',
    dwThreadId: 'uint32',
  });
  if (STARTUPINFOW.size !== STARTUPINFOW_SIZE) {
    throw new Error(
      `STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, expected ${STARTUPINFOW_SIZE}`,
    );
  }
  if (PROCESS_INFORMATION.size !== PROCESS_INFORMATION_SIZE) {
    throw new Error(
      `PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, expected ${PROCESS_INFORMATION_SIZE}`,
    );
  }
  cachedTypes = { PVOID, PPVOID, STARTUPINFOW, PROCESS_INFORMATION };
  return cachedTypes;
}

/* -------------------------------------------------------------------------- */
/* Binding table shape                                                         */
/* -------------------------------------------------------------------------- */

/** STARTUPINFOW fields used by inherited or piped stdio launches. */
export interface StartupInfoInput {
  cb: number;
  dwFlags: number;
  wShowWindow: number;
  hStdInput: NativePtr;
  hStdOutput: NativePtr;
  hStdError: NativePtr;
  cbReserved2?: number;
  lpReserved2?: NativePtr;
}

/** Decoded PROCESS_INFORMATION result. */
export interface ProcessInfoOutput {
  hProcess: NativePtr | null;
  hThread: NativePtr | null;
  dwProcessId: number;
  dwThreadId: number;
}

/** Generic Win32 calls consumed by restricted-token sandbox process operations. */
export interface Win32ProcessBindings {
  closeHandle(handle: NativePtr): number;
  getLastError(): number;
  getFileType(handle: NativePtr): number;
  uvGetOsfhandle(fileDescriptor: number): NativePtr | null;
  formatMessageW(
    flags: number,
    source: null,
    messageId: number,
    languageId: number,
    buffer: Buffer,
    size: number,
    args: null,
  ): number;
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number;
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number;
  createProcessAsUserW(
    token: NativePtr,
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number;
  createProcessW(
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: Buffer | null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number;
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number;
  peekNamedPipe(
    pipe: NativePtr,
    buffer: null,
    size: number,
    bytesRead: NativePtr | null,
    totalAvail: NativePtr,
    leftThisMessage: NativePtr | null,
  ): number;
  waitForSingleObject(handle: NativePtr, milliseconds: number): number;
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number;
  createJobObjectW(attributes: null, name: null): NativePtr;
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number;
  queryInformationJobObject(
    job: NativePtr,
    cls: number,
    information: Buffer,
    length: number,
    returnLength: null,
  ): number;
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number;
  resumeThread(thread: NativePtr): number;
  terminateProcess(process: NativePtr, exitCode: number): number;
  terminateJobObject(job: NativePtr, exitCode: number): number;
  getStdHandle(stdHandle: number): NativePtr;
}

/** ACL/token/security calls composed with the generic Win32 process bindings. */
export interface Win32Bindings extends Win32ProcessBindings {
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr;
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number;
  localAlloc(flags: number, bytes: number): NativePtr;
  localFree(memory: NativePtr): NativePtr;
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number;
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number;
  isValidSid(sid: NativePtr): number;
  getLengthSid(sid: NativePtr): number;
  copySid(length: number, destination: NativePtr, source: NativePtr): number;
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number;
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number;
  createRestrictedToken(
    existing: NativePtr,
    flags: number,
    disableCount: number,
    disableSids: null,
    deletePrivilegeCount: number,
    privilegesToDelete: null,
    restrictCount: number,
    restrictingSids: Buffer,
    newToken: NativePtr,
  ): number;
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number;
  initializeAcl(acl: NativePtr, length: number, revision: number): number;
  addMandatoryAce(acl: NativePtr, revision: number, aceFlags: number, policy: number, sid: NativePtr): number;
  setNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: NativePtr | null,
  ): number;
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr,
  ): number;
  getTempPathW(length: number, buffer: Buffer): number;
  setEnvironmentVariableW(name: string, value: string): number;
  setConsoleCtrlHandler(handler: null, add: number): number;
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    attributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): NativePtr;
  lockFileEx(
    file: NativePtr,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number;
  unlockFileEx(
    file: NativePtr,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number;
}

/* -------------------------------------------------------------------------- */
/* Native memory helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Return whether a Koffi pointer represents NULL.
 * @param value - pointer value returned by Koffi or a Win32 call.
 * @returns true for null, undefined, or address zero.
 */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n;
}

/**
 * Return whether CreateFileW produced INVALID_HANDLE_VALUE.
 * @param handle - handle returned by CreateFileW.
 * @returns true for null, zero, or the all-bits-one sentinel.
 */
export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true;
  return (handle as bigint) === 0xffffffffffffffffn || (handle as bigint) === -1n;
}

/**
 * Allocate a pointer-sized out-parameter slot.
 * @returns allocated native slot.
 */
export function allocPtrSlot(): NativePtr {
  return koffi.alloc(win32Types().PVOID, 1) as NativePtr;
}

/**
 * Allocate a uint32 out-parameter slot.
 * @returns allocated native slot.
 */
export function allocUint32(): NativePtr {
  return koffi.alloc('uint32', 1) as NativePtr;
}

/**
 * Allocate a raw byte block.
 * @param length - byte count.
 * @returns allocated pointer.
 */
export function allocBytes(length: number): NativePtr {
  return koffi.alloc('uint8', length) as NativePtr;
}

/**
 * Allocate one zeroed x64 OVERLAPPED record.
 * @returns allocated pointer.
 * @remarks Koffi 3.1.1 crashes when LockFileEx or UnlockFileEx receives NULL;
 * a zeroed OVERLAPPED is equivalent for the synchronous lock-file handle.
 */
export function allocOverlapped(): NativePtr {
  return allocBytes(32);
}

/**
 * Decode a pointer out-parameter.
 * @param slot - pointer-sized slot filled by Win32.
 * @returns decoded pointer, or null for address zero.
 */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value = koffi.decode(slot, win32Types().PVOID) as NativePtr | null;
  return isNullPtr(value) ? null : value;
}

/**
 * Decode a pointer value from a Buffer field.
 * @param buffer - encoded native record.
 * @param offset - pointer field byte offset.
 * @returns decoded pointer, or null for address zero.
 */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value = koffi.decode(buffer, offset, win32Types().PVOID) as NativePtr | null;
  return isNullPtr(value) ? null : value;
}

/**
 * Decode a uint32 out-parameter.
 * @param slot - uint32 slot filled by Win32.
 * @returns decoded unsigned value.
 */
export function decodeUint32(slot: NativePtr): number {
  return koffi.decode(slot, 'uint32') as number;
}

/**
 * Decode a uint8 field at a native pointer offset.
 * @param ptr - native record pointer.
 * @param offset - field byte offset.
 * @returns decoded value.
 */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint8') as number;
}

/**
 * Decode a uint16 field at a native pointer offset.
 * @param ptr - native record pointer.
 * @param offset - field byte offset.
 * @returns decoded value.
 */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint16') as number;
}

/**
 * Decode a uint32 field at a native pointer offset.
 * @param ptr - native record pointer.
 * @param offset - field byte offset.
 * @returns decoded value.
 */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint32') as number;
}

/**
 * Encode a uint32 into an allocated slot.
 * @param slot - slot allocated by allocUint32.
 * @param value - unsigned value to store.
 */
export function encodeUint32(slot: NativePtr, value: number): void {
  koffi.encode(slot, 'uint32', value);
}

/**
 * Return a Koffi pointer's numeric address for struct packing.
 * @param ptr - native pointer.
 * @returns pointer address.
 */
export function ptrAddress(ptr: NativePtr): bigint {
  return koffi.address(ptr);
}

/**
 * Compare two in-memory SID records without allocating strings.
 * @param left - first native buffer.
 * @param leftOffset - first SID byte offset.
 * @param right - second native buffer.
 * @param rightOffset - second SID byte offset.
 * @returns true when revision, authority, and every sub-authority match.
 */
export function sameSidAt(
  left: NativePtr,
  leftOffset: number,
  right: NativePtr,
  rightOffset: number,
): boolean {
  if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false;
  const leftCount = decodeUint8At(left, leftOffset + 1);
  const rightCount = decodeUint8At(right, rightOffset + 1);
  if (leftCount !== rightCount || leftCount > SID_MAX_SUB_AUTHORITIES) return false;
  for (let index = 0; index < 6; index += 1) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) {
      return false;
    }
  }
  for (let index = 0; index < leftCount; index += 1) {
    if (
      decodeUint32At(left, leftOffset + 8 + index * 4) !==
      decodeUint32At(right, rightOffset + 8 + index * 4)
    ) {
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Error formatting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Format a Win32 error code through FormatMessageW.
 * @param api - active binding table.
 * @param win32Code - captured GetLastError value.
 * @returns trimmed system message, or an empty string when unavailable.
 */
export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024);
  const length = api.formatMessageW(
    FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
    null,
    win32Code,
    0,
    buffer,
    buffer.length / 2,
    null,
  );
  return length === 0 ? '' : buffer.subarray(0, length * 2).toString('utf16le').trim();
}

/**
 * Throw the current GetLastError value.
 * @param api - active binding table.
 * @param name - failing Win32 operation.
 * @param detail - optional operation context.
 * @returns never; always throws Win32Error.
 */
export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError();
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}

/**
 * Throw an explicitly captured Win32 error code.
 * @param api - active binding table.
 * @param name - failing Win32 operation.
 * @param win32Code - error captured before cleanup.
 * @param detail - optional operation context.
 * @returns never; always throws Win32Error.
 */
export function throwWin32(
  api: Win32Bindings,
  name: string,
  win32Code: number,
  detail?: string,
): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}

/* -------------------------------------------------------------------------- */
/* STARTUPINFOW / PROCESS_INFORMATION helpers                                  */
/* -------------------------------------------------------------------------- */

/**
 * Allocate a zeroed STARTUPINFOW.
 * @returns allocated struct pointer.
 */
export function allocStartupInfo(): NativePtr {
  return koffi.alloc(win32Types().STARTUPINFOW, 1) as NativePtr;
}

/**
 * Encode the stdio-bearing STARTUPINFOW fields.
 * @param startupInfo - allocated STARTUPINFOW pointer.
 * @param fields - fields required for inherited stdio.
 */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  koffi.encode(startupInfo, win32Types().STARTUPINFOW, fields);
}

/**
 * Allocate a zeroed PROCESS_INFORMATION.
 * @returns allocated struct pointer.
 */
export function allocProcessInfo(): NativePtr {
  return koffi.alloc(win32Types().PROCESS_INFORMATION, 1) as NativePtr;
}

/**
 * Decode PROCESS_INFORMATION.
 * @param processInfo - struct pointer filled by CreateProcess.
 * @returns process/thread handles and ids.
 */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  return koffi.decode(processInfo, win32Types().PROCESS_INFORMATION) as ProcessInfoOutput;
}

/* -------------------------------------------------------------------------- */
/* Binding table                                                               */
/* -------------------------------------------------------------------------- */

let cached: Win32Bindings | undefined;

/**
 * Bind every Win32 function used by the sandbox organ.
 * @returns the shared binding table.
 * @remarks The first call loads kernel32, advapi32, and the Node process image;
 * every later call returns the same table.
 */
function bindings(): Win32Bindings {
  if (cached !== undefined) return cached;
  const { PVOID, PPVOID, STARTUPINFOW, PROCESS_INFORMATION } = win32Types();
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const node = koffi.load(null);
  const bind = (
    library: LibraryHandle,
    name: string,
    result: Ptr | string,
    args: Array<Ptr | string>,
  ): unknown => library.func('__stdcall', name, result, args);
  cached = {
    /* Generic process, stdio, and Job operations. */
    closeHandle: bind(kernel32, 'CloseHandle', 'int', [PVOID]),
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []),
    getFileType: bind(kernel32, 'GetFileType', 'uint32', [PVOID]),
    formatMessageW: bind(kernel32, 'FormatMessageW', 'uint32', [
      'uint32', PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID,
    ]),
    createPipe: bind(kernel32, 'CreatePipe', 'int', [PPVOID, PPVOID, PVOID, 'uint32']),
    setHandleInformation: bind(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32']),
    createProcessAsUserW: bind(advapi32, 'CreateProcessAsUserW', 'int', [
      PVOID, 'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    createProcessW: bind(kernel32, 'CreateProcessW', 'int', [
      'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    readFile: bind(kernel32, 'ReadFile', 'int', [PVOID, PVOID, 'uint32', koffi.pointer('uint32'), PVOID]),
    peekNamedPipe: bind(kernel32, 'PeekNamedPipe', 'int', [
      PVOID, PVOID, 'uint32', koffi.pointer('uint32'), koffi.pointer('uint32'), koffi.pointer('uint32'),
    ]),
    waitForSingleObject: bind(kernel32, 'WaitForSingleObject', 'uint32', [PVOID, 'uint32']),
    getExitCodeProcess: bind(kernel32, 'GetExitCodeProcess', 'int', [PVOID, koffi.pointer('uint32')]),
    createJobObjectW: bind(kernel32, 'CreateJobObjectW', PVOID, [PVOID, 'str16']),
    setInformationJobObject: bind(kernel32, 'SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
    queryInformationJobObject: bind(kernel32, 'QueryInformationJobObject', 'int', [
      PVOID, 'int', PVOID, 'uint32', PVOID,
    ]),
    assignProcessToJobObject: bind(kernel32, 'AssignProcessToJobObject', 'int', [PVOID, PVOID]),
    resumeThread: bind(kernel32, 'ResumeThread', 'uint32', [PVOID]),
    terminateProcess: bind(kernel32, 'TerminateProcess', 'int', [PVOID, 'uint32']),
    terminateJobObject: bind(kernel32, 'TerminateJobObject', 'int', [PVOID, 'uint32']),
    getStdHandle: bind(kernel32, 'GetStdHandle', PVOID, ['int']),
    uvGetOsfhandle: node.func('uv_get_osfhandle', PVOID, ['int']),
    /* Token, SID, and security-descriptor operations. */
    openProcess: bind(kernel32, 'OpenProcess', PVOID, ['uint32', 'int', 'uint32']),
    openProcessToken: bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID]),
    localAlloc: bind(kernel32, 'LocalAlloc', PVOID, ['uint32', 'size_t']),
    localFree: bind(kernel32, 'LocalFree', PVOID, [PVOID]),
    convertStringSidToSidW: bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID]),
    createWellKnownSid: bind(advapi32, 'CreateWellKnownSid', 'int', [
      'int', PVOID, PVOID, koffi.pointer('uint32'),
    ]),
    isValidSid: bind(advapi32, 'IsValidSid', 'int', [PVOID]),
    getLengthSid: bind(advapi32, 'GetLengthSid', 'uint32', [PVOID]),
    copySid: bind(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID]),
    getTokenInformation: bind(advapi32, 'GetTokenInformation', 'int', [
      PVOID, 'int', PVOID, 'uint32', koffi.pointer('uint32'),
    ]),
    setTokenInformation: bind(advapi32, 'SetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32']),
    createRestrictedToken: bind(advapi32, 'CreateRestrictedToken', 'int', [
      PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID,
    ]),
    setEntriesInAclW: bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID]),
    initializeAcl: bind(advapi32, 'InitializeAcl', 'int', [PVOID, 'uint32', 'uint32']),
    addMandatoryAce: bind(advapi32, 'AddMandatoryAce', 'int', [PVOID, 'uint32', 'uint32', 'uint32', PVOID]),
    setNamedSecurityInfoW: bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID,
    ]),
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID,
    ]),
    /* Filesystem, environment, and console operations. */
    getTempPathW: bind(kernel32, 'GetTempPathW', 'uint32', ['uint32', PVOID]),
    setEnvironmentVariableW: bind(kernel32, 'SetEnvironmentVariableW', 'int', ['str16', 'str16']),
    setConsoleCtrlHandler: bind(kernel32, 'SetConsoleCtrlHandler', 'int', [PVOID, 'int']),
    createFileW: bind(kernel32, 'CreateFileW', PVOID, [
      'str16', 'uint32', 'uint32', PVOID, 'uint32', 'uint32', PVOID,
    ]),
    lockFileEx: bind(kernel32, 'LockFileEx', 'int', [
      PVOID, 'uint32', 'uint32', 'uint32', 'uint32', PVOID,
    ]),
    unlockFileEx: bind(kernel32, 'UnlockFileEx', 'int', [
      PVOID, 'uint32', 'uint32', 'uint32', PVOID,
    ]),
  } as unknown as Win32Bindings;
  return cached;
}

/**
 * Resolve the cached Win32 binding table asynchronously.
 * @returns generic process plus ACL/token/security bindings.
 */
export function win32(): Promise<Win32Bindings> {
  return Promise.resolve(bindings());
}

/**
 * Resolve the cached Win32 binding table synchronously.
 * @returns generic process plus ACL/token/security bindings.
 */
export function win32Sync(): Win32Bindings {
  return bindings();
}

/**
 * Resolve the current Windows temporary directory.
 * @param api - active binding table.
 * @returns UTF-16 path reported by GetTempPathW.
 */
export function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((MAX_PATH + 1) * 2);
  const length = api.getTempPathW(buffer.length / 2, buffer);
  if (length === 0) throwLastError(api, 'GetTempPathW');
  if (length > buffer.length / 2) {
    throw new Win32Error(
      'GetTempPathW',
      ERROR_INSUFFICIENT_BUFFER,
      `required ${length} chars exceed the ${buffer.length / 2}-char buffer; nothing was written`,
    );
  }
  return buffer.subarray(0, length * 2).toString('utf16le');
}
