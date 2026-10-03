import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { agentNotebookDir, type RuntimePaths } from '../config';

export type NotebookErrorCode =
  | 'empty_path'
  | 'drive_letter'
  | 'absolute_path'
  | 'parent_traversal'
  | 'outside_notebook'
  | 'symlink_not_allowed'
  | 'not_a_file'
  | 'not_found';

export class NotebookError extends Error {
  readonly code: NotebookErrorCode;

  constructor(code: NotebookErrorCode, message: string) {
    super(message);
    this.name = 'NotebookError';
    this.code = code;
  }
}

export interface NotebookEntry {
  path: string;
  size: number;
  modifiedAt: number;
}

function isInside(parent: string, child: string): boolean {
  const left = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const right = process.platform === 'win32' ? child.toLowerCase() : child;
  return right === left || right.startsWith(left + path.sep);
}

/**
 * Turns a requested notebook path into an absolute path inside
 * AGENTS/<name>/notebook. Absolute paths, drive letters, `..` and anything
 * that resolves outside the notebook are refused before any file is touched.
 */
export function resolveNotebookPath(paths: RuntimePaths, agentName: string, requested: string): string {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new NotebookError('empty_path', 'a notebook path is required');
  }
  if (requested.includes('\0')) {
    throw new NotebookError('empty_path', 'a notebook path may not contain a null byte');
  }
  if (/^[a-zA-Z]:/.test(requested)) {
    throw new NotebookError('drive_letter', 'drive letters are not allowed in notebook paths');
  }
  if (path.isAbsolute(requested) || requested.startsWith('/') || requested.startsWith('\\')) {
    throw new NotebookError('absolute_path', 'absolute paths are not allowed in the notebook');
  }
  const segments = requested.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === '..') {
      throw new NotebookError('parent_traversal', 'parent traversal is not allowed in the notebook');
    }
  }
  const base = agentNotebookDir(paths, agentName);
  const resolved = path.resolve(base, requested);
  if (!isInside(base, resolved)) {
    throw new NotebookError('outside_notebook', 'the path resolves outside the notebook');
  }
  return resolved;
}

/**
 * Refuses symlinked components and re-checks the resolved real parent, so a
 * link planted inside the notebook cannot be used to read or write outside it.
 */
function assertNoSymlinkEscape(baseDir: string, target: string): void {
  const baseReal = realpathSync(baseDir);
  const relative = path.relative(baseDir, target);
  let current = baseDir;
  for (const segment of relative.split(path.sep)) {
    if (segment === '') {
      continue;
    }
    current = path.join(current, segment);
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) {
        throw new NotebookError('symlink_not_allowed', 'symbolic links are not allowed in the notebook');
      }
    }
  }
  const parent = path.dirname(target);
  const parentReal = existsSync(parent) ? realpathSync(parent) : baseReal;
  if (!isInside(baseReal, parentReal)) {
    throw new NotebookError('outside_notebook', 'the path resolves outside the notebook');
  }
}

function walkNotebook(base: string, current: string, out: NotebookEntry[]): void {
  const entries = readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walkNotebook(base, full, out);
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new NotebookError('symlink_not_allowed', 'symbolic links are not allowed in the notebook');
    }
    const info = lstatSync(full);
    out.push({
      path: path.relative(base, full).split(path.sep).join('/'),
      size: info.size,
      modifiedAt: info.mtimeMs,
    });
  }
}

export function listNotebook(paths: RuntimePaths, agentName: string): NotebookEntry[] {
  const base = agentNotebookDir(paths, agentName);
  mkdirSync(base, { recursive: true });
  const out: NotebookEntry[] = [];
  walkNotebook(base, base, out);
  out.sort((left, right) => left.path.localeCompare(right.path));
  return out;
}

export function readNotebookFile(paths: RuntimePaths, agentName: string, requested: string): string {
  const base = agentNotebookDir(paths, agentName);
  mkdirSync(base, { recursive: true });
  const target = resolveNotebookPath(paths, agentName, requested);
  assertNoSymlinkEscape(base, target);
  if (!existsSync(target)) {
    throw new NotebookError('not_found', `no such notebook file: ${requested}`);
  }
  const info = lstatSync(target);
  if (!info.isFile()) {
    throw new NotebookError('not_a_file', `not a notebook file: ${requested}`);
  }
  return readFileSync(target, 'utf8');
}

export function writeNotebookFile(
  paths: RuntimePaths,
  agentName: string,
  requested: string,
  content: string,
): string {
  if (typeof content !== 'string') {
    throw new NotebookError('not_a_file', 'notebook content must be text');
  }
  const base = agentNotebookDir(paths, agentName);
  mkdirSync(base, { recursive: true });
  const target = resolveNotebookPath(paths, agentName, requested);
  mkdirSync(path.dirname(target), { recursive: true });
  assertNoSymlinkEscape(base, target);
  writeFileSync(target, content, 'utf8');
  return path.relative(base, target).split(path.sep).join('/');
}
