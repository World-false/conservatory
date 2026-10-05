/**
 * Switching a living agent's brain. Operator-only, forever recorded.
 *
 * The world view draws one line this crosses: an agent is the model plus the
 * one read-only file that carries it between calls, so changing the model is
 * changing the brain — which is precisely why this is an *intervention* and not
 * a setting. It is written to the ledger permanently, and the agent's frozen
 * binding in its own home is rewritten with it.
 *
 * A switch never cuts a round in half. The decision is durable the instant it
 * is made, but a process that is mid-round finishes on the brain it started
 * with; the supervisor retires that process when the round ends, and the next
 * wake-up forks on the new one. That is what the returned `deferred` means, and
 * it is why a busy agent is switched rather than refused.
 */

import { modelBindingPath, writeModelBinding, type AgentModelBinding } from './binding';
import type { ModelConfigStore } from './store';
import type { RuntimePaths } from '../../config';
import type { Blackbox } from '../blackbox';
import type { Ledger } from '../ledger';

export interface SwitchModelDeps {
  ledger: Ledger;
  paths: RuntimePaths;
  blackbox: Blackbox;
  store: ModelConfigStore;
  now(): number;
  /** True while this agent is mid-round. */
  isBusy(agent: string): boolean;
  /** Stops the agent's process and drops it, so the next wake-up forks anew. */
  retireProcess(agent: string): void;
  /** Operator-facing Chinese notice for the console. */
  onNotice(agent: string, message: string, at: number): void;
}

export type SwitchModelOutcome =
  | { ok: true; deferred: boolean; message: string }
  | { ok: false; error: string };

export const DEFERRED_NOTICE = '模型修改已保存。当前正在执行任务，将在本轮运行完成后下一次唤醒时生效。';
export const IMMEDIATE_NOTICE = '模型修改已保存，将在下次唤醒时生效。';

export function switchAgentModel(
  deps: SwitchModelDeps,
  agent: string,
  providerId: string,
  model: string,
): SwitchModelOutcome {
  const record = deps.ledger.getAgent(agent);
  if (record === null) {
    return { ok: false, error: 'agent_not_found' };
  }
  if (record.status !== 'alive') {
    return { ok: false, error: 'agent_dead' };
  }
  const provider = deps.store.getProvider(providerId);
  if (provider === null) {
    return { ok: false, error: 'unknown_provider' };
  }
  if (!provider.models.includes(model)) {
    return { ok: false, error: 'unknown_model' };
  }

  const at = deps.now();
  const binding: AgentModelBinding = {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    boundAt: at,
  };

  // The ledger row is what the next wake-up reads; the binding is what makes
  // the choice survive the roster being edited underneath it. Both, or neither.
  if (!deps.ledger.updateAgentModel(agent, model)) {
    // The guarded UPDATE matched no living row: the agent died in between.
    return { ok: false, error: 'agent_dead' };
  }
  writeModelBinding(deps.paths, agent, binding);
  deps.ledger.appendIntervention(
    'model_switched',
    agent,
    `切换模型为 ${provider.name} · ${model}`,
    at,
  );
  deps.blackbox.append(agent, 'intervention', at, null, {
    kind: 'model_switched',
    providerId: provider.id,
    model,
    bindingFile: modelBindingPath(deps.paths, agent),
  });

  const deferred = deps.isBusy(agent);
  if (deferred) {
    deps.onNotice(
      agent,
      `${agent} 的模型已改为 ${provider.name} · ${model}；当前一轮跑完后，下一次唤醒生效。`,
      at,
    );
    return { ok: true, deferred: true, message: DEFERRED_NOTICE };
  }
  // Idle: drop the cached process now, so the very next wake-up forks a process
  // on the new brain instead of reusing one built for the old.
  deps.retireProcess(agent);
  deps.onNotice(agent, `${agent} 的模型已改为 ${provider.name} · ${model}；下次唤醒生效。`, at);
  return { ok: true, deferred: false, message: IMMEDIATE_NOTICE };
}
