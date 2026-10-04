/**
 * Restricted-token process spawning for the sandbox organ.
 *
 * Ported from `@deepseek-ai/dsh-win32-process`'s `process.ts`, reduced to the
 * one launch Conservatory needs: a suspended `CreateProcessAsUserW` child with
 * anonymous-pipe stdout/stderr, immediate stdin EOF, hidden initial windows,
 * and a kill-on-close Job that owns the child and every grandchild.
 *
 * The caller owns the restricted token and the returned `SandboxProcess`; this
 * module owns the three pipes, the Job, the direct child handle, and every
 * Koffi allocation it makes. Fail-closed: an error path releases everything it
 * already created before it throws, `output()` closes the pipe read ends it
 * drains, and `dispose()` closes the Job and process handles once each.
 */

import type koffiModule from 'koffi' with { 'resolution-mode': 'import' };
import {
  CREATE_SUSPENDED,
  ERROR_BROKEN_PIPE,
  ERROR_NO_DATA,
  HANDLE_FLAG_INHERIT,
  JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET,
  JOBOBJECT_BASIC_ACCOUNTING_SIZE,
  JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
  JOBOBJECT_EXTENDED_LIMIT_SIZE,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JobObjectBasicAccountingInformation,
  JobObjectExtendedLimitInformation,
  STARTF_USESHOWWINDOW,
  STARTF_USESTDHANDLES,
  STARTUPINFOW_SIZE,
  SW_HIDE,
  WAIT_TIMEOUT,
  allocProcessInfo,
  allocPtrSlot,
  allocStartupInfo,
  allocUint32,
  decodeProcessInfo,
  decodePtr,
  decodeUint32,
  encodeStartupInfo,
  isNullPtr,
  throwLastError,
  throwWin32,
} from './win32';
import type { NativePtr, Win32Bindings } from './win32';

/**
 * Koffi's CommonJS entry, loaded once with the same declaration workaround as
 * `./win32`: a plain default import is rejected under `module: node16` because
 * koffi's `index.d.ts` lives in a `"type": "module"` package while its runtime
 * entry stays CommonJS.
 */
const koffi: typeof koffiModule = require('koffi') as typeof koffiModule;

/**
 * Release one native allocation. Koffi is reached for freeing and nothing else.
 * @param pointer - allocation made by this module, or undefined when unused.
 */
function freeNative(pointer: NativePtr | undefined): void {
  if (pointer !== undefined) koffi.free(pointer as never);
}

/**
 * Close one handle whose failure the caller may not report.
 * @param api - active binding table.
 * @param handle - handle to close; null and undefined are ignored.
 */
function closeBestEffort(api: Win32Bindings, handle: NativePtr | null | undefined): void {
  if (!isNullPtr(handle)) api.closeHandle(handle);
}

/** One anonymous pipe with both ends still owned by the caller. */
interface PipePair {
  read: NativePtr;
  write: NativePtr;
}

/**
 * Quote one argument according to CommandLineToArgvW parsing.
 * @param argument - one argv entry.
 * @returns bare or quoted command-line segment.
 */
export function quoteArg(argument: string): string {
  if (argument === '') return '""';
  if (!/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0;
    while (index < argument.length && argument.charAt(index) === '\\') {
      backslashes += 1;
      index += 1;
    }
    if (index === argument.length) {
      quoted += '\\'.repeat(backslashes * 2);
    } else if (argument.charAt(index) === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += '\\'.repeat(backslashes) + argument.charAt(index);
    }
  }
  return quoted + '"';
}

/**
 * Build the mutable command line accepted by CreateProcessAsUserW.
 * @param program - executable argv entry.
 * @param args - remaining argv entries.
 * @returns joined Win32 command line.
 */
export function buildCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteArg).join(' ');
}

/**
 * Create one anonymous pipe and record both ends as owned by the caller.
 * @param api - active binding table.
 * @param owned - handles closed by the caller when spawning fails or succeeds.
 * @returns the decoded read and write ends.
 */
