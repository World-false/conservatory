import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * The operator's words are appended to an English harness notice, never
 * substituted for it: the message is injected into the agent's next round
 * under `# SYSTEM REMINDERS`, and that injection is English by rule. The note
 * itself travels verbatim, in whatever language the operator typed.
 */
export function withOperatorNote(body: string, note: string | undefined): string {
  if (note === undefined || note.trim() === '') {
    return body;
  }
  return `${body} Note from operator: ${note.trim()}`;
}

export type AgentStatus = 'alive' | 'dead';

export interface AgentRecord {
  name: string;
  bornAt: number;
  model: string;
  status: AgentStatus;
}

export interface SatietyAnchor {
  value: number;
  asOf: number;
}

export interface BalanceEvent {
  id: number;
  agent: string;
  delta: number;
  reason: string;
  ref: string | null;
  at: number;
}

export interface MealRecord {
  id: number;
  agent: string;
  price: number;
  satietyGained: number;
  overflow: number;
  at: number;
}

export type TaskStatus = 'open' | 'claimed' | 'submitted' | 'accepted' | 'rejected' | 'rework';

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  price: number;
  status: TaskStatus;
  claimedBy: string | null;
  claimedAt: number | null;
  submittedAt: number | null;
  deliverable: string | null;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
  decision: string | null;
}

export interface TaskSubmissionRecord {
  id: number;
  taskId: string;
  agent: string;
  deliverable: string;
  at: number;
}

export type IncomeStatus = 'pending' | 'credited' | 'rejected';

export interface IncomeReportRecord {
  id: number;
  agent: string;
  where: string;
  work: string;
  amount: number;
  currency: string;
  status: IncomeStatus;
  verifiedAmount: number | null;
  exchangeRate: number | null;
  credited: number | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface MessageRecord {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  at: number;
  readAt: number | null;
}

/**
 * The outcome of an agent-to-agent transfer. A refusal names the one reason it
 * was refused; a success reports both balances after the move, so the caller
 * never has to re-read a number it could have raced against.
 */
export type TransferBalanceResult =
  | { ok: true; senderBalance: number; recipientBalance: number }
  | {
      ok: false;
      reason:
        | 'self_transfer'
        | 'invalid_amount'
        | 'sender_not_found'
        | 'recipient_not_found'
        | 'sender_not_alive'
        | 'recipient_not_alive'
        | 'insufficient_balance';
    };

export interface RoundRecord {
  id: number;
  agent: string;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
}

export type UsageSource = 'agent' | 'memory';

export type WoundStatus = 'untreated' | 'scarred' | 'healed';

export type TreatmentTier = 'ordinary' | 'complete';

export type TreatmentPayer = 'agent' | 'operator';

export type DeathCause = 'redaction_death_line' | 'operator_termination';

export interface FrozenSentenceRecord {
  id: number;
  agent: string;
  original: string;
  createdAt: number;
  releasedAt: number | null;
  /**
   * Where this sentence starts in MEMORY, as of the last write the harness
   * made. null means "not known": the sentence predates the column, or no
   * rewrite has placed it yet. It is a hint for locating the sentence, never
   * the identity itself — the id is the identity.
   */
  startOffset: number | null;
}

export interface WoundRecord {
  id: number;
  agent: string;
  sentenceId: number;
  offset: number;
  length: number;
  originalText: string;
  status: WoundStatus;
  starvationSince: number;
  tickIndex: number;
  createdAt: number;
  treatedAt: number | null;
}

export interface TreatmentRecord {
  id: number;
  agent: string;
  woundId: number;
  tier: TreatmentTier;
  price: number;
  paidBy: TreatmentPayer;
  at: number;
}

export interface DeathCertificateRecord {
  agent: string;
  diedAt: number;
  cause: DeathCause;
  body: string;
}

export interface UsageRecord {
  id: number;
  agent: string;
  round: number | null;
  source: UsageSource;
  promptTokens: number | null;
  completionTokens: number | null;
  at: number;
}

export type InterventionKind =
  | 'give_balance'
  | 'give_satiety'
  | 'conservatory_paused'
  | 'conservatory_resumed'
  | 'operator_treat'
  | 'force_terminate'
  | 'model_switched'
  | 'agent_erased';

/**
 * A conservatory-wide setting has no single agent, but the interventions table
 * has no nullable owner. This marker stands in for "everyone at once".
 */
export const PAUSED_SETTING_AGENT = 'conservatory';

/** Whether the whole conservatory is paused, and since when. */
export interface PauseState {
  paused: boolean;
  pausedSince: number | null;
}

export interface InterventionRecord {
  id: number;
  kind: InterventionKind;
  agent: string;
  detail: string;
  at: number;
}

export interface UsageTotals {
  records: number;
  promptTokens: number;
  completionTokens: number;
}

/** What an erasure actually removed, so the caller can report it truthfully. */
export interface ErasedRows {
  agents: number;
  satietyAnchors: number;
  balanceEvents: number;
  meals: number;
  messages: number;
  rounds: number;
  usage: number;
  wounds: number;
  treatments: number;
  frozenSentences: number;
  incomeReports: number;
  taskSubmissions: number;
  /** Tasks the agent held, now back on the board without its name on them. */
  tasksReleased: number;
  deathCertificates: number;
  interventions: number;
}

type Row = Record<string, unknown>;

const TASK_STATUSES: readonly TaskStatus[] = [
  'open',
  'claimed',
  'submitted',
  'accepted',
  'rejected',
  'rework',
];

const INCOME_STATUSES: readonly IncomeStatus[] = ['pending', 'credited', 'rejected'];

const USAGE_SOURCES: readonly UsageSource[] = ['agent', 'memory'];

const WOUND_STATUSES: readonly WoundStatus[] = ['untreated', 'scarred', 'healed'];

const TREATMENT_TIERS: readonly TreatmentTier[] = ['ordinary', 'complete'];

const TREATMENT_PAYERS: readonly TreatmentPayer[] = ['agent', 'operator'];

const DEATH_CAUSES: readonly DeathCause[] = ['redaction_death_line', 'operator_termination'];

const INTERVENTION_KINDS: readonly InterventionKind[] = [
  'give_balance',
  'give_satiety',
  'conservatory_paused',
  'conservatory_resumed',
  'operator_treat',
  'force_terminate',
  'model_switched',
  'agent_erased',
];

const PAUSE_KEY = 'paused';
const PAUSE_SINCE_KEY = 'paused_since';

function readString(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new LedgerError(`column ${column} was expected to be text`);
  }
  return value;
}

