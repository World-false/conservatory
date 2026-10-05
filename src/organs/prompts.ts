/**
 * The prompt templates are operator-editable Markdown files, not code. This
 * module owns the four of them, the two ways they can be loaded, and the
 * built-in copy of each that is used when the file is missing or unusable.
 *
 * The round has two sides: the system side is the manual plus
 * `prompts/system_context.md` (MEMORY and body state), and the user side is
 * `prompts/user_context.md` (system reminders and messages).
 *
 * Every read here is deliberately total: it returns text and a warning, and it
 * never throws. A prompt problem must degrade into a fallback and an operator
 * notice, never into a dead round.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR_NAME, type RuntimePaths } from '../config';
import { BODY_MANUAL } from './manual';
import { MEMORY_SYSTEM_PROMPT } from './memory';

/** Read the file on every wake, or keep what was loaded until told to reload. */
export type PromptLoadMode = 'hot' | 'cached';

export const MANUAL_FILE = 'manual.md';
export const SYSTEM_CONTEXT_FILE = 'system_context.md';
export const USER_CONTEXT_FILE = 'user_context.md';
export const MEMORY_SYSTEM_FILE = 'memory_system.md';

export const MEMORY_PLACEHOLDER = '{{memory}}';
export const BODY_STATE_PLACEHOLDER = '{{body_state}}';
export const SYSTEM_REMINDERS_PLACEHOLDER = '{{system_reminders}}';
export const MESSAGES_PLACEHOLDER = '{{messages}}';

/**
 * The system side of the round: what the agent is, appended after the manual.
 * The headings are plain Markdown, so the agent reads the same text the
 * operator sees when they open prompts/system_context.md.
 */
export const DEFAULT_SYSTEM_CONTEXT_TEMPLATE = [
  '# MEMORY',
  MEMORY_PLACEHOLDER,
  '',
  '# BODY STATE',
  BODY_STATE_PLACEHOLDER,
].join('\n');

/**
 * The user side of the round: what the harness did to the agent's body, and
 * what someone said to it. The task board is deliberately absent: it is read
 * with the list_tasks tool instead of being injected.
 */
export const DEFAULT_USER_CONTEXT_TEMPLATE = [
  '# SYSTEM REMINDERS',
  SYSTEM_REMINDERS_PLACEHOLDER,
  '',
  '# MESSAGES',
  MESSAGES_PLACEHOLDER,
].join('\n');

/** One template, as it came out of a load: text to use plus how it was found. */
export interface LoadedPrompt {
  file: string;
  path: string;
  /** The text to use: the file's, or the built-in fallback. */
  text: string;
  /** True only when the file was read and passed validation. */
  fromFile: boolean;
  /** Operator-facing Chinese, null when the file is fine. */
  warning: string | null;
}

export interface PromptReadResult {
  manual: LoadedPrompt;
  systemContext: LoadedPrompt;
  userContext: LoadedPrompt;
  memorySystem: LoadedPrompt;
  warnings: string[];
}

export interface PromptTemplateStatus {
  file: string;
  path: string;
  fromFile: boolean;
  warning: string | null;
}

export interface PromptStatus {
  mode: PromptLoadMode;
  dir: string;
  healthy: boolean;
  warnings: string[];
  templates: PromptTemplateStatus[];
}

/**
 * The blocks of one round. `memory` and `bodyState` fill the system-side
 * template, which is appended after the manual; `systemReminders` and
 * `messages` fill the user-side template. The task board is not a block: it is
 * read with the list_tasks tool.
 */
export interface RoundContextBlocks {
  /** The MEMORY text; the boundary lines come from the template itself. */
  memory: string;
  bodyState: string;
  /**
   * What the harness did to the agent's body on its own: transfers received,
   * and later other events. Separate from `messages`, which is addressed to the
   * agent by someone.
   */
  systemReminders: string;
  messages: string;
}

type PromptKind = 'manual' | 'systemContext' | 'userContext' | 'memorySystem';

interface PromptSpec {
  file: string;
  requiredPlaceholders: readonly string[];
}

const SPECS: Record<PromptKind, PromptSpec> = {
  manual: { file: MANUAL_FILE, requiredPlaceholders: [] },
  // The memory is the one block whose loss would erase the agent's past, so
  // this template is refused whole without {{memory}}.
  systemContext: { file: SYSTEM_CONTEXT_FILE, requiredPlaceholders: [MEMORY_PLACEHOLDER] },
  userContext: { file: USER_CONTEXT_FILE, requiredPlaceholders: [] },
  memorySystem: { file: MEMORY_SYSTEM_FILE, requiredPlaceholders: [] },
};

export interface PromptLibraryOptions {
  dir: string;
  mode?: PromptLoadMode;
  manualFallback?: string;
  systemContextFallback?: string;
  userContextFallback?: string;
  memorySystemFallback?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return null;
}

/** Templates are Markdown in a repository: CRLF and a trailing newline are noise. */
function normalizePromptText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trimEnd();
}

function labelOf(file: string): string {
  return `${PROMPTS_DIR_NAME}/${file}`;
}

function fallbackPrompt(spec: PromptSpec, filePath: string, fallback: string, warning: string): LoadedPrompt {
  return { file: spec.file, path: filePath, text: fallback, fromFile: false, warning };
}

