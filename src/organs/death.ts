import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentHomeDir, type ConservatoryValues, type RuntimePaths } from '../config';
import type { Blackbox } from './blackbox';
import { PAUSED_SETTING_AGENT, type DeathCause, type Ledger } from './ledger';

export const DEATH_CERTIFICATE_FILE = 'DEATH_CERTIFICATE.md';

/** Facts only. No transcript, no tool arguments, no model text. */
export interface DeathCertificateBody {
  name: string;
  model: string;
  bornAt: number;
  diedAt: number;
  cause: DeathCause;
  finalBalance: number;
  lifetimeRedactedChars: number;
  untreatedRedactedChars: number;
  deathLineChars: number;
  treatments: {
    ordinary: number;
    complete: number;
    paidByAgent: number;
    paidByOperator: number;
  };
  lastActions: {
    round: number | null;
    startedAt: number | null;
    endedAt: number | null;
    endReason: string | null;
    toolCalls: Record<string, number>;
  }[];
  openCommitments: {
    tasks: { id: string; title: string }[];
    pendingIncomeReports: number[];
  };
  interventions: { kind: string; at: number; detail: string }[];
  /**
   * Where the dead agent's black box was copied, relative to the conservatory
   * root. Null when it had written nothing yet.
   */
  blackboxArchive: string | null;
}

export interface DeathDeps {
  ledger: Ledger;
  values: ConservatoryValues;
  paths: RuntimePaths;
  blackbox: Blackbox;
  now(): number;
  /** Stops the agent's own process and drops it from the supervisor's map. */
  stopProcess(agent: string): void;
  /** Operator-facing Chinese notice for the console. */
  onNotice(agent: string, message: string): void;
}

export type DeathOutcome =
  | { ok: true; body: DeathCertificateBody; releasedTasks: string[] }
  | { ok: false; error: 'agent_not_found' | 'already_dead' };

function toolCallCounts(entries: readonly { kind: string; [key: string]: unknown }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.kind !== 'tool_call') {
      continue;
    }
    const name = entry['name'];
    if (typeof name !== 'string') {
      continue;
    }
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/**
 * The last few rounds as numbers and names only: when each ran, why it ended,
 * and how many times each tool was called. The black box holds the text; the
 * certificate holds the shape.
 *
 * A black box is evidence, and evidence can be damaged: a half-written line
 * after a power cut is exactly the case a death certificate exists for. A
 * reader that throws here would cancel the death it was called to record, so a
 * damaged log yields a certificate with no final actions instead. Retention is
 * the black box's own promise; the death is the body's, and the body decides.
 */
function summariseLastRounds(
  blackbox: Blackbox,
  agent: string,
  roundCount: number,
): DeathCertificateBody['lastActions'] {
  let rounds;
  try {
    rounds = blackbox.readRecentRounds(agent, roundCount);
  } catch {
    return [];
  }
  return rounds.map((group) => {
    const start = group.entries.find((entry) => entry.kind === 'round_start');
    const end = group.entries.find((entry) => entry.kind === 'round_end');
    const reason = end === undefined ? null : end['endReason'];
    return {
      round: group.round,
      startedAt: start === undefined ? null : start.at,
      endedAt: end === undefined ? null : end.at,
      endReason: typeof reason === 'string' ? reason : null,
      toolCalls: toolCallCounts(group.entries),
    };
  });
}

