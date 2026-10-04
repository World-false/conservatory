/**
 * The command sandbox: one entry point that runs a shell command inside the
 * agent's own workspace and nowhere else.
 *
 * Every call rebuilds the same three layers, because every layer is what makes
 * the next one trustworthy:
 *
 *  1. **ACL layer.** The agent's writable directories gain an ALLOW ACE for a
 *     capability SID derived from the working directory; every protected path
 *     (the ledger and black boxes in `SUPERVISOR/`, other agents' homes, the
 *     configured read blacklist, and `MEMORY`) gains a DENY ACE for the same
 *     SID. All edits are idempotent, so the first command pays for propagation
 *     and later ones are cheap.
 *  2. **Token layer.** The child runs under a restricted token carrying that
 *     capability SID in its restricting list, so the DENY ACEs above bind the
 *     child and not the supervisor.
 *  3. **Process layer.** The child is created suspended, assigned to a
 *     kill-on-close Job Object, then resumed. When the timeout expires the
 *     whole job is terminated, so a background grandchild cannot outlive the
 *     command.
 *
 * Fail closed: if any layer cannot be established the call throws and no
 * process is ever started with a wider token.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { win32Sync } from './win32';
import type { NativePtr, Win32Bindings } from './win32';
import { DISABLE_MAX_PRIVILEGE, LUA_TOKEN, SUB_CONTAINERS_AND_OBJECTS_INHERIT } from './win32';
import {
  CAPABILITY_ACCESS,
  FULL_DENY_ACCESS,
  NO_INHERITANCE,
  WRITE_DENY_ACCESS,
  denyCapability,
  grantCapability,
  grantReadOnly,
} from './acl';
import { spawnSandboxedProcess } from './process';
import {
  WinBuiltinUsersSid,
  WinRestrictedCodeSid,
  WinWorldSid,
  capabilitySidFor,
  createRestrictedToken,
  findLogonSid,
  makeWellKnownSid,
  openCurrentProcessToken,
  parseSidString,
  setTokenDefaultDaclGrant,
} from './token';

/** Default wall-clock limit for one command. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
/** Default cap on each captured stream, in characters. */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

/** The shell a command line is handed to. */
export type SandboxShell = 'pwsh' | 'cmd';

export interface ExecuteCommandOptions {
  /** The command line string, as the agent wrote it. */
  command: string;
  /** Working directory; confined to the agent's own workspace by the caller. */
  cwd: string;
  /** Directories the confined process may write into. */
  writableDirs: string[];
  /** How the read lists are interpreted. */
  readMode: 'blacklist' | 'whitelist';
  /** Directories that must stay unreadable and unwritable. */
  readBlacklist: string[];
  /** Directories readable in whitelist mode (also readable in blacklist mode). */
  readWhitelist: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Shell to wrap the command line in. Defaults to pwsh. */
  shell?: SandboxShell;
  /** Root inside which whitelist mode denies everything not listed. */
  whitelistRoot?: string;
  /** Files that must stay readable but never writable (the agent's MEMORY). */
  readOnlyFiles?: string[];
  /** Directory the child sees as TEMP/TMP; created when missing. */
  tempDir?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** A sandbox failure that carries a stable machine-readable code. */
export class SandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

function requireDirectory(candidate: string, label: string): string {
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new SandboxError('missing_directory', `${label} does not exist or is not a directory: ${resolved}`);
  }
  return resolved;
}

function optionalDirectory(candidate: string): string | null {
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return null;
  }
  return resolved;
}

/** Windows path comparison: case-insensitive, separator-normalised. */
function pathKey(candidate: string): string {
  return path.resolve(candidate).replace(/[\\/]+$/, '').toLowerCase();
}

/** True when `inner` is `outer` itself or lives inside it. */
function isSameOrInside(inner: string, outer: string): boolean {
  const innerKey = pathKey(inner);
  const outerKey = pathKey(outer);
  return innerKey === outerKey || innerKey.startsWith(`${outerKey}${path.sep}`);
}

