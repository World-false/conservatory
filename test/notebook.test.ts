import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentNotebookDir } from '../src/config';
import {
  listNotebook,
  NotebookError,
  readNotebookFile,
  resolveNotebookPath,
  writeNotebookFile,
} from '../src/organs/notebook';
import { birthAgent, createHarness, type Harness } from './helpers';

function expectRefusal(h: Harness, requested: string, code: string): void {
  expect(() => resolveNotebookPath(h.paths, 'ada', requested)).toThrowError(NotebookError);
  try {
    resolveNotebookPath(h.paths, 'ada', requested);
  } catch (error) {
    expect(error).toBeInstanceOf(NotebookError);
    if (error instanceof NotebookError) {
      expect(error.code).toBe(code);
    }
  }
}

describe('the notebook is confined to the agent home', () => {
  it('accepts ordinary relative paths and refuses every escape', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const base = agentNotebookDir(h.paths, 'ada');

      expect(resolveNotebookPath(h.paths, 'ada', 'notes/todo.txt')).toBe(
        path.join(base, 'notes', 'todo.txt'),
      );
      expect(resolveNotebookPath(h.paths, 'ada', 'a\\b.txt')).toBe(path.join(base, 'a', 'b.txt'));

      expectRefusal(h, '../MEMORY', 'parent_traversal');
      expectRefusal(h, '..\\..\\SUPERVISOR', 'parent_traversal');
      expectRefusal(h, 'notes/../../MEMORY', 'parent_traversal');
      expectRefusal(h, '..', 'parent_traversal');
      expectRefusal(h, 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'drive_letter');
      expectRefusal(h, 'D:/other/file.txt', 'drive_letter');
      expectRefusal(h, '/etc/passwd', 'absolute_path');
      expectRefusal(h, '\\Windows\\hosts', 'absolute_path');
      expectRefusal(h, '', 'empty_path');
      expectRefusal(h, '   ', 'empty_path');
      expectRefusal(h, 'bad\0name', 'empty_path');
    } finally {
      h.cleanup();
    }
  });

  it('refuses to read or write through those paths and leaves no file behind', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const base = agentNotebookDir(h.paths, 'ada');
      const target = path.join(base, '..', 'MEMORY');

      expect(() => writeNotebookFile(h.paths, 'ada', '../MEMORY', 'overwritten')).toThrowError(NotebookError);
      expect(() => readNotebookFile(h.paths, 'ada', '../MEMORY')).toThrowError(NotebookError);
      expect(readFileSync(target, 'utf8')).toContain('Name: ada');
      expect(h.root.length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it('writes, lists and reads files inside the notebook', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const stored = writeNotebookFile(h.paths, 'ada', 'notes/todo.txt', 'buy bread');
      expect(stored).toBe('notes/todo.txt');
      expect(readNotebookFile(h.paths, 'ada', 'notes/todo.txt')).toBe('buy bread');

      writeNotebookFile(h.paths, 'ada', 'second.txt', 'more');
      const files = listNotebook(h.paths, 'ada').map((file) => file.path);
      expect(files).toEqual(['notes/todo.txt', 'second.txt']);
      expect(existsSync(path.join(agentNotebookDir(h.paths, 'ada'), 'notes', 'todo.txt'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('reports a missing file and a directory in place of a file', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      expect(() => readNotebookFile(h.paths, 'ada', 'nope.txt')).toThrowError(NotebookError);
      mkdirSync(path.join(agentNotebookDir(h.paths, 'ada'), 'folder'), { recursive: true });
      try {
        readNotebookFile(h.paths, 'ada', 'folder');
        throw new Error('reading a directory should have failed');
      } catch (error) {
        expect(error).toBeInstanceOf(NotebookError);
        if (error instanceof NotebookError) {
          expect(error.code).toBe('not_a_file');
        }
      }
    } finally {
      h.cleanup();
    }
  });

  it('refuses a directory link that points outside the notebook', () => {
    const h = createHarness();
    const outside = mkdtempSync(path.join(tmpdir(), 'conservatory-outside-'));
    try {
      birthAgent(h, 'ada');
      writeFileSync(path.join(outside, 'secret.txt'), 'outside', 'utf8');
      const linkPath = path.join(agentNotebookDir(h.paths, 'ada'), 'escape');
      try {
        symlinkSync(outside, linkPath, 'junction');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // Creating a link needs privileges on some Windows setups; nothing to test there.
        expect(detail.length).toBeGreaterThan(0);
        return;
      }
      try {
        readNotebookFile(h.paths, 'ada', 'escape/secret.txt');
        throw new Error('reading through a link should have failed');
      } catch (error) {
        expect(error).toBeInstanceOf(NotebookError);
        if (error instanceof NotebookError) {
          expect(error.code).toBe('symlink_not_allowed');
        }
      }
      expect(() => writeNotebookFile(h.paths, 'ada', 'escape/new.txt', 'nope')).toThrowError(NotebookError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      h.cleanup();
    }
  });
});