function buildBody(
  deps: DeathDeps,
  agent: string,
  cause: DeathCause,
  at: number,
  blackboxArchive: string | null,
): DeathCertificateBody | null {
  const record = deps.ledger.getAgent(agent);
  if (record === null) {
    return null;
  }
  const treatments = deps.ledger.listTreatments(agent);
  const held = deps.ledger
    .listTasks(['claimed', 'rework', 'submitted'])
    .filter((task) => task.claimedBy === agent)
    .map((task) => ({ id: task.id, title: task.title }));
  const pendingIncomeReports = deps.ledger
    .listIncomeReports()
    .filter((report) => report.agent === agent && report.status === 'pending')
    .map((report) => report.id);
  const global = deps.ledger
    .listInterventions(PAUSED_SETTING_AGENT)
    .filter((row) => row.kind === 'conservatory_paused' || row.kind === 'conservatory_resumed');
  const interventions = [...deps.ledger.listInterventions(agent), ...global]
    .map((row) => ({ kind: row.kind, at: row.at, detail: row.detail }))
    .sort((left, right) => left.at - right.at);

  return {
    name: record.name,
    model: record.model,
    bornAt: record.bornAt,
    diedAt: at,
    cause,
    finalBalance: deps.ledger.getBalance(agent),
    lifetimeRedactedChars: deps.ledger.lifetimeRedactedChars(agent),
    untreatedRedactedChars: deps.ledger.untreatedRedactedChars(agent),
    deathLineChars: deps.values.deathLineChars,
    treatments: {
      ordinary: treatments.filter((row) => row.tier === 'ordinary').length,
      complete: treatments.filter((row) => row.tier === 'complete').length,
      paidByAgent: treatments.filter((row) => row.paidBy === 'agent').length,
      paidByOperator: treatments.filter((row) => row.paidBy === 'operator').length,
    },
    lastActions: summariseLastRounds(deps.blackbox, agent, 3),
    openCommitments: { tasks: held, pendingIncomeReports },
    interventions,
    blackboxArchive,
  };
}

/** The certificate as a file: the same facts as the ledger row, for a person. */
export function renderDeathCertificate(body: DeathCertificateBody): string {
  const lines: string[] = [];
  lines.push(`# Death Certificate — ${body.name}`);
  lines.push('');
  lines.push(`- Name: ${body.name}`);
  lines.push(`- Model: ${body.model}`);
  lines.push(`- Born: ${new Date(body.bornAt).toISOString()}`);
  lines.push(`- Died: ${new Date(body.diedAt).toISOString()}`);
  lines.push(`- Cause of death: ${body.cause}`);
  lines.push(`- Final balance: ${body.finalBalance}`);
  lines.push(`- Lifetime redacted characters: ${body.lifetimeRedactedChars}`);
  lines.push(`- Untreated redacted characters at death: ${body.untreatedRedactedChars}`);
  lines.push(`- Death line: ${body.deathLineChars}`);
  lines.push(
    `- Black box archive: ${body.blackboxArchive === null ? '(nothing was logged)' : body.blackboxArchive}`,
  );
  lines.push('');
  lines.push('## Treatment records');
  lines.push(`- Ordinary treatments: ${body.treatments.ordinary}`);
  lines.push(`- Complete treatments: ${body.treatments.complete}`);
  lines.push(`- Paid by the agent: ${body.treatments.paidByAgent}`);
  lines.push(`- Paid by the operator: ${body.treatments.paidByOperator}`);
  lines.push('');
  lines.push('## Final actions (names and counts only)');
  if (body.lastActions.length === 0) {
    lines.push('- (no rounds recorded)');
  }
  for (const action of body.lastActions) {
    const started = action.startedAt === null ? '(unknown)' : new Date(action.startedAt).toISOString();
    const ended = action.endedAt === null ? '(unknown)' : new Date(action.endedAt).toISOString();
    lines.push(`- Round ${String(action.round)}: started ${started}, ended ${ended}, reason ${action.endReason ?? '(unknown)'}`);
    const names = Object.keys(action.toolCalls).sort();
    if (names.length === 0) {
      lines.push('  - tool calls: (none)');
    } else {
      for (const name of names) {
        lines.push(`  - ${name}: ${action.toolCalls[name]}`);
      }
    }
  }
  lines.push('');
  lines.push('## Open commitments');
  if (body.openCommitments.tasks.length === 0) {
    lines.push('- No held task.');
  }
  for (const task of body.openCommitments.tasks) {
    lines.push(`- Task ${task.id}: ${task.title}`);
  }
  if (body.openCommitments.pendingIncomeReports.length === 0) {
    lines.push('- No income report awaiting review.');
  } else {
    lines.push(`- Income reports awaiting review: ${body.openCommitments.pendingIncomeReports.join(', ')}`);
  }
  lines.push('');
  lines.push('## Operator interventions');
  if (body.interventions.length === 0) {
    lines.push('- (none)');
  }
  for (const row of body.interventions) {
    lines.push(`- ${new Date(row.at).toISOString()} | ${row.kind} | ${row.detail}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Death, once and for all. The ledger transaction marks the agent dead, sends
 * its held work back to the board and files the certificate; then the process
 * is stopped, the black box keeps its own record (it is never deleted), and the
 * certificate is written into the agent's own folder. There is no path back.
 */
export function die(deps: DeathDeps, agent: string, cause: DeathCause, at: number): DeathOutcome {
  const record = deps.ledger.getAgent(agent);
  if (record === null) {
    return { ok: false, error: 'agent_not_found' };
  }
  if (record.status !== 'alive') {
    return { ok: false, error: 'already_dead' };
  }
  // Archived first, so the certificate can name the copy. A black box that
  // cannot be copied must not block a death — the death is the body's fact and
  // the copy is evidence about it — so a failure is reported and the certificate
  // says there is no archive.
  let archivePath: string | null = null;
  try {
    const written = deps.blackbox.archive(agent);
    archivePath = written.length === 0 ? null : path.relative(deps.paths.rootDir, deps.blackbox.archiveDirOf(agent));
  } catch (error) {
    deps.onNotice(agent, `黑盒归档失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const body = buildBody(deps, agent, cause, at, archivePath);
  if (body === null) {
    return { ok: false, error: 'agent_not_found' };
  }

  const releasedTasks = deps.ledger.transaction(() => {
    const marked = deps.ledger.markAgentDead(agent);
    if (!marked) {
      throw new Error(`agent ${agent} could not be marked dead`);
    }
    const released = deps.ledger.releaseHeldTasks(agent, at);
    deps.ledger.insertDeathCertificate({
      agent,
      diedAt: at,
      cause,
      body: JSON.stringify(body),
    });
    return released;
  });

  deps.stopProcess(agent);
  deps.blackbox.append(agent, 'death', at, null, { cause, releasedTasks });
  const home = agentHomeDir(deps.paths, agent);
  mkdirSync(home, { recursive: true });
  writeFileSync(`${home}/${DEATH_CERTIFICATE_FILE}`, renderDeathCertificate(body), 'utf8');

  deps.onNotice(
    agent,
    cause === 'operator_termination'
      ? `操作员强制终止了 ${agent}：死亡不可逆，死亡证明已写入 AGENTS/${agent}/${DEATH_CERTIFICATE_FILE}。`
      : `${agent} 的未治疗遮盖字数达到死亡线（${deps.values.deathLineChars}），已死亡；死亡证明已写入 AGENTS/${agent}/${DEATH_CERTIFICATE_FILE}。`,
  );
  return { ok: true, body, releasedTasks };
}

/** A structured view of a stored certificate, for the console. */
export function parseDeathCertificate(body: string): DeathCertificateBody | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as DeathCertificateBody;
  } catch {
    return null;
  }
}

