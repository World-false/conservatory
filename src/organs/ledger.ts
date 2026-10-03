import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
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

export interface RoundRecord {
  id: number;
  agent: string;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
}

export type UsageSource = 'agent' | 'memory';

export interface UsageRecord {
  id: number;
  agent: string;
  round: number | null;
  source: UsageSource;
  promptTokens: number | null;
  completionTokens: number | null;
  at: number;
}

export type InterventionKind = 'give_balance' | 'give_satiety';

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

const INTERVENTION_KINDS: readonly InterventionKind[] = ['give_balance', 'give_satiety'];

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
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage (agent, source);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient, read_at);
CREATE INDEX IF NOT EXISTS idx_balance_events_agent ON balance_events (agent);
CREATE INDEX IF NOT EXISTS idx_rounds_agent ON rounds (agent, started_at);
CREATE TRIGGER IF NOT EXISTS balance_events_no_update
BEFORE UPDATE ON balance_events
BEGIN
  SELECT RAISE(ABORT, 'balance_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS balance_events_no_delete
BEFORE DELETE ON balance_events
BEGIN
  SELECT RAISE(ABORT, 'balance_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS interventions_no_update
BEFORE UPDATE ON interventions
BEGIN
  SELECT RAISE(ABORT, 'interventions is append-only');
END;
CREATE TRIGGER IF NOT EXISTS interventions_no_delete
BEFORE DELETE ON interventions
BEGIN
  SELECT RAISE(ABORT, 'interventions is append-only');
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

  /** Returns to open, and clears the claim. */
  returnTaskToBoard(id: string, at: number): boolean {
    return this.reviewTask(id, ['submitted'], 'open', 'returned', at, null, true);
  }

  /** Claim timeout: a claim left undone goes back to the board. */
  expireClaimedTasks(now: number, timeoutMs: number): { taskId: string; agent: string }[] {
    return this.transaction(() => {
      const cutoff = now - timeoutMs;
      const rows = this.db
        .prepare(
          `SELECT id, claimed_by FROM tasks
           WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
        )
        .all(cutoff);
      const expired: { taskId: string; agent: string }[] = [];
      const update = this.db.prepare(
        `UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'claimed'`,
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
