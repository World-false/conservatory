import type { ConservatoryValues } from '../config';
import { PAUSED_SETTING_AGENT, type Ledger, type PauseState } from './ledger';
import { computeSatiety } from './metabolism';

/**
 * One switch for the whole conservatory. While it is on, time stops for every
 * agent at once: the heartbeat wakes nobody, satiety is frozen at the value it
 * held at the pause instant, and the claim clock of a held task stops running.
 * The switch itself lives in the ledger, so a restart keeps the same pause.
 */
export interface PauseOutcome {
  /** false when the request matched the state that was already in force. */
  changed: boolean;
  paused: boolean;
  pausedSince: number | null;
  /** Only set when this call resumed the conservatory. */
  pausedDurationMs: number | null;
}

export interface PauseOrgan {
  read(): PauseState;
  isPaused(): boolean;
  set(paused: boolean, now: number): PauseOutcome;
}

export interface PauseOrganDeps {
  ledger: Ledger;
  values: ConservatoryValues;
  /**
   * Appends the intervention row for a real transition. `pausedDurationMs` is
   * null when pausing, and the length of the pause when resuming.
   */
  recordIntervention(paused: boolean, pausedDurationMs: number | null, at: number): void;
}

/**
 * The value every read must return while the conservatory is paused: the
 * anchor's value itself, never decayed, so reads are identical whatever `now`
 * says. Re-exported from metabolism so a caller can name the rule directly.
 */
export { frozenSatiety } from './metabolism';

export function createPauseOrgan(deps: PauseOrganDeps): PauseOrgan {
  const { ledger, values } = deps;

  function set(paused: boolean, now: number): PauseOutcome {
    const current = ledger.getPauseState();
    if (current.paused === paused) {
      return { changed: false, paused, pausedSince: current.pausedSince, pausedDurationMs: null };
    }

    if (paused) {
      // Freeze once, at this instant: every living agent gets an anchor holding
      // the value its satiety had when the switch was thrown.
      for (const agent of ledger.listAgents()) {
        if (agent.status !== 'alive') {
          continue;
        }
        const anchor = ledger.getSatietyAnchor(agent.name);
        if (anchor === null) {
          continue;
        }
        const frozen = computeSatiety(anchor, now, values.satietyDecayPerSecond);
        ledger.setSatietyAnchor(agent.name, frozen, now);
      }
      ledger.setPauseState(true, now);
      deps.recordIntervention(true, null, now);
      return { changed: true, paused: true, pausedSince: now, pausedDurationMs: null };
    }

    // Resuming: the paused span counts toward nobody's hunger, so every anchor
    // restarts from the frozen value at this instant, and every held claim gets
    // the paused span back on its clock.
    const since = current.pausedSince;
    const pausedDurationMs = since === null ? 0 : Math.max(0, now - since);
    for (const agent of ledger.listAgents()) {
      if (agent.status !== 'alive') {
        continue;
      }
      const anchor = ledger.getSatietyAnchor(agent.name);
      if (anchor === null) {
        continue;
      }
      const frozen = computeSatiety(anchor, since ?? now, values.satietyDecayPerSecond);
      ledger.setSatietyAnchor(agent.name, frozen, now);
    }
    ledger.shiftClaimedTaskTimes(pausedDurationMs, now);
    ledger.setPauseState(false, null);
    deps.recordIntervention(false, pausedDurationMs, now);
    return { changed: true, paused: false, pausedSince: null, pausedDurationMs };
  }

  return {
    read: () => ledger.getPauseState(),
    isPaused: () => ledger.getPauseState().paused,
    set,
  };
}

/** The detail text of the two global interventions, kept verbatim forever. */
export function pauseInterventionDetail(paused: boolean, pausedDurationMs: number | null): string {
  if (paused) {
    return '操作员暂停温室：所有 Agent 不再被唤醒，饱食度与认领计时冻结（全局）';
  }
  return `操作员恢复温室：时间重新流动；本次暂停持续 ${formatPauseDuration(pausedDurationMs ?? 0)}（全局）`;
}

/** Reads as a duration a person can check at a glance. */
export function formatPauseDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分 ${seconds % 60} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export { PAUSED_SETTING_AGENT };