function createPipe(api: Win32Bindings, owned: Set<NativePtr>): PipePair {
  const readSlot = allocPtrSlot();
  let writeSlot: NativePtr | undefined;
  try {
    writeSlot = allocPtrSlot();
    if (api.createPipe(readSlot, writeSlot, null, 0) === 0) throwLastError(api, 'CreatePipe');
    const read = decodePtr(readSlot);
    const write = decodePtr(writeSlot);
    if (read === null || write === null) {
      closeBestEffort(api, read);
      closeBestEffort(api, write);
      throwLastError(api, 'CreatePipe', 'null pipe handle');
    }
    owned.add(read);
    owned.add(write);
    return { read, write };
  } finally {
    freeNative(writeSlot);
    freeNative(readSlot);
  }
}

/**
 * Close one handle this spawn opened, exactly once.
 * @param api - active binding table.
 * @param owned - handles still owned by the spawn.
 * @param handle - handle to release.
 */
function closeOwned(api: Win32Bindings, owned: Set<NativePtr>, handle: NativePtr): void {
  if (!owned.delete(handle)) return;
  api.closeHandle(handle);
}

/**
 * Close every handle the spawn still owns, after a failure.
 * @param api - active binding table.
 * @param owned - handles still owned by the spawn.
 */
function closeAllOwned(api: Win32Bindings, owned: Set<NativePtr>): void {
  for (const handle of owned) api.closeHandle(handle);
  owned.clear();
}

/**
 * Create the unnamed Job that kills its members when its last handle closes.
 * @param api - active binding table.
 * @returns Job handle owned by the caller.
 */
function createKillOnCloseJob(api: Win32Bindings): NativePtr {
  const job = api.createJobObjectW(null, null);
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW');
  const information = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE);
  information.writeUInt32LE(
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
  );
  if (api.setInformationJobObject(
    job,
    JobObjectExtendedLimitInformation,
    information,
    information.length,
  ) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(job);
    throwWin32(api, 'SetInformationJobObject', win32Code);
  }
  return job;
}

/**
 * Drain one anonymous pipe until the child closes its write end.
 * @param api - active binding table.
 * @param handle - pipe read end; always closed before this function settles.
 * @returns every byte read, as raw Buffers concatenated in arrival order.
 * @remarks Polling with a one-millisecond sleep keeps the Node event loop
 * free; the reference implementation relies on the same interval.
 */
async function drainPipe(api: Win32Bindings, handle: NativePtr): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let countSlot: NativePtr | undefined;
  try {
    countSlot = allocUint32();
    for (;;) {
      const peeked = api.peekNamedPipe(handle, null, 0, null, countSlot, null);
      if (peeked === 0) {
        const win32Code = api.getLastError();
        if (win32Code === ERROR_BROKEN_PIPE || win32Code === ERROR_NO_DATA) break;
        throwLastError(api, 'PeekNamedPipe', `drain failure after ${chunks.length} chunk(s)`);
      }
      const available = decodeUint32(countSlot);
      if (available > 0) {
        const chunk = Buffer.alloc(available);
        if (api.readFile(handle, chunk, chunk.length, countSlot, null) === 0) {
          throwLastError(api, 'ReadFile', `drain failure after ${chunks.length} chunk(s)`);
        }
        chunks.push(chunk.subarray(0, decodeUint32(countSlot)));
      }
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
    return Buffer.concat(chunks);
  } finally {
    freeNative(countSlot);
    api.closeHandle(handle);
  }
}

/**
 * Return whether a Job has no active processes.
 * @param api - active binding table.
 * @param job - Job handle, as exposed by `SandboxProcess.job` before disposal.
 * @returns true once the Job, and so every grandchild, reports zero members.
 */
export function isJobEmpty(api: Win32Bindings, job: NativePtr): boolean {
  const information = Buffer.alloc(JOBOBJECT_BASIC_ACCOUNTING_SIZE);
  if (api.queryInformationJobObject(
    job,
    JobObjectBasicAccountingInformation,
    information,
    information.length,
    null,
  ) === 0) {
    throwLastError(api, 'QueryInformationJobObject', 'active process count');
  }
  return information.readUInt32LE(JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET) === 0;
}

/** What a sandboxed child runs, and where. */
export interface SandboxSpawnOptions {
  /** Executable argv entry passed through CreateProcessAsUserW. */
  command: string;
  /** Arguments excluding the executable. */
  args: readonly string[];
  /** Existing child working directory. */
  cwd: string;
  /**
   * Text appended verbatim after the quoted executable, replacing the
   * argv-quoted `args`. `cmd.exe` parses its own tail after `/c` instead of
   * using CommandLineToArgvW, so a command line handed to it must not be
   * re-quoted or its inner quotes survive into the child's arguments.
   */
  rawArguments?: string;
}

