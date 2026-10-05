import type { ConservatoryValues, RuntimePaths } from '../config';
import type { Blackbox } from './blackbox';
import type { Ledger, TreatmentPayer, TreatmentTier, WoundRecord } from './ledger';
import { readMemoryFile, writeMemoryAtomic } from './memory';
import { ledgerFrozenRefs, renderSentence, restoreFrozenSentences, type FrozenRef } from './redaction';

export type TreatErrorCode = 'wound_not_found' | 'wound_not_treatable' | 'insufficient_balance';

/** Thrown inside the treatment transaction to roll the debit back with it. */
class TreatmentRefused extends Error {
  readonly code: TreatErrorCode;

  constructor(code: TreatErrorCode) {
    super(`treatment refused: ${code}`);
    this.name = 'TreatmentRefused';
    this.code = code;
  }
}

export type TreatOutcome =
  | {
      ok: true;
      wound: WoundRecord;
      tier: TreatmentTier;
      price: number;
      paidBy: TreatmentPayer;
      /** True once the frozen sentence has been released. */
      sentenceReleased: boolean;
      /** Which frozen sentence the wound belonged to. */
      sentenceId: number;
    }
  | {
      ok: false;
      code: TreatErrorCode;
      balance: number;
      price: number;
      missing: number;
    };

export interface ClinicDeps {
  ledger: Ledger;
  values: ConservatoryValues;
  paths: RuntimePaths;
  blackbox: Blackbox;
  now(): number;
}

/** What the agent is allowed to see about its own wounds: never the original. */
export interface WoundView {
  id: number;
  status: string;
  length: number;
  /** The visible sentence the wound sits in, exactly as MEMORY shows it. */
  sentence: string;
}

export function priceOf(values: ConservatoryValues, tier: TreatmentTier): number {
  return tier === 'ordinary' ? values.ordinaryTreatmentPrice : values.completeTreatmentPrice;
}

export function treatableWith(status: WoundRecord['status'], tier: TreatmentTier): boolean {
  if (tier === 'ordinary') {
    return status === 'untreated';
  }
  return status === 'untreated' || status === 'scarred';
}

/**
 * Treats one wound. Ordinary treatment restores the characters and leaves a
 * scar, which stops counting toward the death line; complete treatment removes
 * every trace, including the scar, and costs more. A refusal changes nothing at
 * all: the balance is only debited inside the same transaction that moves the
 * wound, so there is no window in which money is gone and the wound is not.
 */