function readPromptFile(dir: string, spec: PromptSpec, fallback: string): LoadedPrompt {
  const filePath = path.join(dir, spec.file);
  const label = labelOf(spec.file);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const detail = errorCode(error) ?? messageOf(error);
    return fallbackPrompt(
      spec,
      filePath,
      fallback,
      `提示词模板无法读取：${label}（${detail}），已使用内置兜底文本`,
    );
  }
  const text = normalizePromptText(raw);
  if (text === '') {
    return fallbackPrompt(spec, filePath, fallback, `提示词模板内容为空：${label}，已使用内置兜底文本`);
  }
  const missing = spec.requiredPlaceholders.filter((placeholder) => !text.includes(placeholder));
  if (missing.length > 0) {
    return fallbackPrompt(
      spec,
      filePath,
      fallback,
      `提示词模板缺少 ${missing.join('、')} 占位符，已降级使用安全模板`,
    );
  }
  return { file: spec.file, path: filePath, text, fromFile: true, warning: null };
}

/**
 * Fills the round's blocks in one pass, so a value that happens to contain a
 * placeholder is never substituted again. The same function serves both sides
 * of the request: the system template uses memory and body state, the user
 * template uses system reminders and messages. Blocks a template does not
 * mention are simply not injected, and unknown placeholders stay as written.
 */
export function renderRoundContext(template: string, blocks: RoundContextBlocks): string {
  const values: Record<string, string> = {
    memory: blocks.memory,
    body_state: blocks.bodyState,
    system_reminders: blocks.systemReminders,
    messages: blocks.messages,
  };
  const pattern = /\{\{(memory|body_state|system_reminders|messages)\}\}/g;
  return template.replace(pattern, (match: string, key: string): string => values[key] ?? match);
}

/** The four templates, their load mode, and the built-in copy of each. */
export class PromptLibrary {
  readonly dir: string;
  private readonly fallbacks: Record<PromptKind, string>;
  private mode: PromptLoadMode;
  private readonly cache = new Map<PromptKind, LoadedPrompt>();

  constructor(options: PromptLibraryOptions) {
    this.dir = options.dir;
    this.mode = options.mode ?? 'hot';
    this.fallbacks = {
      manual: options.manualFallback ?? BODY_MANUAL,
      systemContext: options.systemContextFallback ?? DEFAULT_SYSTEM_CONTEXT_TEMPLATE,
      userContext: options.userContextFallback ?? DEFAULT_USER_CONTEXT_TEMPLATE,
      memorySystem: options.memorySystemFallback ?? MEMORY_SYSTEM_PROMPT,
    };
  }

  getMode(): PromptLoadMode {
    return this.mode;
  }

  /** Switching to cached fills the cache now; the files are read again on demand. */
  setMode(mode: PromptLoadMode): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.cache.clear();
    if (mode === 'cached') {
      this.read();
    }
  }

  /** Throws away what was loaded; in cached mode this rereads every file at once. */
  reload(): void {
    this.cache.clear();
    if (this.mode === 'cached') {
      this.read();
    }
  }

  manual(): LoadedPrompt {
    return this.load('manual');
  }

  systemContext(): LoadedPrompt {
    return this.load('systemContext');
  }

  userContext(): LoadedPrompt {
    return this.load('userContext');
  }

  memorySystem(): LoadedPrompt {
    return this.load('memorySystem');
  }

  /** All four at once, which is what one wake-up needs. */
  read(): PromptReadResult {
    const manual = this.manual();
    const systemContext = this.systemContext();
    const userContext = this.userContext();
    const memorySystem = this.memorySystem();
    const warnings = [manual, systemContext, userContext, memorySystem]
      .map((loaded) => loaded.warning)
      .filter((warning): warning is string => warning !== null);
    return { manual, systemContext, userContext, memorySystem, warnings };
  }

  status(): PromptStatus {
    const bundle = this.read();
    return {
      mode: this.mode,
      dir: this.dir,
      healthy: bundle.warnings.length === 0,
      warnings: bundle.warnings,
      templates: [bundle.manual, bundle.systemContext, bundle.userContext, bundle.memorySystem].map((loaded) => ({
        file: loaded.file,
        path: loaded.path,
        fromFile: loaded.fromFile,
        warning: loaded.warning,
      })),
    };
  }

  private load(kind: PromptKind): LoadedPrompt {
    if (this.mode === 'cached') {
      const hit = this.cache.get(kind);
      if (hit !== undefined) {
        return hit;
      }
    }
    const loaded = readPromptFile(this.dir, SPECS[kind], this.fallbacks[kind]);
    if (this.mode === 'cached') {
      this.cache.set(kind, loaded);
    }
    return loaded;
  }
}

/** The live library of a running conservatory, with the built-in fallbacks wired in. */
export function createPromptLibrary(paths: RuntimePaths, mode: PromptLoadMode = 'hot'): PromptLibrary {
  return new PromptLibrary({ dir: paths.promptsDir, mode });
}

/**
 * Turns consecutive warning lists into notices: a condition that persists
 * produces one notice, and a condition that clears can be reported again if it
 * comes back.
 */
export class PromptWarningNotices {
  private seen = new Set<string>();

  take(warnings: readonly string[]): string[] {
    const fresh = warnings.filter((warning) => !this.seen.has(warning));
    this.seen = new Set(warnings);
    return fresh;
  }
}
