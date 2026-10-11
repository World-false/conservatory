import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/organs/ledger';
import { birthAgent, createHarness } from './helpers';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'conservatory-ledger-'));
}

describe('recording where a frozen sentence sits in MEMORY', () => {
  it('stores the offset it was frozen at, and null when the caller has none', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const withOffset = h.ledger.insertFrozenSentence('ada', 'I remember the garden.', h.clock.now(), 41);
      const withoutOffset = h.ledger.insertFrozenSentence('ada', 'I remember the garden.', h.clock.now());

      expect(h.ledger.getFrozenSentence(withOffset)?.startOffset).toBe(41);
      expect(h.ledger.getFrozenSentence(withoutOffset)?.startOffset).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('moves a sentence to a new offset without releasing it', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const id = h.ledger.insertFrozenSentence('ada', 'A lost sentence.', h.clock.now(), 10);
      h.ledger.setFrozenSentenceOffset(id, 99);

      const record = h.ledger.getFrozenSentence(id);
      expect(record?.startOffset).toBe(99);
      expect(record?.releasedAt).toBeNull();
      expect(h.ledger.listActiveFrozenSentences('ada').length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('shifts only the active sentences that start after the change', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const above = h.ledger.insertFrozenSentence('ada', 'Above the change.', h.clock.now(), 10);
      const atTheChange = h.ledger.insertFrozenSentence('ada', 'Exactly at it.', h.clock.now(), 20);
      const below = h.ledger.insertFrozenSentence('ada', 'Below the change.', h.clock.now(), 30);
      const unknown = h.ledger.insertFrozenSentence('ada', 'No offset known.', h.clock.now());
      const released = h.ledger.insertFrozenSentence('ada', 'Already healed.', h.clock.now(), 40);
      h.ledger.releaseFrozenSentence(released, h.clock.now());

      h.ledger.shiftFrozenSentenceOffsets('ada', 20, -5);

      // Only what is strictly after the offset, active, and known.
      expect(h.ledger.getFrozenSentence(above)?.startOffset).toBe(10);
      expect(h.ledger.getFrozenSentence(atTheChange)?.startOffset).toBe(20);
      expect(h.ledger.getFrozenSentence(below)?.startOffset).toBe(25);
      expect(h.ledger.getFrozenSentence(unknown)?.startOffset).toBeNull();
      expect(h.ledger.getFrozenSentence(released)?.startOffset).toBe(40);
    } finally {
      h.cleanup();
    }
  });

  it('leaves every offset alone when the shift is zero', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const id = h.ledger.insertFrozenSentence('ada', 'A lost sentence.', h.clock.now(), 10);
      h.ledger.shiftFrozenSentenceOffsets('ada', 0, 0);
      expect(h.ledger.getFrozenSentence(id)?.startOffset).toBe(10);
    } finally {
      h.cleanup();
    }
  });
});

describe('opening a ledger written before start_offset existed', () => {
  it('adds the column to the old table and keeps the rows it held', () => {
    const root = tempDir();
    const dbPath = path.join(root, 'ledger.db');
    try {
      // The shape the column was introduced after, with a row already in it.
      const old = new DatabaseSync(dbPath);
      old.exec(`
        CREATE TABLE frozen_sentences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent TEXT NOT NULL,
          original TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          released_at INTEGER
        );
      `);
      old
        .prepare('INSERT INTO frozen_sentences (agent, original, created_at, released_at) VALUES (?, ?, ?, NULL)')
        .run('ada', 'A sentence from before the column.', 1234);
      old.close();

      const ledger = new Ledger(dbPath);
      try {
        const rows = ledger.listActiveFrozenSentences('ada');
        expect(rows.length).toBe(1);
        expect(rows[0].original).toBe('A sentence from before the column.');
        expect(rows[0].createdAt).toBe(1234);
        // The migration ran, so the column is there and reads as "unknown".
        expect(rows[0].startOffset).toBeNull();

        // And it is writable, which is the point of migrating at all.
        ledger.setFrozenSentenceOffset(rows[0].id, 77);
        expect(ledger.getFrozenSentence(rows[0].id)?.startOffset).toBe(77);
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('is idempotent, so a second open changes nothing', () => {
    const root = tempDir();
    const dbPath = path.join(root, 'ledger.db');
    try {
      const first = new Ledger(dbPath);
      first.insertFrozenSentence('ada', 'A sentence.', 1, 5);
      first.close();

      const second = new Ledger(dbPath);
      try {
        expect(second.listActiveFrozenSentences('ada')[0].startOffset).toBe(5);
      } finally {
        second.close();
      }
      const third = new Ledger(dbPath);
      try {
        expect(third.listActiveFrozenSentences('ada')[0].startOffset).toBe(5);
      } finally {
        third.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
