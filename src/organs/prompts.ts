/**
 * The prompt templates are operator-editable Markdown files, not code. This
 * module owns the three of them, the two ways they can be loaded, and the
 * built-in copy of each that is used when the file is missing or unusable.
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
export const USER_CONTEXT_FILE = 'user_context.md';
export const MEMORY_SYSTEM_FILE = 'memory_system.md';

export const MEMORY_PLACEHOLDER = '{{memory}}';
export const BODY_STATE_PLACEHOLDER = '{{body_state}}';
export const TASK_BOARD_PLACEHOLDER = '{{task_board}}';
export const MESSAGES_PLACEHOLDER = '{{messages}}';

/** The safe template: it is what the file is supposed to be, and the fallback. */
export const DEFAULT_USER_CONTEXT_TEMPLATE = [
  '=== MEMORY ===',
  MEMORY_PLACEHOLDER,
  '=== END MEMORY ===',
  '',
  '=== BODY STATE ===',
  BODY_STATE_PLACEHOLDER,
  '',
  '=== TASK BOARD ===',
  TASK_BOARD_PLACEHOLDER,
  '',
  '=== MESSAGES FROM THE OPERATOR ===',
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

export interface UserContextBlocks {
  /** The MEMORY text; the boundary lines come from the template itself. */
  memory: string;
  bodyState: string;
  taskBoard: string;
  messages: string;
}

type PromptKind = 'manual' | 'userContext' | 'memorySystem';

interface PromptSpec {
  file: string;
  requiredPlaceholders: readonly string[];
}

const SPECS: Record<PromptKind, PromptSpec> = {
  manual: { file: MANUAL_FILE, requiredPlaceholders: [] },
  // The memory is the one block whose loss would erase the agent's past, so
  // this template is refused whole without {{memory}}.
  userContext: { file: USER_CONTEXT_FILE, requiredPlaceholders: [MEMORY_PLACEHOLDER] },
  memorySystem: { file: MEMORY_SYSTEM_FILE, requiredPlaceholders: [] },
};

export interface PromptLibraryOptions {
  dir: string;
  mode?: PromptLoadMode;
  manualFallback?: string;
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
 * Fills the four blocks in one pass, so a value that happens to contain a
 * placeholder is never substituted again. Blocks the template does not mention
 * are simply not injected, and unknown placeholders stay as written.
 */
export function renderUserContext(template: string, blocks: UserContextBlocks): string {
  const values: Record<string, string> = {
    memory: blocks.memory,
    body_state: blocks.bodyState,
    task_board: blocks.taskBoard,
    messages: blocks.messages,
  };
  const pattern = /\{\{(memory|body_state|task_board|messages)\}\}/g;
  return template.replace(pattern, (match: string, key: string): string => values[key] ?? match);
}

/** The three templates, their load mode, and the built-in copy of each. */
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

  userContext(): LoadedPrompt {
    return this.load('userContext');
  }

  memorySystem(): LoadedPrompt {
    return this.load('memorySystem');
  }

  /** All three at once, which is what one wake-up needs. */
  read(): PromptReadResult {
    const manual = this.manual();
    const userContext = this.userContext();
    const memorySystem = this.memorySystem();
    const warnings = [manual, userContext, memorySystem]
      .map((loaded) => loaded.warning)
      .filter((warning): warning is string => warning !== null);
    return { manual, userContext, memorySystem, warnings };
  }

  status(): PromptStatus {
    const bundle = this.read();
    return {
      mode: this.mode,
      dir: this.dir,
      healthy: bundle.warnings.length === 0,
      warnings: bundle.warnings,
      templates: [bundle.manual, bundle.userContext, bundle.memorySystem].map((loaded) => ({
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