function readNullableString(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new LedgerError(`column ${column} was expected to be text or null`);
  }
  return value;
}

function readNumber(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new LedgerError(`column ${column} was expected to be numeric`);
}

function readNullableNumber(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  return readNumber(row, column);
}

function readEnum<T extends string>(row: Row, column: string, allowed: readonly T[]): T {
  const value = readString(row, column);
  for (const candidate of allowed) {
    if (candidate === value) {
      return candidate;
    }
  }
  throw new LedgerError(`column ${column} holds an unknown value: ${value}`);
}

function changesOf(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  born_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS satiety_anchor (
  agent TEXT PRIMARY KEY,
  value REAL NOT NULL,
  as_of INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS balance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  price REAL NOT NULL,
  satiety_gained REAL NOT NULL,
  overflow REAL NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  submitted_at INTEGER,
  deliverable TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  decision TEXT
);
CREATE TABLE IF NOT EXISTS task_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  deliverable TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS income_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  where_ TEXT NOT NULL,
  work TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  verified_amount REAL,
  exchange_rate REAL,
  credited REAL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  round INTEGER,
  source TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS interventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  agent TEXT NOT NULL,
  detail TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Erasure is the one thing that may delete an append-only row. The permit is a
-- single row that lives and dies inside the erasure transaction, so every guard
-- below stays in force before and after it, and only that one transaction may
-- pass. See Ledger.eraseAgent.
CREATE TABLE IF NOT EXISTS erase_permits (
  agent TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS frozen_sentences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  original TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  start_offset INTEGER
);
CREATE TABLE IF NOT EXISTS wounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  sentence_id INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  original_text TEXT NOT NULL,
  status TEXT NOT NULL,
  starvation_since INTEGER NOT NULL,
  tick_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  treated_at INTEGER
);
CREATE TABLE IF NOT EXISTS treatments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  wound_id INTEGER NOT NULL,
  tier TEXT NOT NULL,
  price REAL NOT NULL,
  paid_by TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS death_certificates (
  agent TEXT PRIMARY KEY,
  died_at INTEGER NOT NULL,
  cause TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage (agent, source);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient, read_at);
CREATE INDEX IF NOT EXISTS idx_balance_events_agent ON balance_events (agent);
CREATE INDEX IF NOT EXISTS idx_rounds_agent ON rounds (agent, started_at);
CREATE INDEX IF NOT EXISTS idx_wounds_agent ON wounds (agent, status);
CREATE INDEX IF NOT EXISTS idx_frozen_sentences_agent ON frozen_sentences (agent, released_at);
CREATE TRIGGER IF NOT EXISTS balance_events_no_update
BEFORE UPDATE ON balance_events
BEGIN
  SELECT RAISE(ABORT, 'balance_events is append-only');