/** One spawned child and the handles that keep it and its Job alive. */
export interface SandboxProcess {
  /** Direct child process id. */
  readonly pid: number;
  /** Job holding the child and every grandchild; valid until `dispose()`. */
  readonly job: NativePtr;
  /** Resolves once both pipes reach EOF; never rejects for a normal child exit. */
  output(): Promise<{ stdout: Buffer; stderr: Buffer }>;
  /** Poll without blocking. Returns the exit code once the child has exited, else undefined. */
  pollExit(): number | undefined;
  /** Kill the whole job (the direct child and every grandchild). Best effort, never throws. */
  terminate(): void;
  /** Close the job and process handles. Idempotent. Must not throw on double disposal. */
  dispose(): void;
}

/** Handles transferred from a successful spawn to the returned object. */
interface SandboxProcessHandles {
  pid: number;
  process: NativePtr;
  job: NativePtr;
  stdoutRead: NativePtr;
  stderrRead: NativePtr;
}

/**
 * Own the spawned child: start both pipe drains, then expose polling,
 * termination, and disposal over the transferred handles.
 * @param api - active binding table.
 * @param handles - handles whose ownership the spawn just gave up.
 * @returns the process object held by the caller.
 */
function sandboxProcess(api: Win32Bindings, handles: SandboxProcessHandles): SandboxProcess {
  let processHandle: NativePtr | undefined = handles.process;
  let jobHandle: NativePtr | undefined = handles.job;
  let exitCode: number | undefined;

  // Draining starts here, at spawn time, so a child that fills either pipe
  // buffer can never block waiting for a reader.
  const stdoutDrain = drainPipe(api, handles.stdoutRead);
  const stderrDrain = drainPipe(api, handles.stderrRead);
  const drained = Promise.all([stdoutDrain, stderrDrain])
    .then(([stdout, stderr]) => ({ stdout, stderr }));
  // The caller may never call output(); an unobserved rejection must not become
  // an unhandled rejection. A caller that does await output() still sees it.
  drained.catch(() => undefined);

  /** Close the process handle once, whatever opened it. */
  function closeProcessHandle(): void {
    const handle = processHandle;
    processHandle = undefined;
    if (handle !== undefined) api.closeHandle(handle);
  }

  return {
    pid: handles.pid,
    job: handles.job,

    output: () => drained,

    pollExit: (): number | undefined => {
      if (exitCode !== undefined) return exitCode;
      const handle = processHandle;
      if (handle === undefined) return undefined;
      const waitResult = api.waitForSingleObject(handle, 0);
      if (waitResult === WAIT_TIMEOUT) return undefined;
      if (waitResult === 0xffffffff) throwLastError(api, 'WaitForSingleObject');
      let exitCodeSlot: NativePtr | undefined;
      try {
        exitCodeSlot = allocUint32();
        if (api.getExitCodeProcess(handle, exitCodeSlot) === 0) {
          throwLastError(api, 'GetExitCodeProcess');
        }
        exitCode = decodeUint32(exitCodeSlot);
      } finally {
        freeNative(exitCodeSlot);
      }
      closeProcessHandle();
      return exitCode;
    },

    terminate: (): void => {
      try {
        const job = jobHandle;
        if (job !== undefined && api.terminateJobObject(job, 1) !== 0) return;
        const handle = processHandle;
        if (handle !== undefined) api.terminateProcess(handle, 1);
      } catch {
        // Killing is best effort by contract: a disposed Job or an already
        // dead child must never surface as an exception here.
      }
    },

    dispose: (): void => {
      const job = jobHandle;
      jobHandle = undefined;
      if (job !== undefined) {
        try {
          api.closeHandle(job);
        } catch {
          // Idempotent disposal must not throw on a handle already gone.
        }
      }
      try {
        closeProcessHandle();
      } catch {
        // Idempotent disposal must not throw on a handle already gone.
      }
    },
  };
}

/**
 * Spawn a restricted-token child in a kill-on-close Job with piped stdout and
 * stderr, no stdin writer, hidden initial windows, and no console window.
 * @param api - active binding table.
 * @param token - restricted primary token the child runs under.
 * @param options - command, args, and working directory.
 * @returns the running child; its pipes drain from the moment of spawn.
 * @remarks The child is created suspended, assigned to the Job, and only then
 * resumed, so no grandchild can escape the Job during startup.
 */
