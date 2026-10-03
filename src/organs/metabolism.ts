import type { ConservatoryValues } from '../config';
import type { Ledger, SatietyAnchor } from './ledger';

export class MetabolismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetabolismError';
  }
}

export interface BodyStatus {
  satiety: number;
  satietyMax: number;
  balance: number;
  mealPrice: number;
  satietyPerMeal: number;
}

export type EatOutcome =
  | {
      ok: true;
      satiety: number;
      satietyMax: number;
      balance: number;
      gained: number;
      overflow: number;
      price: number;
    }
  | {
      ok: false;
      reason: 'insufficient_balance';
      satiety: number;
      satietyMax: number;
      balance: number;
      price: number;
      missing: number;
    };

/**
 * Satiety is stored as an anchor (value plus the instant it was true) and is
 * derived from wall-clock time on every read. Nothing can raise it except a
 * meal, and it never falls below zero.
 */
export function computeSatiety(anchor: SatietyAnchor, now: number, decayPerSecond: number): number {
  const elapsedSeconds = Math.max(0, (now - anchor.asOf) / 1000);
  return Math.max(0, anchor.value - decayPerSecond * elapsedSeconds);
}

/** The frozen value an anchor holds while the conservatory is paused. */
export function frozenSatiety(anchor: SatietyAnchor): number {
  return Math.max(0, anchor.value);
}

/**
 * The one place the pause rule is applied: a paused conservatory returns the
 * anchored value instead of decaying it, so no elapsed time is charged to
 * anyone until the operator resumes. An agent with no anchor at all reads 0.
 */
export function satietyAt(
  ledger: Ledger,
  values: ConservatoryValues,
  agent: string,
  now: number,
): number {
  const anchor = ledger.getSatietyAnchor(agent);
  if (anchor === null) {
    return 0;
  }
  return ledger.getPauseState().paused
    ? frozenSatiety(anchor)
    : computeSatiety(anchor, now, values.satietyDecayPerSecond);
}

export function readSatiety(
  ledger: Ledger,
  values: ConservatoryValues,
  agent: string | null,
  now: number,
): number {
  return agent === null ? 0 : satietyAt(ledger, values, agent, now);
}

export function readBodyStatus(
  ledger: Ledger,
  values: ConservatoryValues,
  agent: string | null,
  now: number,
): BodyStatus {
  return {
    satiety: readSatiety(ledger, values, agent, now),
    satietyMax: values.satietyMax,
    balance: agent === null ? 0 : ledger.getBalance(agent),
    mealPrice: values.mealPrice,
    satietyPerMeal: values.satietyPerMeal,
  };
}

/**
 * Buys one meal. The affordability check and the debit happen in one
 * transaction, so the balance can never be overdrawn; a refusal changes
 * nothing at all.
 */
export function eat(
  ledger: Ledger,
  values: ConservatoryValues,
  agent: string,
  now: number,
): EatOutcome {
  return ledger.transaction(() => {
    const current = readSatiety(ledger, values, agent, now);
    const balance = ledger.getBalance(agent);
    if (balance < values.mealPrice) {
      return {
        ok: false,
        reason: 'insufficient_balance',
        satiety: current,
        satietyMax: values.satietyMax,
        balance,
        price: values.mealPrice,
        missing: values.mealPrice - balance,
      };
    }
    ledger.appendBalanceEvent(agent, -values.mealPrice, 'meal', null, now);
    const raw = current + values.satietyPerMeal;
    const capped = Math.min(values.satietyMax, raw);
    const overflow = raw - capped;
    const gained = capped - current;
    ledger.setSatietyAnchor(agent, capped, now);
    ledger.appendMeal(agent, values.mealPrice, gained, overflow, now);
    return {
      ok: true,
      satiety: capped,
      satietyMax: values.satietyMax,
      balance: balance - values.mealPrice,
      gained,
      overflow,
      price: values.mealPrice,
    };
  });
}

/** Operator intervention: gives satiety without a purchase, capped as a meal. */
export function grantSatiety(
  ledger: Ledger,
  values: ConservatoryValues,
  agent: string,
  amount: number,
  now: number,
): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new MetabolismError('satiety grant must be a finite number greater than 0');
  }
  return ledger.transaction(() => {
    const current = readSatiety(ledger, values, agent, now);
    const next = Math.min(values.satietyMax, current + amount);
    ledger.setSatietyAnchor(agent, next, now);
    return next;
  });
}

/** Keeps injected numbers readable without pretending to more precision. */
export function formatAmount(value: number): string {
  return Number(value.toFixed(3)).toString();
}