/** True when `inner` lives strictly inside `outer`. */
function isStrictlyInside(inner: string, outer: string): boolean {
  const innerKey = pathKey(inner);
  const outerKey = pathKey(outer);
  return innerKey !== outerKey && innerKey.startsWith(`${outerKey}${path.sep}`);
}

function uniquePaths(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const key = pathKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(path.resolve(candidate));
  }
  return out;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Apply the whitelist: inside `root`, every entry that neither is nor
 * contains an allowed path is denied to the capability SID. The walk only
 * descends along the chains that lead to allowed paths, because a deny ACE on
 * an ancestor would win over any allow below it.
 */
function applyWhitelistDenies(
  api: Win32Bindings,
  root: string,
  allowed: readonly string[],
  capabilitySid: NativePtr,
): void {
  const walk = (target: string, directory: boolean): void => {
    if (allowed.some((entry) => isSameOrInside(target, entry))) {
      return;
    }
    if (directory && allowed.some((entry) => isStrictlyInside(entry, target))) {
      for (const child of listChildren(target)) {
        walk(child, isDirectory(child));
      }
      return;
    }
    denyCapability(
      api,
      target,
      capabilitySid,
      FULL_DENY_ACCESS,
      directory ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE,
    );
  };
  for (const child of listChildren(root)) {
    walk(child, isDirectory(child));
  }
}

function isDirectory(target: string): boolean {
  return existsSync(target) && statSync(target).isDirectory();
}

function listChildren(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => path.join(directory, entry.name));
}