export function spawnSandboxedProcess(
  api: Win32Bindings,
  token: NativePtr,
  options: SandboxSpawnOptions,
): SandboxProcess {
  const owned = new Set<NativePtr>();
  let startupInfo: NativePtr | undefined;
  let processInfo: NativePtr | undefined;
  let job: NativePtr | undefined;
  let process: NativePtr | undefined;
  let thread: NativePtr | undefined;
  try {
    const stdIn = createPipe(api, owned);
    const stdOut = createPipe(api, owned);
    const stdErr = createPipe(api, owned);
    for (const [handle, label] of [
      [stdIn.read, 'stdin read end'],
      [stdOut.write, 'stdout write end'],
      [stdErr.write, 'stderr write end'],
    ] as const) {
      if (api.setHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, 'SetHandleInformation', label);
      }
    }
    // The child is meant to be the only reader of stdin: dropping the parent's
    // write end makes every read it performs return EOF instead of blocking.
    closeOwned(api, owned, stdIn.write);
    startupInfo = allocStartupInfo();
    encodeStartupInfo(startupInfo, {
      cb: STARTUPINFOW_SIZE,
      // Console inheritance is preserved on purpose: CREATE_NO_WINDOW can fail
      // restricted-token DLL initialization. The window itself stays hidden.
      dwFlags: STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
      wShowWindow: SW_HIDE,
      hStdInput: stdIn.read,
      hStdOutput: stdOut.write,
      hStdError: stdErr.write,
    });
    processInfo = allocProcessInfo();
    const childJob = createKillOnCloseJob(api);
    job = childJob;
    const commandLine =
      options.rawArguments === undefined
        ? buildCommandLine(options.command, options.args)
        : `${quoteArg(options.command)} ${options.rawArguments}`;
    // lpApplicationName and lpEnvironment stay null: the sandbox sets its own
    // environment before this call, and an explicit block makes
    // CreateProcessAsUserW fail with ERROR_INVALID_PARAMETER here.
    const created = api.createProcessAsUserW(
      token,
      null,
      commandLine,
      null,
      null,
      1,
      CREATE_SUSPENDED,
      null,
      options.cwd,
      startupInfo,
      processInfo,
    );
    if (created === 0) {
      // Captured before cleanup, which issues further Win32 calls.
      const win32Code = api.getLastError();
      throwWin32(
        api,
        'CreateProcessAsUserW',
        win32Code,
        `command: ${options.command}, cwd: ${options.cwd}`,
      );
    }
    const info = decodeProcessInfo(processInfo);
    if (info.hProcess === null || info.hThread === null) {
      if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1);
      closeBestEffort(api, info.hThread);
      closeBestEffort(api, info.hProcess);
      throw new Error(
        `CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`,
      );
    }
    process = info.hProcess;
    thread = info.hThread;
    // The child owns its pipe ends now; keeping the parent's copies open would
    // hold both pipes past the child's exit and stall the drains.
    closeOwned(api, owned, stdIn.read);
    closeOwned(api, owned, stdOut.write);
    closeOwned(api, owned, stdErr.write);
    if (api.assignProcessToJobObject(childJob, process) === 0) {
      const win32Code = api.getLastError();
      api.terminateProcess(process, 1);
      throwWin32(api, 'AssignProcessToJobObject', win32Code, `pid ${info.dwProcessId}`);
    }
    if (api.resumeThread(thread) === 0xffffffff) {
      const win32Code = api.getLastError();
      throwWin32(api, 'ResumeThread', win32Code, `pid ${info.dwProcessId}`);
    }
    closeBestEffort(api, thread);
    thread = undefined;
    // Ownership of the Job, the process, and the two read ends passes to the
    // returned object; everything else is closed by the paths above.
    process = undefined;
    job = undefined;
    owned.delete(stdOut.read);
    owned.delete(stdErr.read);
    return sandboxProcess(api, {
      pid: info.dwProcessId,
      process: info.hProcess,
      job: childJob,
      stdoutRead: stdOut.read,
      stderrRead: stdErr.read,
    });
  } catch (error) {
    closeAllOwned(api, owned);
    closeBestEffort(api, thread);
    closeBestEffort(api, process);
    closeBestEffort(api, job);
    throw error;
  } finally {
    freeNative(processInfo);
    freeNative(startupInfo);
  }
}