/**
 * The mechanism that kills: untreated redacted characters reaching the line.
 * Returns null while the agent is still under it, so a caller can ask on every
 * beat without special-casing anything.
 */
export function checkDeathLine(deps: DeathDeps, agent: string): DeathOutcome | null {
  if (deps.ledger.untreatedRedactedChars(agent) < deps.values.deathLineChars) {
    return null;
  }
  return die(deps, agent, 'redaction_death_line', deps.now());
}

export type TerminateOutcome =
  | { ok: true; body: DeathCertificateBody }
  | { ok: false; error: 'agent_not_found' | 'agent_dead' | 'confirm_name_mismatch' };

/**
 * The operator's forced termination. It is an intervention like any other, so
 * it is recorded permanently before it happens, and then it is death like any
 * other: the confirmation name has to match, and there is no way back.
 */
export function terminateByOperator(deps: DeathDeps, agent: string, confirmName: string): TerminateOutcome {
  const record = deps.ledger.getAgent(agent);
  if (record === null) {
    return { ok: false, error: 'agent_not_found' };
  }
  if (record.status !== 'alive') {
    return { ok: false, error: 'agent_dead' };
  }
  if (confirmName !== agent) {
    return { ok: false, error: 'confirm_name_mismatch' };
  }
  const at = deps.now();
  deps.ledger.appendIntervention(
    'force_terminate',
    agent,
    `操作员强制终止 ${agent}：这就是死亡，不可撤销`,
    at,
  );
  deps.blackbox.append(agent, 'intervention', at, null, { kind: 'force_terminate' });
  const outcome = die(deps, agent, 'operator_termination', at);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error === 'already_dead' ? 'agent_dead' : 'agent_not_found' };
  }
  return { ok: true, body: outcome.body };
}