/** Resolve the shell executable, or null when it is not on this machine. */
function resolveShell(shell: SandboxShell): string | null {
  const names = shell === 'pwsh' ? ['pwsh.exe'] : ['cmd.exe'];
  const pathEntries = (process.env['PATH'] ?? '').split(path.delimiter).filter((part) => part !== '');
  const candidates: string[] = [];
  for (const name of names) {
    for (const entry of pathEntries) {
      candidates.push(path.join(entry.replace(/^"|"$/g, ''), name));
    }
  }
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot !== undefined) {
    candidates.push(path.join(systemRoot, 'System32', 'cmd.exe'));
  }
  if (shell === 'pwsh') {
    candidates.push(path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

interface ShellInvocation {
  args: string[];
  rawArguments?: string;
}

/**
 * Wrap one command line in the requested shell. `cmd.exe` parses the text
 * after `/c` itself, so it is passed verbatim; `pwsh.exe` uses ordinary
 * CommandLineToArgvW rules, so its script goes in as one argv entry.
 */
function shellInvocation(shell: SandboxShell, commandLine: string): ShellInvocation {
  if (shell === 'cmd') {
    return { args: [], rawArguments: `/d /s /c ${commandLine}` };
  }
  return {
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', commandLine],
  };
}

/**
 * Spawn the confined child with TEMP and TMP pointing inside its own
 * workspace. The child inherits this process's environment block (passing an
 * explicit one through Koffi makes CreateProcessAsUserW reject the call), so
 * the two variables are swapped for the duration of the synchronous spawn and
 * restored immediately afterwards; JavaScript runs this without interleaving.
 */
function spawnWithPrivateTemp(
  api: Win32Bindings,
  token: NativePtr,
  shellPath: string,
  invocation: ShellInvocation,
  cwd: string,
  tempDir: string,
): ReturnType<typeof spawnSandboxedProcess> {
  const previousTemp = process.env['TEMP'];
  const previousTmp = process.env['TMP'];
  process.env['TEMP'] = tempDir;
  process.env['TMP'] = tempDir;
  try {
    return spawnSandboxedProcess(api, token, {
      command: shellPath,
      args: invocation.args,
      ...(invocation.rawArguments === undefined ? {} : { rawArguments: invocation.rawArguments }),
      cwd,
    });
  } finally {
    if (previousTemp === undefined) {
      delete process.env['TEMP'];
    } else {
      process.env['TEMP'] = previousTemp;
    }
    if (previousTmp === undefined) {
      delete process.env['TMP'];
    } else {
      process.env['TMP'] = previousTmp;
    }
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n…[output truncated at ${limit} characters]`;
}

/**
 * Run one command under the sandbox. The caller is responsible for passing a
 * `cwd` inside the agent's own workspace and for listing every path that must
 * stay out of its reach.
 */
export async function executeSandboxedCommand(options: ExecuteCommandOptions): Promise<CommandResult> {
  if (process.platform !== 'win32') {
    throw new SandboxError('unsupported_platform', 'the command sandbox is implemented for Windows only');
  }
  const commandLine = options.command.trim();
  if (commandLine === '') {
    throw new SandboxError('empty_command', 'the command is empty');
  }
  const shell: SandboxShell = options.shell ?? 'pwsh';
  const cwd = requireDirectory(options.cwd, 'cwd');
  const writableDirs = uniquePaths([cwd, ...options.writableDirs]).map((dir) =>
    requireDirectory(dir, 'writable dir'),
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const tempDir = path.resolve(options.tempDir ?? path.join(cwd, '.sandbox-tmp'));
  mkdirSync(tempDir, { recursive: true });

  const api = win32Sync();
  const capabilitySid = capabilitySidFor(cwd);
  const startedAt = Date.now();

  const worldSid = makeWellKnownSid(api, WinWorldSid);
  const usersSid = makeWellKnownSid(api, WinBuiltinUsersSid);
  const capabilitySidPtr = parseSidString(api, capabilitySid);
  let currentToken: NativePtr | null = null;
  let restrictedToken: NativePtr | null = null;

  try {
    // 1. The writable allowlist. The token is deliberately NOT lowered to Low
    //    integrity and the directories are deliberately NOT labelled: the
    //    label write (a SACL) is refused under the project tree on this host
    //    while it is accepted inside the user's own temp directory, so the
    //    same command would run at two different integrity levels depending on
    //    where the workspace happens to live, and a Low child under the
    //    restricted token is exactly the configuration in which `pwsh`
    //    intermittently dies at load with STATUS_DLL_INIT_FAILED
    //    (0xC0000142). The capability-SID ACEs below are what confine the
    //    child, and they hold at every integrity level.
    for (const directory of writableDirs) {
      grantCapability(api, directory, capabilitySidPtr, worldSid);
    }

    // 2. The read side: every directory the caller named readable gains an
    //    explicit read-and-execute ACE for the capability SID. This is what
    //    lets an agent read its own home and MEMORY under either mode, and it
    //    is what a whitelist entry actually opens.
    for (const directory of uniquePaths(options.readWhitelist)) {
      const resolved = optionalDirectory(directory);
      if (resolved === null || writableDirs.some((writable) => isSameOrInside(resolved, writable))) {
        continue;
      }
      grantReadOnly(api, resolved, capabilitySidPtr, worldSid);
    }

    // 3. The deny side: configured blacklist, always-protected paths and the
    //    read-only files. Denies are idempotent and inherit down the subtree.
    for (const directory of uniquePaths(options.readBlacklist)) {
      const resolved = optionalDirectory(directory);
      if (resolved === null) {
        continue;
      }
      // A deny on a writable directory, or on one of its ancestors, would win
      // over the allow ACE above and lock the agent out of its own workspace.
      // The effective policy never produces that overlap; this guard keeps a
      // hand-written call from doing something silently unusable.
      const overlapsWritable = writableDirs.some(
        (writable) => isSameOrInside(resolved, writable) || isSameOrInside(writable, resolved),
      );
      if (!overlapsWritable) {
        denyCapability(api, resolved, capabilitySidPtr, FULL_DENY_ACCESS);
      }
    }
    for (const file of uniquePaths(options.readOnlyFiles ?? [])) {
      if (existsSync(file) && !statSync(file).isDirectory()) {
        denyCapability(api, file, capabilitySidPtr, WRITE_DENY_ACCESS, NO_INHERITANCE);
      }
    }
    if (options.readMode === 'whitelist') {
      const scope = options.whitelistRoot === undefined ? null : optionalDirectory(options.whitelistRoot);
      if (scope !== null) {
        const allowed = uniquePaths([
          ...options.readWhitelist,
          ...writableDirs,
        ]).filter((entry) => optionalDirectory(entry) !== null);
        applyWhitelistDenies(api, scope, allowed, capabilitySidPtr);
      }
    }

    // 3. The restricted token. The logon SID, Everyone, BUILTIN\Users and
    //    NT AUTHORITY\RESTRICTED stay in the restricting list so ordinary
    //    reads still pass the second check; the capability SID is what the
    //    ACEs above speak to. No access is ever widened by this token: it only
    //    ever carries fewer rights than the supervisor's own.
    currentToken = openCurrentProcessToken(api);
    const logonSid = findLogonSid(api, currentToken);
    const restrictedSid = makeWellKnownSid(api, WinRestrictedCodeSid);
    restrictedToken = createRestrictedToken(
      api,
      currentToken,
      [logonSid, worldSid, usersSid, restrictedSid, capabilitySidPtr],
      DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
    );
    setTokenDefaultDaclGrant(api, restrictedToken, capabilitySidPtr);
    if (api.closeHandle(currentToken) === 0) {
      currentToken = null;
      throw new SandboxError('token_cleanup_failed', 'CloseHandle failed for the current process token');
    }
    currentToken = null;

    // 4. The process itself.
    const shellPath = resolveShell(shell);
    if (shellPath === null) {
      throw new SandboxError('shell_not_found', `the requested shell is not installed: ${shell}`);
    }
    const invocation = shellInvocation(shell, commandLine);
    const child = spawnWithPrivateTemp(api, restrictedToken, shellPath, invocation, cwd, tempDir);

    const outputPromise = child.output();
    let exitCode: number | undefined;
    let timedOut = false;
    const deadline = startedAt + timeoutMs;
    for (;;) {
      exitCode = child.pollExit();
      if (exitCode !== undefined) {
        break;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        child.terminate();
        break;
      }
      await delay(10);
    }
    if (timedOut) {
      const killDeadline = Date.now() + 5_000;
      while (exitCode === undefined && Date.now() < killDeadline) {
        exitCode = child.pollExit();
        if (exitCode === undefined) {
          await delay(10);
        }
      }
      if (exitCode === undefined) {
        child.terminate();
      }
    }

    const capture = await settleOutput(child, outputPromise, exitCode === undefined ? 5_000 : 2_000);
    child.dispose();

    return {
      exitCode: exitCode ?? -1,
      stdout: truncate(capture.stdout.toString('utf8'), maxOutputChars),
      stderr: truncate(capture.stderr.toString('utf8'), maxOutputChars),
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  } finally {
    if (currentToken !== null) {
      api.closeHandle(currentToken);
    }
    if (restrictedToken !== null) {
      api.closeHandle(restrictedToken);
    }
    for (const sid of [worldSid, usersSid, capabilitySidPtr]) {
      // A failed free must not mask the command's own outcome.
      api.localFree(sid);
    }
  }
}

/**
 * Wait for the captured streams, but never forever: a background grandchild
 * that holds the pipe open must not hang the round. On timeout the whole job
 * is terminated (killing it) and the drains are given one short grace period.
 */
async function settleOutput(
  child: { terminate(): void },
  output: Promise<{ stdout: Buffer; stderr: Buffer }>,
  graceMs: number,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  let settled = false;
  const timeout = delay(graceMs).then(() => {
    if (!settled) {
      child.terminate();
    }
  });
  const raced = await Promise.race([
    output.then((value) => {
      settled = true;
      return value;
    }),
    timeout.then(() => null),
  ]);
  if (raced !== null) {
    return raced;
  }
  const second = await Promise.race([output, delay(2_000).then(() => null)]);
  return second ?? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
}

/** The access mask an allowed directory grants; exported for the tests. */
export { CAPABILITY_ACCESS };
