/**
 * Reconciling the brain a running process carries with the brain it should
 * carry.
 *
 * This is what makes a deferred switch land. When the operator switches a model
 * while a round is in flight, the decision is written immediately but the live
 * process cannot be touched without cutting that round in half. The round ends
 * on the old brain, and this check — run the moment the round is over, outside
 * it — notices the disagreement and retires the process, so the next wake-up
 * forks a fresh one on the new model.
 *
 * The only question that matters is whether the process's started model is the
 * model the agent's binding and the roster now resolve to. A ledger-only
 * mismatch is not a reason to tear a process down: the ledger row and the
 * frozen binding are always written together, so either both moved or neither.
 */

import type { ModelSettings } from '../../config';

export interface ProcessModelState {
  /** The model name the running process was started with, or null if none. */
  startedModel: string | null;
  /** The model the binding and roster currently resolve to, or null if unknown. */
  resolvedModel: string | null;
}

/**
 * Whether the live process is carrying an outdated brain and must be replaced
 * before the next wake-up.
 *
 * A process that has never started is not retired: it will resolve the current
 * model for itself when it does start. An unresolvable model leaves the running
 * process alone rather than tearing down an agent we cannot describe.
 */
export function shouldRetireProcess(state: ProcessModelState): boolean {
  const { startedModel, resolvedModel } = state;
  if (startedModel === null || resolvedModel === null) {
    return false;
  }
  return startedModel !== resolvedModel;
}

/**
 * The full identity of the brain a process is carrying, as one comparable
 * string.
 *
 * The model *name* is not enough. Two providers can serve a model with the same
 * name at different endpoints, on different keys, and the operator can retune a
 * provider's base URL or rotate its key without renaming anything. Changing the
 * thinking level changes the brain too. Comparing only the name would leave a
 * live process running on a brain the operator has already replaced — the exact
 * silent divergence this module exists to catch.
 *
 * `providerId` is last-resort information: an agent resolved from `.env` has no
 * provider at all, and the empty string is then a correct part of its identity.
 */
export function modelFingerprint(settings: ModelSettings, providerId = ''): string {
  return [
    providerId,
    settings.baseUrl,
    settings.apiKey,
    settings.model,
    settings.reasoningEffort ?? '',
  ].join('|');
}