export function treat(
  deps: ClinicDeps,
  agent: string,
  woundId: number,
  tier: TreatmentTier,
  paidBy: TreatmentPayer,
): TreatOutcome {
  const { ledger, values } = deps;
  const at = deps.now();
  const wound = ledger.getWound(woundId);
  const price = priceOf(values, tier);
  const balance = ledger.getBalance(agent);
  if (wound === null || wound.agent !== agent) {
    return { ok: false, code: 'wound_not_found', balance, price, missing: 0 };
  }
  if (!treatableWith(wound.status, tier)) {
    return { ok: false, code: 'wound_not_treatable', balance, price, missing: 0 };
  }
  if (paidBy === 'agent' && balance < price) {
    return { ok: false, code: 'insufficient_balance', balance, price, missing: price - balance };
  }

  const sentence = ledger.getFrozenSentence(wound.sentenceId);
  const before = ledger.listWounds(agent).filter((row) => row.sentenceId === wound.sentenceId);
  const visibleBefore = sentence === null ? null : renderSentence(sentence.original, before);
  // The frozen refs as they stand before the treatment: a rewrite that has to
  // be corrected must be corrected against what the ledger said beforehand,
  // not against the state this treatment is about to create.
  const refsBefore = visibleBefore === null ? [] : ledgerFrozenRefs(ledger, agent);
  const nextStatus: WoundRecord['status'] = tier === 'ordinary' ? 'scarred' : 'healed';

  let moved: boolean;
  try {
    moved = ledger.transaction(() => {
      // A price of zero is a legal configuration: nothing is owed, so nothing
      // is debited. The ledger refuses a zero-amount debit by design, and the
      // affordability check above already passed, so skip the debit entirely
      // and record the free treatment like any other.
      if (paidBy === 'agent' && price > 0 && !ledger.debitIfAffordable(agent, price, 'treatment', String(woundId), at)) {
        // Nothing was written, so nothing needs undoing.
        return false;
      }
      if (!ledger.setWoundStatus(woundId, wound.status, nextStatus, at)) {
        // Someone else moved this wound first. The debit made inside this
        // transaction has to go with it, so the whole thing rolls back: a
        // refusal must leave the balance exactly where it was.
        throw new TreatmentRefused('wound_not_treatable');
      }
      ledger.appendTreatment({ agent, woundId, tier, price, paidBy, at });
      const after = ledger.listWounds(agent).filter((row) => row.sentenceId === wound.sentenceId);
      if (sentence !== null && after.every((row) => row.status === 'healed')) {
        ledger.releaseFrozenSentence(wound.sentenceId, at);
      }
      return true;
    });
  } catch (error) {
    if (!(error instanceof TreatmentRefused)) {
      throw error;
    }
    return {
      ok: false,
      code: error.code,
      balance: ledger.getBalance(agent),
      price,
      missing: 0,
    };
  }

  if (!moved) {
    const nowBalance = ledger.getBalance(agent);
    return {
      ok: false,
      code: 'insufficient_balance',
      balance: nowBalance,
      price,
      missing: Math.max(0, price - nowBalance),
    };
  }

  const updated = ledger.getWound(woundId);
  if (updated === null) {
    return { ok: false, code: 'wound_not_found', balance: ledger.getBalance(agent), price, missing: 0 };
  }

  rewriteMemory(deps, agent, wound.sentenceId, sentence === null ? null : sentence.original, visibleBefore, refsBefore);
  deps.blackbox.append(agent, 'treatment', at, null, {
    woundId,
    sentenceId: wound.sentenceId,
    tier,
    price,
    paidBy,
    status: updated.status,
  });

  const released = sentence === null ? null : ledger.getFrozenSentence(wound.sentenceId);
  return {
    ok: true,
    wound: updated,
    tier,
    price,
    paidBy,
    sentenceReleased: released !== null && released.releasedAt !== null,
    sentenceId: wound.sentenceId,
  };
}

/**
 * Swaps the sentence's old visible text for its new one in MEMORY. If the model
 * has since rewritten that sentence, it is first restored from the ledger, so
 * the swap lands on the text the harness owns rather than on model prose.
 */
function rewriteMemory(
  deps: ClinicDeps,
  agent: string,
  sentenceId: number,
  original: string | null,
  visibleBefore: string | null,
  refsBefore: readonly FrozenRef[],
): void {
  if (original === null || visibleBefore === null) {
    return;
  }
  const after = deps.ledger.listWounds(agent).filter((row) => row.sentenceId === sentenceId);
  const visibleAfter = renderSentence(original, after);
  let text = readMemoryFile(deps.paths, agent);
  let at = text.indexOf(visibleBefore);
  if (at < 0) {
    // The model may have filled the gap in: restore from the ledger first, so
    // the swap lands on the text the harness owns rather than on model prose.
    const restored = restoreFrozenSentences(text, refsBefore);
    text = restored.text;
    at = text.indexOf(visibleBefore);
  }
  if (at < 0) {
    // It is still not there: the visible form may already have changed (a
    // healed sentence with no scar, for instance).
    at = text.indexOf(visibleAfter);
    if (at >= 0) {
      return;
    }
    deps.blackbox.append(agent, 'treatment_memory_skipped', deps.now(), null, { sentenceId });
    return;
  }
  text = text.slice(0, at) + visibleAfter + text.slice(at + visibleBefore.length);
  writeMemoryAtomic(deps.paths, agent, text);
}

/**
 * The agent's own view of its wounds: id, status, length and the visible
 * sentence. The original text of a wound is never part of this.
 */
export function listWoundViews(deps: ClinicDeps, agent: string): WoundView[] {
  const wounds = deps.ledger.listWounds(agent).filter((wound) => wound.status !== 'healed');
  return wounds.map((wound) => {
    const sentence = deps.ledger.getFrozenSentence(wound.sentenceId);
    const siblings = deps.ledger.listWounds(agent).filter((row) => row.sentenceId === wound.sentenceId);
    return {
      id: wound.id,
      status: wound.status,
      length: wound.length,
      sentence: sentence === null ? '' : renderSentence(sentence.original, siblings),
    };
  });
}