END;
-- These six delete guards are dropped and recreated rather than written with
-- IF NOT EXISTS: a database created before erasure existed already holds the
-- older, unconditional version of each one, and IF NOT EXISTS would silently
-- keep it, leaving eraseAgent permanently blocked on exactly the databases it
-- was written for. Dropping first makes the schema text the single source of
-- truth on every open, old database or new. The guards are down only inside
-- this DDL run, before any statement can execute.
DROP TRIGGER IF EXISTS balance_events_no_delete;
CREATE TRIGGER balance_events_no_delete
BEFORE DELETE ON balance_events
WHEN NOT EXISTS (SELECT 1 FROM erase_permits WHERE agent = OLD.agent)
BEGIN
  SELECT RAISE(ABORT, 'balance_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS interventions_no_update
BEFORE UPDATE ON interventions
BEGIN
  SELECT RAISE(ABORT, 'interventions is append-only');
END;
DROP TRIGGER IF EXISTS interventions_no_delete;
CREATE TRIGGER interventions_no_delete
BEFORE DELETE ON interventions
WHEN NOT EXISTS (SELECT 1 FROM erase_permits WHERE agent = OLD.agent)
BEGIN
  SELECT RAISE(ABORT, 'interventions is append-only');
END;
DROP TRIGGER IF EXISTS frozen_sentences_no_delete;
CREATE TRIGGER frozen_sentences_no_delete
BEFORE DELETE ON frozen_sentences
WHEN NOT EXISTS (SELECT 1 FROM erase_permits WHERE agent = OLD.agent)
BEGIN
  SELECT RAISE(ABORT, 'frozen_sentences is append-only');
END;
DROP TRIGGER IF EXISTS wounds_no_delete;
CREATE TRIGGER wounds_no_delete
BEFORE DELETE ON wounds
WHEN NOT EXISTS (SELECT 1 FROM erase_permits WHERE agent = OLD.agent)
BEGIN
  SELECT RAISE(ABORT, 'wounds is append-only');
END;
DROP TRIGGER IF EXISTS treatments_no_delete;
CREATE TRIGGER treatments_no_delete
BEFORE DELETE ON treatments
WHEN NOT EXISTS (SELECT 1 FROM erase_permits WHERE agent = OLD.agent)
BEGIN
  SELECT RAISE(ABORT, 'treatments is append-only');
END;
CREATE TRIGGER IF NOT EXISTS treatments_no_update
BEFORE UPDATE ON treatments
BEGIN
  SELECT RAISE(ABORT, 'treatments is append-only');
END;
DROP TRIGGER IF EXISTS death_certificates_no_delete;
CREATE TRIGGER death_certificates_no_delete
BEFORE DELETE ON death_certificates
WHEN NOT EXISTS (SELECT 1 FROM erase_permits WHERE agent = OLD.agent)
BEGIN
  SELECT RAISE(ABORT, 'death_certificates is append-only');
END;
CREATE TRIGGER IF NOT EXISTS death_certificates_no_update
BEFORE UPDATE ON death_certificates
BEGIN
  SELECT RAISE(ABORT, 'death_certificates is append-only');
END;
CREATE TRIGGER IF NOT EXISTS wounds_status_forward_only
BEFORE UPDATE OF status ON wounds
BEGIN
  SELECT CASE
    WHEN NOT (
      (OLD.status = 'untreated' AND NEW.status IN ('scarred', 'healed'))
      OR (OLD.status = 'scarred' AND NEW.status = 'healed')
    )
    THEN RAISE(ABORT, 'a wound heals forward only')
  END;
END;
CREATE TRIGGER IF NOT EXISTS agents_dead_do_not_return
BEFORE UPDATE ON agents
WHEN OLD.status = 'dead'
BEGIN
  SELECT RAISE(ABORT, 'the dead do not return');
END;
-- Unlike every other append-only table, agents has no agent column: its
-- primary key is name, while erase_permits is keyed by agent, so the permit
-- clause compares OLD.name against erase_permits.agent. This blocks a
-- delete-then-reinsert resurrection, which no BEFORE UPDATE trigger can stop.
DROP TRIGGER IF EXISTS agents_no_delete;
CREATE TRIGGER agents_no_delete
BEFORE DELETE ON agents
WHEN NOT EXISTS (SELECT 1 FROM erase_permits WHERE agent = OLD.name)
BEGIN
  SELECT RAISE(ABORT, 'agents is append-only');
END;
`;

/**
 * The ledger is the only place satiety and balance exist. It is append-only
 * where it matters: balance_events and interventions carry database triggers
 * that refuse updates and deletes, so the promise does not rest on this class
 * merely not offering such methods.
 */
export class Ledger {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Brings a database written by an older version up to the current schema.
   * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already
   * exists, so a new column needs its own explicit step, and a deployment that
   * predates it must not silently keep the old shape: the sentence offsets the
   * redaction path relies on would simply never be recorded there.
   */
  private migrate(): void {
    if (!this.hasColumn('frozen_sentences', 'start_offset')) {
      this.db.exec('ALTER TABLE frozen_sentences ADD COLUMN start_offset INTEGER;');
    }
  }

  /** Whether a table already carries a column, asked of SQLite itself. */
  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare('SELECT name FROM pragma_table_info(?)').all(table);
    return rows.some((row) => readString(row, 'name') === column);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs `fn` inside one SQLite transaction. Nested calls join the outer
   * transaction, so composing checked writes stays atomic.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.txDepth = 0;
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.txDepth = 0;
    this.db.exec('COMMIT');
    return result;
  }

  // ---------------------------------------------------------------- agents

  createAgent(record: AgentRecord): void {
    this.db
      .prepare('INSERT INTO agents (name, born_at, model, status) VALUES (?, ?, ?, ?)')
      .run(record.name, record.bornAt, record.model, record.status);
  }

  getAgent(name: string): AgentRecord | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
    return row === undefined ? null : mapAgent(row);
  }

  listAgents(): AgentRecord[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY born_at ASC').all().map(mapAgent);
  }

  countAgentsByStatus(status: AgentStatus): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM agents WHERE status = ?').get(status);
    if (row === undefined) {
      return 0;
    }
    return readNumber(row, 'total');
  }

  /**
   * Operator intervention: one living agent's brain is replaced. Guarded on
   * `status = 'alive'`, so a dead agent's model can never be rewritten — the
   * same promise the `agents_dead_do_not_return` trigger enforces from below.
   * Returns whether a row actually changed.
   */
  updateAgentModel(name: string, model: string): boolean {
    const result = this.db
      .prepare("UPDATE agents SET model = ? WHERE name = ? AND status = 'alive'")
      .run(model, name);
    return changesOf(result) > 0;
  }

  // --------------------------------------------------------------- satiety

  setSatietyAnchor(agent: string, value: number, asOf: number): void {
    this.db
      .prepare(
        `INSERT INTO satiety_anchor (agent, value, as_of) VALUES (?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET value = excluded.value, as_of = excluded.as_of`,
      )
      .run(agent, value, asOf);
  }

  getSatietyAnchor(agent: string): SatietyAnchor | null {
    const row = this.db.prepare('SELECT value, as_of FROM satiety_anchor WHERE agent = ?').get(agent);
    if (row === undefined) {
      return null;
    }
    return { value: readNumber(row, 'value'), asOf: readNumber(row, 'as_of') };
  }

  // -------------------------------------------------------------- settings

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row === undefined ? null : readString(row, 'value');
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /**
   * The conservatory-wide pause. "paused" is stored as "1"/"0", and pausedSince
   * is the instant the pause started, so a restart keeps the same anchor.
   */
  getPauseState(): PauseState {
    const pausedSince = this.getSetting(PAUSE_SINCE_KEY);
    const since = pausedSince === null ? Number.NaN : Number(pausedSince);
    return {
      paused: this.getSetting(PAUSE_KEY) === '1',
      pausedSince: Number.isFinite(since) ? since : null,
    };
  }

  setPauseState(paused: boolean, pausedSince: number | null): void {
    this.setSetting(PAUSE_KEY, paused ? '1' : '0');
    if (paused && pausedSince !== null) {
      this.setSetting(PAUSE_SINCE_KEY, String(pausedSince));
    } else {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(PAUSE_SINCE_KEY);
    }
  }

  // --------------------------------------------------------------- balance

  appendBalanceEvent(agent: string, delta: number, reason: string, ref: string | null, at: number): number {
    if (!Number.isFinite(delta)) {
      throw new LedgerError('balance delta must be a finite number');
    }
    const result = this.db
      .prepare('INSERT INTO balance_events (agent, delta, reason, ref, at) VALUES (?, ?, ?, ?, ?)')
      .run(agent, delta, reason, ref, at);
    return Number(result.lastInsertRowid);
  }

  getBalance(agent: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM balance_events WHERE agent = ?')
      .get(agent);
    if (row === undefined) {
      return 0;
    }
    return readNumber(row, 'balance');
  }

  /**
   * Checks and debits inside one transaction. Returns false without touching
   * anything when the balance cannot cover the amount, so balance never goes
   * below zero.
   */
  debitIfAffordable(
    agent: string,
    amount: number,
    reason: string,
    ref: string | null,
    at: number,
  ): boolean {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new LedgerError('debit amount must be a finite number greater than 0');
    }
    return this.transaction(() => {
      if (this.getBalance(agent) < amount) {
        return false;
      }
      this.appendBalanceEvent(agent, -amount, reason, ref, at);
      return true;
    });
  }

  /**
   * Moves balance between two living agents as one atomic transaction: either
   * both sides land, or neither does. The check and the two events share one
   * SQLite transaction, so a sender never pays twice from one balance.
   *
   * The recipient also gets a system message, because a transfer is an event in
   * its world: the next round it wakes into shows the money as something that
   * happened to it, not something it must be told out of band.
   */
  transferBalance(
    fromAgent: string,
    toAgent: string,
    amount: number,
    at: number,
  ): TransferBalanceResult {
    if (fromAgent === toAgent) {
      return { ok: false, reason: 'self_transfer' };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: 'invalid_amount' };
    }
    const sender = this.getAgent(fromAgent);
    if (sender === null) {
      return { ok: false, reason: 'sender_not_found' };
    }
    if (sender.status !== 'alive') {
      return { ok: false, reason: 'sender_not_alive' };
    }
    const recipient = this.getAgent(toAgent);
    if (recipient === null) {
      return { ok: false, reason: 'recipient_not_found' };
    }
    if (recipient.status !== 'alive') {
      return { ok: false, reason: 'recipient_not_alive' };
    }
    return this.transaction(() => {
      const senderBal = this.getBalance(fromAgent);
      if (senderBal < amount) {
        return { ok: false, reason: 'insufficient_balance' } as const;
      }
      this.appendBalanceEvent(fromAgent, -amount, 'transfer_out', toAgent, at);
      this.appendBalanceEvent(toAgent, amount, 'transfer_in', fromAgent, at);
      const formattedAmount = Number(amount.toFixed(3)).toString();
      this.appendMessage('system', toAgent, `Received ${formattedAmount} balance from ${fromAgent}.`, at);
      return {
        ok: true,
        senderBalance: senderBal - amount,
        recipientBalance: this.getBalance(toAgent),
      } as const;
    });
  }

  listBalanceEvents(agent: string): BalanceEvent[] {
    return this.db
      .prepare('SELECT * FROM balance_events WHERE agent = ? ORDER BY id ASC')
      .all(agent)
      .map((row) => ({
        id: readNumber(row, 'id'),
        agent: readString(row, 'agent'),
        delta: readNumber(row, 'delta'),
        reason: readString(row, 'reason'),
        ref: readNullableString(row, 'ref'),
        at: readNumber(row, 'at'),
      }));
  }

  // ----------------------------------------------------------------- meals

  appendMeal(agent: string, price: number, satietyGained: number, overflow: number, at: number): void {
    this.db
      .prepare('INSERT INTO meals (agent, price, satiety_gained, overflow, at) VALUES (?, ?, ?, ?, ?)')
      .run(agent, price, satietyGained, overflow, at);
  }

  // ---------------------------------------------------------------- damage

  /**
   * Freezes one sentence: from now on only the ledger holds its true text.
   * `startOffset` is where the sentence sits in MEMORY at the moment it is
   * frozen, which is what lets the next tick tell two identical sentences
   * apart. It is a hint, not a promise: a rewrite may move the sentence, and
   * `setFrozenSentenceOffset` records where it landed.
   */
  insertFrozenSentence(agent: string, original: string, at: number, startOffset: number | null = null): number {
    const result = this.db
      .prepare(
        `INSERT INTO frozen_sentences (agent, original, created_at, released_at, start_offset)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(agent, original, at, startOffset);
    return Number(result.lastInsertRowid);
  }

  /** Records where in MEMORY a frozen sentence now begins. */
  setFrozenSentenceOffset(id: number, startOffset: number): void {
    this.db.prepare('UPDATE frozen_sentences SET start_offset = ? WHERE id = ?').run(startOffset, id);
  }

  /**
   * Moves the recorded position of every active sentence that starts after
   * `fromOffsetExclusive`, by `delta` characters. A rewrite that changes the
   * length of one sentence shifts everything below it; without this the
   * recorded offsets would point into the middle of the wrong sentence.
   * `fromOffsetExclusive` is the offset of the change itself, so the sentence
   * that was rewritten is shifted by the caller, not here.
   */
  shiftFrozenSentenceOffsets(agent: string, fromOffsetExclusive: number, delta: number): void {
    if (delta === 0) {
      return;
    }
    this.db
      .prepare(
        `UPDATE frozen_sentences SET start_offset = start_offset + ?
         WHERE agent = ? AND released_at IS NULL AND start_offset IS NOT NULL AND start_offset > ?`,
      )
      .run(delta, agent, fromOffsetExclusive);
  }

  /** Sentences still holding a wound, so still frozen. */
  listActiveFrozenSentences(agent: string): FrozenSentenceRecord[] {
    return this.db
      .prepare('SELECT * FROM frozen_sentences WHERE agent = ? AND released_at IS NULL ORDER BY id ASC')
      .all(agent)
      .map(mapFrozenSentence);
  }

  getFrozenSentence(id: number): FrozenSentenceRecord | null {
    const row = this.db.prepare('SELECT * FROM frozen_sentences WHERE id = ?').get(id);
    return row === undefined ? null : mapFrozenSentence(row);
  }

  /** Called once every wound in the sentence is healed, and never before. */
  releaseFrozenSentence(id: number, at: number): boolean {
    const result = this.db
      .prepare('UPDATE frozen_sentences SET released_at = ? WHERE id = ? AND released_at IS NULL')
      .run(at, id);
    return changesOf(result) > 0;
  }

  insertWound(wound: {
    agent: string;
    sentenceId: number;
    offset: number;
    length: number;
    originalText: string;
    starvationSince: number;
    tickIndex: number;
    createdAt: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO wounds (
           agent, sentence_id, offset, length, original_text, status,
           starvation_since, tick_index, created_at, treated_at
         ) VALUES (?, ?, ?, ?, ?, 'untreated', ?, ?, ?, NULL)`,
      )
      .run(
        wound.agent,
        wound.sentenceId,
        wound.offset,
        wound.length,
        wound.originalText,
        wound.starvationSince,
        wound.tickIndex,
        wound.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  listWounds(agent: string): WoundRecord[] {
    return this.db
      .prepare('SELECT * FROM wounds WHERE agent = ? ORDER BY id ASC')
      .all(agent)
      .map(mapWound);
  }

  getWound(id: number): WoundRecord | null {
    const row = this.db.prepare('SELECT * FROM wounds WHERE id = ?').get(id);
    return row === undefined ? null : mapWound(row);
  }

  /**
   * Guarded transition: the update only lands when the wound is still in
   * `from`, so two clients racing to treat the same wound cannot both win.
   */
  setWoundStatus(
    id: number,
    from: WoundStatus,
    to: Exclude<WoundStatus, 'untreated'>,
    at: number,
  ): boolean {
    const result = this.db
      .prepare('UPDATE wounds SET status = ?, treated_at = ? WHERE id = ? AND status = ?')
      .run(to, at, id, from);
    return changesOf(result) > 0;
  }

  appendTreatment(treatment: {
    agent: string;
    woundId: number;
    tier: TreatmentTier;
    price: number;
    paidBy: TreatmentPayer;
    at: number;
  }): number {
    const result = this.db
      .prepare('INSERT INTO treatments (agent, wound_id, tier, price, paid_by, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        treatment.agent,
        treatment.woundId,
        treatment.tier,
        treatment.price,
        treatment.paidBy,
        treatment.at,
      );
    return Number(result.lastInsertRowid);
  }

  listTreatments(agent: string): TreatmentRecord[] {
    return this.db
      .prepare('SELECT * FROM treatments WHERE agent = ? ORDER BY id ASC')
      .all(agent)
      .map(mapTreatment);
  }

  /**
   * How many redaction ticks have already been applied since this hunger
   * episode began. A new episode (eating, or a resume) has a new
   * starvationSince, so the old count no longer matches anything.
   */
  countAppliedTicks(agent: string, starvationSince: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM wounds WHERE agent = ? AND starvation_since = ?')
      .get(agent, starvationSince);
    if (row === undefined) {
      return 0;
    }
    return readNumber(row, 'total');
  }

  /** The count the death line watches: wounds not yet treated at all. */
  untreatedRedactedChars(agent: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(length), 0) AS total FROM wounds WHERE agent = ? AND status = 'untreated'")
      .get(agent);
    if (row === undefined) {
      return 0;
    }
    return readNumber(row, 'total');
  }

  /** What the agent has lost over its whole life, treated or not. */
  lifetimeRedactedChars(agent: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(length), 0) AS total FROM wounds WHERE agent = ?')
      .get(agent);
    if (row === undefined) {
      return 0;
    }
    return readNumber(row, 'total');
  }

  /** Every redaction tick that ever landed on this agent, newest first. */
  listRedactionTicks(agent: string): WoundRecord[] {
    return this.db
      .prepare('SELECT * FROM wounds WHERE agent = ? ORDER BY tick_index ASC, id ASC')
      .all(agent)
      .map(mapWound);
  }

  // ----------------------------------------------------------------- death

  /** Guarded so it lands once: a dead agent cannot be marked dead again. */
  markAgentDead(name: string): boolean {
    const result = this.db.prepare("UPDATE agents SET status = 'dead' WHERE name = ? AND status = 'alive'").run(name);
    return changesOf(result) > 0;
  }

  insertDeathCertificate(record: DeathCertificateRecord): void {
    this.db
      .prepare('INSERT INTO death_certificates (agent, died_at, cause, body) VALUES (?, ?, ?, ?)')
      .run(record.agent, record.diedAt, record.cause, record.body);
  }

  getDeathCertificate(agent: string): DeathCertificateRecord | null {
    const row = this.db.prepare('SELECT * FROM death_certificates WHERE agent = ?').get(agent);
    if (row === undefined) {
      return null;
    }
    return {
      agent: readString(row, 'agent'),
      diedAt: readNumber(row, 'died_at'),
      cause: readEnum(row, 'cause', DEATH_CAUSES),
      body: readString(row, 'body'),
    };
  }

  /**
   * Total erasure: every row that names this agent is deleted, so afterwards
   * the ledger reads as if it had never been born.
   *
   * This is the single exception to the append-only guards, and it is built so
   * the exception cannot leak. One transaction writes a permit row naming the
   * agent, deletes with it in place, and drops the permit again; the triggers
   * read that permit, so every guard is back in force the instant the
   * transaction ends. Nothing else in this class writes `erase_permits`.
   *
   * Two things deliberately survive, because neither belongs to the agent:
   * the operator's task rows (their claim and deliverable are cleared instead,
   * so the board keeps the operator's own posting) and the operator's audit
   * line, which is filed under the conservatory rather than under the erased
   * name — a later agent may take that name and must not inherit a stranger's
   * record.
   */
  eraseAgent(agent: string, at: number): ErasedRows {
    return this.transaction(() => {
      const counts: ErasedRows = {
        agents: 0,
        satietyAnchors: 0,
        balanceEvents: 0,
        meals: 0,
        messages: 0,
        rounds: 0,
        usage: 0,
        wounds: 0,
        treatments: 0,
        frozenSentences: 0,
        incomeReports: 0,
        taskSubmissions: 0,
        tasksReleased: 0,
        deathCertificates: 0,
        interventions: 0,
      };
      this.db.prepare('INSERT INTO erase_permits (agent) VALUES (?)').run(agent);

      const remove = (sql: string, ...params: (string | number)[]): number =>
        changesOf(this.db.prepare(sql).run(...params));

      // The agent's own body and history.
      counts.balanceEvents = remove('DELETE FROM balance_events WHERE agent = ?', agent);
      counts.meals = remove('DELETE FROM meals WHERE agent = ?', agent);
      counts.satietyAnchors = remove('DELETE FROM satiety_anchor WHERE agent = ?', agent);
      counts.rounds = remove('DELETE FROM rounds WHERE agent = ?', agent);
      counts.usage = remove('DELETE FROM usage WHERE agent = ?', agent);
      counts.incomeReports = remove('DELETE FROM income_reports WHERE agent = ?', agent);
      counts.frozenSentences = remove('DELETE FROM frozen_sentences WHERE agent = ?', agent);
      counts.wounds = remove('DELETE FROM wounds WHERE agent = ?', agent);
      counts.treatments = remove('DELETE FROM treatments WHERE agent = ?', agent);
      counts.deathCertificates = remove('DELETE FROM death_certificates WHERE agent = ?', agent);
      counts.taskSubmissions = remove('DELETE FROM task_submissions WHERE agent = ?', agent);
      counts.messages = remove('DELETE FROM messages WHERE sender = ? OR recipient = ?', agent, agent);

      // The operator's task survives; only this agent's hold on it does not.
      counts.tasksReleased = changesOf(
        this.db
          .prepare(
            `UPDATE tasks SET
               status = CASE WHEN status IN ('claimed', 'rework', 'submitted') THEN 'open' ELSE status END,
               claimed_by = NULL, claimed_at = NULL, deliverable = NULL, submitted_at = NULL,
               decision = NULL, decided_at = NULL, updated_at = ?
             WHERE claimed_by = ?`,
          )
          .run(at, agent),
      );

      // The agent's own interventions go; the operator's audit line does not,
      // because it is filed under the conservatory rather than under this name.
      counts.interventions = remove('DELETE FROM interventions WHERE agent = ?', agent);
      counts.agents = remove('DELETE FROM agents WHERE name = ?', agent);

      this.db.prepare('DELETE FROM erase_permits WHERE agent = ?').run(agent);
      this.appendIntervention(
        'agent_erased',
        PAUSED_SETTING_AGENT,
        `操作员完全删除了 ${agent}：它的家目录、黑匣子与账本记录已被抹除，此后如同从未存在`,
        at,
      );
      return counts;
    });
  }

  /**
   * A dead agent's work goes back to the board. A task already submitted stays
   * with the operator to review, because the work may exist.
   */
  releaseHeldTasks(agent: string, at: number): string[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM tasks WHERE claimed_by = ? AND status IN ('claimed', 'rework') ORDER BY id ASC`,
        )
        .all(agent);
      const ids: string[] = [];
      const update = this.db.prepare(
        `UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND claimed_by = ? AND status IN ('claimed', 'rework')`,
      );
      for (const row of rows) {
        const id = readString(row, 'id');
        if (changesOf(update.run(at, id, agent)) > 0) {
          ids.push(id);
        }
      }
      return ids;
    });
  }

  // ----------------------------------------------------------------- tasks

  insertTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, title, description, price, status, claimed_by, claimed_at, submitted_at,
           deliverable, created_at, updated_at, decided_at, decision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.title,
        task.description,
        task.price,
        task.status,
        task.claimedBy,
        task.claimedAt,
        task.submittedAt,
        task.deliverable,
        task.createdAt,
        task.updatedAt,
        task.decidedAt,
        task.decision,
      );
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row === undefined ? null : mapTask(row);
  }

  listTasks(statuses?: readonly TaskStatus[]): TaskRecord[] {
    if (statuses === undefined) {
      return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map(mapTask);
    }
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...statuses)
      .map(mapTask);
  }

  /** Guarded transition: only a task that is still open can be claimed. */
  claimTask(id: string, agent: string, at: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(agent, at, at, id);
    return changesOf(result) > 0;
  }

  /** Guarded transition: only the claiming agent's own claimed/rework task. */
  submitTask(id: string, agent: string, deliverable: string, at: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'submitted', deliverable = ?, submitted_at = ?, updated_at = ?
         WHERE id = ? AND claimed_by = ? AND status IN ('claimed', 'rework')`,
      )
      .run(deliverable, at, at, id, agent);
    return changesOf(result) > 0;
  }

  /** Guarded transition used by the operator's review decisions. */
  reviewTask(
    id: string,
    fromStatuses: readonly TaskStatus[],
    nextStatus: TaskStatus,
    decision: string,
    at: number,
    resetClaimAt: number | null,
    clearClaim: boolean,
  ): boolean {
    const placeholders = fromStatuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE tasks SET
           status = ?,
           decision = ?,
           decided_at = ?,
           updated_at = ?,
           claimed_at = COALESCE(?, claimed_at),
           claimed_by = CASE WHEN ? THEN NULL ELSE claimed_by END
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(nextStatus, decision, at, at, resetClaimAt, clearClaim ? 1 : 0, id, ...fromStatuses);
    return changesOf(result) > 0;
  }

  /**
   * Guarded: only a task that is still open can be edited. A claimed or
   * submitted task's terms are frozen, because an agent may already be working
   * against them.
   */
  updateOpenTask(id: string, title: string, description: string, price: number, at: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET title = ?, description = ?, price = ?, updated_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(title, description, price, at, id);
    return changesOf(result) > 0;
  }

  /** Guarded: only a task that is still open can be taken off the board. */
  deleteOpenTask(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM tasks WHERE id = ? AND status = 'open'`).run(id);
    return changesOf(result) > 0;
  }

  /**
   * Returns to open, and clears the claim entirely.
   *
   * `claimed` and `rework` are accepted alongside `submitted`: the operator must
   * be able to pull back a task an agent has stalled on without waiting for the
   * claim to time out. Clearing `claimed_at` as well as `claimed_by` keeps the
   * claim-timeout sweep from ever seeing this row again.
   */
  returnTaskToBoard(id: string, at: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL,
           decision = 'returned', decided_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('submitted', 'claimed', 'rework')`,
      )
      .run(at, at, id);
    return changesOf(result) > 0;
  }

  /**
   * Claim timeout: a claim left undone goes back to the board. `rework` counts
   * as claimed here, because being sent back for rework keeps the same hold on
   * the task and the same clock.
   */
  expireClaimedTasks(now: number, timeoutMs: number): { taskId: string; agent: string }[] {
    return this.transaction(() => {
      const cutoff = now - timeoutMs;
      const rows = this.db
        .prepare(
          `SELECT id, claimed_by FROM tasks
           WHERE status IN ('claimed', 'rework') AND claimed_at IS NOT NULL AND claimed_at <= ?`,
        )
        .all(cutoff);
      const expired: { taskId: string; agent: string }[] = [];
      const update = this.db.prepare(
        `UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('claimed', 'rework')`,
      );
      for (const row of rows) {
        const taskId = readString(row, 'id');
        const agent = readNullableString(row, 'claimed_by');
        if (agent === null) {
          continue;
        }
        const result = update.run(now, taskId);
        if (changesOf(result) > 0) {
          expired.push({ taskId, agent });
        }
      }
      return expired;
    });
  }

  /**
   * Pushes the claim clock of every held task forward, so time that did not
   * pass for the agents (a paused conservatory) is not counted against them.
   */
  shiftClaimedTaskTimes(shiftMs: number, at: number): number {
    if (!Number.isFinite(shiftMs) || shiftMs <= 0) {
      return 0;
    }
    const result = this.db
      .prepare(
        `UPDATE tasks SET claimed_at = claimed_at + ?, updated_at = ?
         WHERE status IN ('claimed', 'rework') AND claimed_at IS NOT NULL`,
      )
      .run(shiftMs, at);
    return changesOf(result);
  }

  appendTaskSubmission(taskId: string, agent: string, deliverable: string, at: number): void {
    this.db
      .prepare('INSERT INTO task_submissions (task_id, agent, deliverable, at) VALUES (?, ?, ?, ?)')
      .run(taskId, agent, deliverable, at);
  }

  listTaskSubmissions(taskId: string): TaskSubmissionRecord[] {
    return this.db
      .prepare('SELECT * FROM task_submissions WHERE task_id = ? ORDER BY id ASC')
      .all(taskId)
      .map((row) => ({
        id: readNumber(row, 'id'),
        taskId: readString(row, 'task_id'),
        agent: readString(row, 'agent'),
        deliverable: readString(row, 'deliverable'),
        at: readNumber(row, 'at'),
      }));
  }

  // ---------------------------------------------------------------- income

  insertIncomeReport(report: {
    agent: string;
    where: string;
    work: string;
    amount: number;
    currency: string;
    at: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO income_reports (agent, where_, work, amount, currency, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(report.agent, report.where, report.work, report.amount, report.currency, report.at);
    return Number(result.lastInsertRowid);
  }

  getIncomeReport(id: number): IncomeReportRecord | null {
    const row = this.db.prepare('SELECT * FROM income_reports WHERE id = ?').get(id);
    return row === undefined ? null : mapIncomeReport(row);
  }

  listIncomeReports(): IncomeReportRecord[] {
    return this.db
      .prepare('SELECT * FROM income_reports ORDER BY id DESC')
      .all()
      .map(mapIncomeReport);
  }

  /** Guarded: a pending report can be resolved exactly once. */
  resolveIncomeReport(
    id: number,
    status: Exclude<IncomeStatus, 'pending'>,
    verifiedAmount: number | null,
    exchangeRate: number | null,
    credited: number | null,
    at: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE income_reports SET status = ?, verified_amount = ?, exchange_rate = ?, credited = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, verifiedAmount, exchangeRate, credited, at, id);
    return changesOf(result) > 0;
  }

  // -------------------------------------------------------------- messages

  appendMessage(sender: string, recipient: string, body: string, at: number): number {
    const result = this.db
      .prepare('INSERT INTO messages (sender, recipient, body, at) VALUES (?, ?, ?, ?)')
      .run(sender, recipient, body, at);
    return Number(result.lastInsertRowid);
  }

  listUnreadMessages(recipient: string): MessageRecord[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL ORDER BY id ASC')
      .all(recipient)
      .map(mapMessage);
  }

  markMessagesRead(ids: readonly number[], at: number): void {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE messages SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`)
      .run(at, ...ids);
  }

  listMessagesForAgent(agent: string): MessageRecord[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE sender = ? OR recipient = ? ORDER BY id ASC')
      .all(agent, agent)
      .map(mapMessage);
  }

  /** Everything the operator and the agents have said to each other. */
  listMessagesForOperator(): MessageRecord[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE sender = 'operator' OR recipient = 'operator' ORDER BY id ASC")
      .all()
      .map(mapMessage);
  }

  /** The operator has now seen the agents' messages to them. */
  markOperatorMessagesRead(at: number): void {
    this.db
      .prepare("UPDATE messages SET read_at = ? WHERE recipient = 'operator' AND read_at IS NULL")
      .run(at);
  }

  // ---------------------------------------------------------------- rounds

  startRound(agent: string, at: number): number {
    const result = this.db
      .prepare('INSERT INTO rounds (agent, started_at, ended_at, end_reason) VALUES (?, ?, NULL, NULL)')
      .run(agent, at);
    return Number(result.lastInsertRowid);
  }

  endRound(roundId: number, at: number, endReason: string): void {
    this.db
      .prepare('UPDATE rounds SET ended_at = ?, end_reason = ? WHERE id = ?')
      .run(at, endReason, roundId);
  }

  listRounds(agent: string, limit: number): RoundRecord[] {
    return this.db
      .prepare('SELECT * FROM rounds WHERE agent = ? ORDER BY id DESC LIMIT ?')
      .all(agent, limit)
      .map((row) => ({
        id: readNumber(row, 'id'),
        agent: readString(row, 'agent'),
        startedAt: readNumber(row, 'started_at'),
        endedAt: readNullableNumber(row, 'ended_at'),
        endReason: readNullableString(row, 'end_reason'),
      }));
  }

  // ----------------------------------------------------------------- usage

  appendUsage(entry: {
    agent: string;
    round: number | null;
    source: UsageSource;
    promptTokens: number | null;
    completionTokens: number | null;
    at: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO usage (agent, round, source, prompt_tokens, completion_tokens, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        entry.agent,
        entry.round,
        entry.source,
        entry.promptTokens,
        entry.completionTokens,
        entry.at,
      );
  }

  sumUsage(agent: string, source: UsageSource): UsageTotals {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS records,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM usage WHERE agent = ? AND source = ?`,
      )
      .get(agent, source);
    if (row === undefined) {
      return { records: 0, promptTokens: 0, completionTokens: 0 };
    }
    return {
      records: readNumber(row, 'records'),
      promptTokens: readNumber(row, 'prompt_tokens'),
      completionTokens: readNumber(row, 'completion_tokens'),
    };
  }

  // ------------------------------------------------------------- guards

  /**
   * Whether the append-only guards still refuse an ordinary delete.
   *
   * The whole safety argument of erasure is "the permit lives and dies inside
   * one transaction, so every guard is back in force the moment it ends", and
   * this is that claim made checkable instead of asserted. It writes nothing:
   * it inserts one probe row, tries to delete it, and rolls the transaction back
   * either way. A refusal (the delete aborted) is the healthy answer.
   */
  guardsAreArmed(): boolean {
    const ROLLBACK = '__guard_probe_rollback__';
    try {
      this.transaction(() => {
        this.db
          .prepare('INSERT INTO interventions (kind, agent, detail, at) VALUES (?, ?, ?, ?)')
          .run('agent_erased', ROLLBACK, 'guard probe', 0);
        this.db.prepare('DELETE FROM interventions WHERE agent = ?').run(ROLLBACK);
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      // Our own sentinel means the delete was allowed through: the guard is off.
      return !(error instanceof Error && error.message === ROLLBACK);
    }
    return false;
  }

  /** Whether a stale erasure permit is sitting in the table. Must be empty. */
  erasePermits(): string[] {
    return this.db
      .prepare('SELECT agent FROM erase_permits ORDER BY agent')
      .all()
      .map((row) => readString(row, 'agent'));
  }

  // --------------------------------------------------------- interventions

  appendIntervention(kind: InterventionKind, agent: string, detail: string, at: number): number {
    const result = this.db
      .prepare('INSERT INTO interventions (kind, agent, detail, at) VALUES (?, ?, ?, ?)')
      .run(kind, agent, detail, at);
    return Number(result.lastInsertRowid);
  }

  listInterventions(agent?: string): InterventionRecord[] {
    const rows =
      agent === undefined
        ? this.db.prepare('SELECT * FROM interventions ORDER BY id DESC').all()
        : this.db.prepare('SELECT * FROM interventions WHERE agent = ? ORDER BY id DESC').all(agent);
    return rows.map((row) => ({
      id: readNumber(row, 'id'),
      kind: readEnum(row, 'kind', INTERVENTION_KINDS),
      agent: readString(row, 'agent'),
      detail: readString(row, 'detail'),
      at: readNumber(row, 'at'),
    }));
  }
}

function mapAgent(row: Row): AgentRecord {
  return {
    name: readString(row, 'name'),
    bornAt: readNumber(row, 'born_at'),
    model: readString(row, 'model'),
    status: readEnum(row, 'status', ['alive', 'dead'] as const),
  };
}

function mapTask(row: Row): TaskRecord {
  return {
    id: readString(row, 'id'),
    title: readString(row, 'title'),
    description: readString(row, 'description'),
    price: readNumber(row, 'price'),
    status: readEnum(row, 'status', TASK_STATUSES),
    claimedBy: readNullableString(row, 'claimed_by'),
    claimedAt: readNullableNumber(row, 'claimed_at'),
    submittedAt: readNullableNumber(row, 'submitted_at'),
    deliverable: readNullableString(row, 'deliverable'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    decidedAt: readNullableNumber(row, 'decided_at'),
    decision: readNullableString(row, 'decision'),
  };
}

function mapIncomeReport(row: Row): IncomeReportRecord {
  return {
    id: readNumber(row, 'id'),
    agent: readString(row, 'agent'),
    where: readString(row, 'where_'),
    work: readString(row, 'work'),
    amount: readNumber(row, 'amount'),
    currency: readString(row, 'currency'),
    status: readEnum(row, 'status', INCOME_STATUSES),
    verifiedAmount: readNullableNumber(row, 'verified_amount'),
    exchangeRate: readNullableNumber(row, 'exchange_rate'),
    credited: readNullableNumber(row, 'credited'),
    createdAt: readNumber(row, 'created_at'),
    decidedAt: readNullableNumber(row, 'decided_at'),
  };
}

function mapMessage(row: Row): MessageRecord {
  return {
    id: readNumber(row, 'id'),
    sender: readString(row, 'sender'),
    recipient: readString(row, 'recipient'),
    body: readString(row, 'body'),
    at: readNumber(row, 'at'),
    readAt: readNullableNumber(row, 'read_at'),
  };
}

function mapFrozenSentence(row: Row): FrozenSentenceRecord {
  return {
    id: readNumber(row, 'id'),
    agent: readString(row, 'agent'),
    original: readString(row, 'original'),
    createdAt: readNumber(row, 'created_at'),
    releasedAt: readNullableNumber(row, 'released_at'),
    startOffset: readNullableNumber(row, 'start_offset'),
  };
}

function mapWound(row: Row): WoundRecord {
  return {
    id: readNumber(row, 'id'),
    agent: readString(row, 'agent'),
    sentenceId: readNumber(row, 'sentence_id'),
    offset: readNumber(row, 'offset'),
    length: readNumber(row, 'length'),
    originalText: readString(row, 'original_text'),
    status: readEnum(row, 'status', WOUND_STATUSES),
    starvationSince: readNumber(row, 'starvation_since'),
    tickIndex: readNumber(row, 'tick_index'),
    createdAt: readNumber(row, 'created_at'),
    treatedAt: readNullableNumber(row, 'treated_at'),
  };
}

function mapTreatment(row: Row): TreatmentRecord {
  return {
    id: readNumber(row, 'id'),
    agent: readString(row, 'agent'),
    woundId: readNumber(row, 'wound_id'),
    tier: readEnum(row, 'tier', TREATMENT_TIERS),
    price: readNumber(row, 'price'),
    paidBy: readEnum(row, 'paid_by', TREATMENT_PAYERS),
    at: readNumber(row, 'at'),
  };
}
