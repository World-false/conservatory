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

import { rmSync } from 'node:fs';
import { modelBindingPath, readModelBinding, writeModelBinding, type AgentModelBinding } from './binding';
import type { ModelConfigStore } from './store';
import { isReasoningEffort, type ReasoningEffort, type RuntimePaths } from '../../config';
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
  reasoningEffort?: ReasoningEffort | null,
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

  // A switch rewrites the whole snapshot, so leaving the level off is how the
  // operator clears one: the new binding carries no level and the next process
  // asks the provider to decide for itself. `null` and `undefined` both mean
  // that, and neither is a level.
  const effort: ReasoningEffort | undefined = isReasoningEffort(reasoningEffort)
    ? reasoningEffort
    : undefined;
  const suffix = effort === undefined ? '' : `（思考：${effort}）`;

  const at = deps.now();
  const previousBinding = readModelBinding(deps.paths, agent);
  const binding: AgentModelBinding = {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    boundAt: at,
  };

  // The binding first, the ledger row second, and both inside one transaction of
  // the ledger's own so a reader never sees the two disagree.
  //
  // The binding used to be written after the ledger, with no guard: a failed
  // write left the ledger naming the new brain, the file naming the old one, and
  // no intervention recorded — the state `resolveAgentModel` reads as "binding
  // wins", so the agent kept running the old brain while every record said the
  // new one. Writing the file first means a failure leaves the ledger untouched,
  // which is the state the operator can simply retry from.
  try {
    writeModelBinding(deps.paths, agent, binding);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.onNotice(agent, `切换模型失败：模型绑定文件无法写入（${message}），模型未改变。`, at);
    return { ok: false, error: 'binding_write_failed' };
  }
  if (!deps.ledger.updateAgentModel(agent, model)) {
    // The guarded UPDATE matched no living row: the agent died in between.
    // Put the old binding back, so a dead agent is not left carrying a brain
    // its ledger row never recorded.
    try {
      if (previousBinding === null) {
        rmSync(modelBindingPath(deps.paths, agent), { force: true });
      } else {
        writeModelBinding(deps.paths, agent, previousBinding);
      }
    } catch {
      // Nothing further to undo: the ledger row is the one that decides, and it
      // still names the old model.
    }
    return { ok: false, error: 'agent_dead' };
  }
  deps.ledger.appendIntervention(
    'model_switched',
    agent,
    `切换模型为 ${provider.name} · ${model}${suffix}`,
    at,
  );
  deps.blackbox.append(agent, 'intervention', at, null, {
    kind: 'model_switched',
    providerId: provider.id,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    bindingFile: modelBindingPath(deps.paths, agent),
  });

  const deferred = deps.isBusy(agent);
  if (deferred) {
    deps.onNotice(
      agent,
      `${agent} 的模型已改为 ${provider.name} · ${model}${suffix}；当前一轮跑完后，下一次唤醒生效。`,
      at,
    );
    return { ok: true, deferred: true, message: DEFERRED_NOTICE };
  }
  // Idle: drop the cached process now, so the very next wake-up forks a process
  // on the new brain instead of reusing one built for the old.
  deps.retireProcess(agent);
  deps.onNotice(agent, `${agent} 的模型已改为 ${provider.name} · ${model}${suffix}；下次唤醒生效。`, at);
  return { ok: true, deferred: false, message: IMMEDIATE_NOTICE };
}
