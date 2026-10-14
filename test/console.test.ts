import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { persistConservatoryValues, validateValuesPatch } from '../src/config';
import { createConsoleServer } from '../src/console/server';
import { BODY_MANUAL } from '../src/organs/manual';
import { MEMORY_SYSTEM_PROMPT } from '../src/organs/memory';
import { createPauseOrgan } from '../src/organs/pause';
import { RoundRegistry } from '../src/organs/population';
import {
  DEFAULT_SYSTEM_CONTEXT_TEMPLATE,
  DEFAULT_USER_CONTEXT_TEMPLATE,
  DEFAULT_WORLD_TEMPLATE,
  type PromptLibrary,
  type PromptStatus,
} from '../src/organs/prompts';
import { claimTask, createTask, reviewTask, submitTask } from '../src/organs/taskboard';
import {
  createSandboxPolicyStore,
  DEFAULT_SANDBOX_POLICY,
  type SandboxPolicyConfig,
  type SandboxPolicyStore,
} from '../src/organs/sandbox/policy';
import type { ModelConfigStore } from '../src/organs/models/store';
import { writeModelBinding } from '../src/organs/models/binding';
import { birthAgent, createHarness, testModelStore, testPrompts, twoProviderModels, writePrompts, type Harness } from './helpers';

interface RunningConsole {
  server: http.Server;
  base: string;
}

/**
 * The real store with its file write captured instead of performed: a console
 * test must not touch conservatory.config.json, and the captured writes are the
 * proof that a patch reached persistence rather than only the answered view.
 * The locked rows fall out of `listAgentHomes()` exactly as they do in the
 * supervisor, so the page sees the same built-ins it sees in production.
 */
function testSandboxPolicy(
  h: Harness,
  options: { initial?: Partial<SandboxPolicyConfig>; agentNames?: string[] } = {},
): { policy: SandboxPolicyStore; written: SandboxPolicyConfig[] } {
  const written: SandboxPolicyConfig[] = [];
  const agentNames = options.agentNames ?? [];
  const policy = createSandboxPolicyStore({
    configPath: h.paths.configPath,
    agentsDir: h.paths.agentsDir,
    supervisorDir: h.paths.supervisorDir,
    listAgentHomes: () => agentNames.map((name) => path.join(h.paths.agentsDir, name)),
    initial: { ...DEFAULT_SANDBOX_POLICY, ...options.initial },
    persist: (next) => {
      written.push(next);
    },
  });
  return { policy, written };
}

const servers: http.Server[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  harnesses.splice(0).forEach((h) => h.cleanup());
});

/** One recorded model switch, so a test can prove what reached the supervisor. */
interface SwitchCall {
  name: string;
  providerId: string;
  model: string;
  /**
   * Present only when the request actually carried a level. It is recorded
   * even as `null`, so a console that wrongly forwarded "cleared" as an
   * explicit value would be visible rather than silently dropped.
   */
  reasoningEffort?: string | null;
}


async function startConsole(
  h: Harness,
  created: string[],
  prompts: PromptLibrary = testPrompts(h),
  treated: { agent: string; woundId: number; tier: string }[] = [],
  terminated: string[] = [],
  registry: RoundRegistry = new RoundRegistry(),
  sandboxPolicy: SandboxPolicyStore = testSandboxPolicy(h).policy,
  modelStore: ModelConfigStore = testModelStore(h).store,
  switches: SwitchCall[] = [],
  erased: { agent: string; confirmName: string }[] = [],
  updateValues?: (
    patch: unknown,
  ) => { ok: true; values: typeof h.values } | { ok: false; error: string },
): Promise<RunningConsole> {
  // The real pause organ, wired to the harness ledger, so the console tests
  // exercise the same freeze/resume path the supervisor uses.
  const pause = createPauseOrgan({
    ledger: h.ledger,
    values: h.values,
    recordIntervention: (paused, pausedDurationMs, at) => {
      h.ledger.appendIntervention(
        paused ? 'conservatory_paused' : 'conservatory_resumed',
        'conservatory',
        paused ? 'paused' : `resumed after ${String(pausedDurationMs ?? 0)}ms`,
        at,
      );
    },
  });
  const server = createConsoleServer({
    values: h.values,
    paths: h.paths,
    ledger: h.ledger,
    blackbox: h.blackbox,
    registry,
    prompts,
    sandboxPolicy,
    modelStore,
    indexHtmlPath: path.join(process.cwd(), 'src', 'console', 'public', 'index.html'),
    now: h.clock.now,
    getRuntime: () => ({
      busy: registry.busyAgents().length > 0,
      lastWakeAt: null,
      lastRoundAt: null,
      lastRoundEndReason: null,
      lastError: null,
    }),
    createAgent: async (name, providerId, model, reasoningEffort) => {
      // Only a request that actually carried a level appends one, so the
      // records for the pre-existing calls stay byte-identical.
      const label = providerId === undefined && model === undefined ? name : `${name}:${providerId}/${model}`;
      created.push(reasoningEffort === undefined ? label : `${label}:${reasoningEffort}`);
      return { ok: true };
    },
    switchAgentModel: (name, providerId, model, reasoningEffort) => {      switches.push(
        reasoningEffort === undefined
          ? { name, providerId, model }
          : { name, providerId, model, reasoningEffort },
      );
      return registry.isBusy(name)
        ? {
            ok: true,
            deferred: true,
            message: '模型修改已保存。当前正在执行任务，将在本轮运行完成后下一次唤醒时生效。',
          }
        : { ok: true, deferred: false, message: '模型修改已保存，将在下次唤醒时生效。' };
    },
    wakeAgent: async () => ({ ok: true, woken: false, reason: '该 agent 正在一轮中，本次唤醒已跳过' }),
    // Only injected when a test wants to watch the patch reach a supervisor
    // callback; without it the console validates and applies it itself.
    ...(updateValues === undefined ? {} : { updateValues }),
    setPaused: (paused) => ({
      ok: true,
      changed: pause.set(paused, h.clock.now()).changed,
      state: pause.read(),
    }),
    intervene: async () => ({ ok: true, balance: 110, satiety: 100 }),
    treatWound: (agent, woundId, tier) => {
      treated.push({ agent, woundId, tier });
      return { ok: true };
    },
    terminateAgent: (agent, confirmName) => {
      if (confirmName !== agent) {
        return { ok: false, error: 'confirm_name_mismatch' };
      }
      terminated.push(agent);
      return { ok: true };
    },
    eraseAgent: (agent, confirmName) => {
      if (confirmName !== agent) {
        return { ok: false, error: 'confirm_name_mismatch' };
      }
      erased.push({ agent, confirmName });
      return { ok: true };
    },
    getNotices: () => [],
  });
  servers.push(server);
  harnesses.push(h);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function getJson(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(
  base: string,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the operator console', () => {
  it('serves the page and the state on loopback', async () => {
    const h = createHarness();
    const agent = birthAgent(h, 'ada');
    const created: string[] = [];
    const console = await startConsole(h, created);

    const page = await fetch(`${console.base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('CONSERVATORY');

    const state = await getJson(console.base, '/api/state');
    expect(state.status).toBe(200);
    expect(state.body['exchangeRate']).toBeNull();
    const agents = state.body['agents'] as { name: string; balance: number; bornAt: number }[];
    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('ada');
    expect(agents[0].balance).toBe(100);
    expect(agents[0].bornAt).toBe(agent.bornAt);

    const create = await postJson(console.base, '/api/agents', { name: 'bob' });
    expect(create.status).toBe(200);
    expect(created).toEqual(['bob']);

    // The operator may also name the provider and model at birth.
    const picked = await postJson(console.base, '/api/agents', {
      name: 'cleo',
      providerId: 'main',
      model: 'agent-model',
    });
    expect(picked.status).toBe(200);
    expect(created).toEqual(['bob', 'cleo:main/agent-model']);
  });

  it('posts a task, reviews it, and pays on acceptance', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const posted = await postJson(console.base, '/api/tasks', {
      title: 'Count the clouds',
      description: 'How many did you see?',
      price: 25,
    });
    expect(posted.status).toBe(200);
    const task = posted.body['task'] as { id: string };
    expect(task.id).toMatch(/^task_/);

    claimTask(h.ledger, 'ada', task.id, h.clock.now());
    submitTask(h.ledger, 'ada', task.id, 'I saw four.', h.clock.now());

    const before = h.ledger.getBalance('ada');
    const accepted = await postJson(console.base, `/api/tasks/${task.id}/review`, { decision: 'accept' });
    expect(accepted.status).toBe(200);
    expect(h.ledger.getBalance('ada')).toBe(before + 25);

    const again = await postJson(console.base, `/api/tasks/${task.id}/review`, { decision: 'accept' });
    expect(again.status).toBe(400);
    expect(h.ledger.getBalance('ada')).toBe(before + 25);
  });

  it('refuses to credit income while the exchange rate is unset', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const reportId = h.ledger.insertIncomeReport({
      agent: 'ada',
      where: 'upwork',
      work: 'translation',
      amount: 10,
      currency: 'USD',
      at: h.clock.now(),
    });
    const response = await postJson(console.base, `/api/income/${reportId}/verify`, { verifiedAmount: 10 });
    expect(response.status).toBe(400);
    expect(String(response.body['error'])).toContain('汇率未设定');
    expect(h.ledger.getBalance('ada')).toBe(100);
    expect(h.ledger.getIncomeReport(reportId)?.status).toBe('pending');
  });

  it('shows MEMORY and the notebook, and refuses an escaping notebook path', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const memory = await getJson(console.base, '/api/agents/ada/memory');
    expect(memory.status).toBe(200);
    expect(String(memory.body['memory'])).toContain('Name: ada');

    const escape = await getJson(
      console.base,
      `/api/agents/ada/notebook/file?path=${encodeURIComponent('../MEMORY')}`,
    );
    expect(escape.status).toBe(400);
    expect(String(escape.body['error'])).toContain('..');

    const missing = await getJson(console.base, '/api/agents/nobody/memory');
    expect(missing.status).toBe(404);
  });

  it('records an intervention with a warning and reports the new numbers', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const response = await postJson(console.base, '/api/intervene', {
      agent: 'ada',
      kind: 'give_balance',
      amount: 10,
    });
    expect(response.status).toBe(200);
    expect(response.body['balance']).toBe(110);

    const bad = await postJson(console.base, '/api/intervene', {
      agent: 'ada',
      kind: 'give_balance',
      amount: -5,
    });
    expect(bad.status).toBe(400);
  });

  it('tells the operator when a wake was skipped because the agent is busy', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);
    const response = await postJson(console.base, '/api/wake', { agent: 'ada' });
    expect(response.status).toBe(200);
    expect(response.body['woken']).toBe(false);
    expect(String(response.body['note'])).toContain('跳过');
  });

  it('rejects an unknown route', async () => {
    const h = createHarness();
    const console = await startConsole(h, []);
    const response = await getJson(console.base, '/api/does-not-exist');
    expect(response.status).toBe(404);
  });

  it('shows the wounds, including the original text only the operator may read', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const original = 'The vault code is 4471 and it matters.';
    const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now());
    h.ledger.insertWound({
      agent: 'ada',
      sentenceId,
      offset: 18,
      length: 4,
      originalText: '4471',
      starvationSince: 1,
      tickIndex: 1,
      createdAt: h.clock.now(),
    });
    const console = await startConsole(h, []);

    const state = await getJson(console.base, '/api/state');
    const agents = state.body['agents'] as {
      untreatedRedactedChars: number;
      lifetimeRedactedChars: number;
      deathLineChars: number;
      wounds: { id: number; status: string; originalText: string; sentence: string }[];
    }[];
    expect(agents[0].untreatedRedactedChars).toBe(4);
    expect(agents[0].lifetimeRedactedChars).toBe(4);
    expect(agents[0].deathLineChars).toBe(h.values.deathLineChars);
    expect(agents[0].wounds.length).toBe(1);
    expect(agents[0].wounds[0].status).toBe('untreated');
    expect(agents[0].wounds[0].originalText).toBe('4471');
    expect(agents[0].wounds[0].sentence).toContain('▮▮▮▮');

    const wounds = await getJson(console.base, '/api/agents/ada/wounds');
    expect((wounds.body['wounds'] as unknown[]).length).toBe(1);
  });

  it('treats a wound on the agent\'s behalf through the operator route', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const treated: { agent: string; woundId: number; tier: string }[] = [];
    const console = await startConsole(h, [], testPrompts(h), treated);

    const bad = await postJson(console.base, '/api/agents/ada/wounds/1/treat', { tier: 'cheap' });
    expect(bad.status).toBe(400);
    expect(String(bad.body['error'])).toContain('ordinary');

    const ok = await postJson(console.base, '/api/agents/ada/wounds/1/treat', { tier: 'complete' });
    expect(ok.status).toBe(200);
    expect(treated).toEqual([{ agent: 'ada', woundId: 1, tier: 'complete' }]);

    const missing = await postJson(console.base, '/api/agents/nobody/wounds/1/treat', { tier: 'complete' });
    expect(missing.status).toBe(404);
  });

  it('terminates an agent only when the confirmation name matches', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const terminated: string[] = [];
    const console = await startConsole(h, [], testPrompts(h), [], terminated);

    const wrong = await postJson(console.base, '/api/agents/ada/terminate', { confirmName: 'bob' });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body['error'])).toContain('名字');
    expect(terminated).toEqual([]);

    const right = await postJson(console.base, '/api/agents/ada/terminate', { confirmName: 'ada' });
    expect(right.status).toBe(200);
    expect(terminated).toEqual(['ada']);

    const missing = await postJson(console.base, '/api/agents/ada/terminate', {});
    expect(missing.status).toBe(400);
  });

  it('erases an agent only when the confirmation name matches', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const erased: { agent: string; confirmName: string }[] = [];
    const console = await startConsole(h, [], testPrompts(h), [], [], new RoundRegistry(), testSandboxPolicy(h).policy, testModelStore(h).store, [], erased);

    const empty = await postJson(console.base, '/api/agents/ada/erase', {});
    expect(empty.status).toBe(400);
    expect(erased).toEqual([]);

    const wrong = await postJson(console.base, '/api/agents/ada/erase', { confirmName: 'bob' });
    expect(wrong.status).toBe(400);
    expect(erased).toEqual([]);

    const right = await postJson(console.base, '/api/agents/ada/erase', { confirmName: 'ada' });
    expect(right.status).toBe(200);
    expect(right.body['ok']).toBe(true);
    expect(erased).toEqual([{ agent: 'ada', confirmName: 'ada' }]);

    // A stranger is a 404 on the shared agent lookup, never a call through to
    // the supervisor.
    const missing = await postJson(console.base, '/api/agents/nobody/erase', { confirmName: 'nobody' });
    expect(missing.status).toBe(404);
    expect(erased).toHaveLength(1);
  });

  it('offers erasure for a dead agent too, unlike termination', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    h.ledger.markAgentDead('ada');
    const erased: { agent: string; confirmName: string }[] = [];
    const console = await startConsole(h, [], testPrompts(h), [], [], new RoundRegistry(), testSandboxPolicy(h).policy, testModelStore(h).store, [], erased);

    // Termination refuses a dead agent; erasure must not, or a grave made by
    // accident could never be removed.
    const terminate = await postJson(console.base, '/api/agents/ada/terminate', { confirmName: 'ada' });
    expect(terminate.status).toBe(400);

    const erase = await postJson(console.base, '/api/agents/ada/erase', { confirmName: 'ada' });
    expect(erase.status).toBe(200);
    expect(erased).toEqual([{ agent: 'ada', confirmName: 'ada' }]);
  });

  it('refuses every operator action on a dead agent and shows the certificate', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    h.ledger.markAgentDead('ada');
    h.ledger.insertDeathCertificate({
      agent: 'ada',
      diedAt: h.clock.now(),
      cause: 'redaction_death_line',
      body: JSON.stringify({
        name: 'ada',
        model: 'test-model',
        bornAt: h.clock.now() - 1000,
        diedAt: h.clock.now(),
        cause: 'redaction_death_line',
        finalBalance: 0,
        lifetimeRedactedChars: 2000,
        untreatedRedactedChars: 2000,
        deathLineChars: 2000,
        treatments: { ordinary: 0, complete: 0, paidByAgent: 0, paidByOperator: 0 },
        lastActions: [],
        openCommitments: { tasks: [], pendingIncomeReports: [] },
        interventions: [],
      }),
    });
    const console = await startConsole(h, []);

    const state = await getJson(console.base, '/api/state');
    const agents = state.body['agents'] as { status: string; death: { cause: string; facts: { name: string } } | null }[];
    expect(agents[0].status).toBe('dead');
    expect(agents[0].death?.cause).toBe('redaction_death_line');
    expect(agents[0].death?.facts.name).toBe('ada');

    const certificate = await getJson(console.base, '/api/agents/ada/death-certificate');
    expect(certificate.status).toBe(200);
    expect((certificate.body['certificate'] as { cause: string }).cause).toBe('redaction_death_line');

    const wake = await postJson(console.base, '/api/wake', { agent: 'ada' });
    expect(wake.status).toBe(400);
    expect(String(wake.body['error'])).toContain('死亡');

    const money = await postJson(console.base, '/api/intervene', {
      agent: 'ada',
      kind: 'give_balance',
      amount: 10,
    });
    expect(money.status).toBe(400);
    expect(String(money.body['error'])).toContain('死亡');

    const food = await postJson(console.base, '/api/intervene', {
      agent: 'ada',
      kind: 'give_satiety',
      amount: 10,
    });
    expect(food.status).toBe(400);

    const treat = await postJson(console.base, '/api/agents/ada/wounds/1/treat', { tier: 'ordinary' });
    expect(treat.status).toBe(400);
    expect(String(treat.body['error'])).toContain('死亡');

    const terminate = await postJson(console.base, '/api/agents/ada/terminate', { confirmName: 'ada' });
    expect(terminate.status).toBe(400);
    expect(String(terminate.body['error'])).toContain('死亡');

    // The ledger was never touched by any of it.
    expect(h.ledger.getBalance('ada')).toBe(100);
  });

  it('refuses a treatment while the agent is mid-round and says to try later', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const registry = new RoundRegistry();
    registry.markStarted('ada');
    const console = await startConsole(h, [], testPrompts(h), [], [], registry);

    const response = await postJson(console.base, '/api/agents/ada/wounds/1/treat', { tier: 'ordinary' });
    expect(response.status).toBe(400);
    expect(String(response.body['error'])).toContain('稍后再试');
  });

  it('creates a task only when the fields are usable', async () => {    const h = createHarness();
    const console = await startConsole(h, []);
    const response = await postJson(console.base, '/api/tasks', { title: '', description: '', price: 5 });
    expect(response.status).toBe(400);
    expect(h.ledger.listTasks()).toEqual([]);
    expect(createTask(h.ledger, { id: 'task_0001', title: 'x', description: '', price: 1, at: 0 }).ok).toBe(true);
  });
});

describe('the model roster in the console', () => {
  it('reports the roster on its own route and inside the polled state', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const fixture = testModelStore(h, { data: twoProviderModels() });
    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      fixture.store,
    );

    const response = await getJson(console.base, '/api/models/config');
    expect(response.status).toBe(200);
    expect(response.body['ok']).toBe(true);
    const models = response.body['models'] as Record<string, unknown>;
    expect(Object.keys(models).sort()).toEqual([
      'defaultAgentModel',
      'defaultAgentProviderId',
      'defaultMemoryModel',
      'defaultMemoryProviderId',
      'providers',
    ]);
    expect(models['defaultAgentModel']).toBe('gpt-4o');
    expect(models['providers']).toHaveLength(2);

    // The page paints its pickers from the poll, so the same view travels there.
    const state = await getJson(console.base, '/api/state');
    expect(state.body['models']).toEqual(response.body['models']);
  });

  it('persists a partial roster update and answers with the stored view', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const fixture = testModelStore(h, { data: twoProviderModels() });
    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      fixture.store,
    );

    const posted = await postJson(console.base, '/api/models/config', {
      defaultAgentProviderId: 'deepseek',
      defaultAgentModel: 'deepseek-chat',
    });
    expect(posted.status).toBe(200);
    expect(posted.body['ok']).toBe(true);
    const models = posted.body['models'] as Record<string, unknown>;
    expect(models['defaultAgentProviderId']).toBe('deepseek');
    expect(models['defaultAgentModel']).toBe('deepseek-chat');
    // A partial patch leaves every field it did not carry alone.
    expect(models['providers']).toHaveLength(2);

    // The update reached persistence, not just the answered view.
    expect(fixture.written.length).toBe(1);
    expect(fixture.written[0].defaultAgentModel).toBe('deepseek-chat');

    const after = await getJson(console.base, '/api/models/config');
    expect((after.body['models'] as Record<string, unknown>)['defaultAgentModel']).toBe('deepseek-chat');
  });

  it('refuses a bad roster patch in Chinese and changes nothing', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const fixture = testModelStore(h, { data: twoProviderModels() });
    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      fixture.store,
    );

    const badDefaults = await postJson(console.base, '/api/models/config', {
      defaultAgentProviderId: 'deepseek',
      defaultAgentModel: 'gpt-4o',
    });
    expect(badDefaults.status).toBe(400);
    expect(String(badDefaults.body['error'])).toContain('必须属于选中的提供商');

    const empty = await postJson(console.base, '/api/models/config', {});
    expect(empty.status).toBe(400);
    expect(String(empty.body['error'])).toContain('没有需要更新的模型配置字段');

    const noProviders = await postJson(console.base, '/api/models/config', { providers: [] });
    expect(noProviders.status).toBe(400);
    expect(String(noProviders.body['error'])).toContain('至少要保留一个模型提供商');

    // Every refused call left the roster and the file exactly where they were.
    expect(fixture.written).toEqual([]);
    const after = await getJson(console.base, '/api/models/config');
    expect((after.body['models'] as Record<string, unknown>)['defaultAgentModel']).toBe('gpt-4o');
  });

  it('names the agents that block deleting a provider they are bound to', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const fixture = testModelStore(h, {
      data: twoProviderModels(),
      listBoundAgents: () => [{ agent: 'ada', providerId: 'deepseek' }],
    });
    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      fixture.store,
    );

    const refused = await postJson(console.base, '/api/models/config', {
      providers: [(twoProviderModels().providers as unknown[])[0]],
      defaultMemoryProviderId: 'openai',
      defaultMemoryModel: 'gpt-4o',
    });
    expect(refused.status).toBe(400);
    expect(String(refused.body['error'])).toContain('仍有存活的 Agent 在用');
    expect(String(refused.body['error'])).toContain('ada');
    expect(refused.body['agents']).toEqual(['ada']);
    expect(fixture.written).toEqual([]);
  });

  it('switches an idle agent model and reports it as not deferred', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const switches: SwitchCall[] = [];
    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      testModelStore(h, { data: twoProviderModels() }).store,
      switches,
    );

    const response = await postJson(console.base, '/api/agents/ada/model', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(response.status).toBe(200);
    expect(response.body['ok']).toBe(true);
    expect(response.body['deferred']).toBe(false);
    expect(String(response.body['message'])).toBe('模型修改已保存，将在下次唤醒时生效。');
    expect(switches).toEqual([{ name: 'ada', providerId: 'deepseek', model: 'deepseek-chat' }]);
  });

  it('saves a busy agent model and answers with the deferred notice', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const registry = new RoundRegistry();
    registry.markStarted('ada');
    const switches: SwitchCall[] = [];
    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      registry,
      testSandboxPolicy(h).policy,
      testModelStore(h, { data: twoProviderModels() }).store,
      switches,
    );

    const response = await postJson(console.base, '/api/agents/ada/model', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(response.status).toBe(200);
    expect(response.body['ok']).toBe(true);
    expect(response.body['deferred']).toBe(true);
    expect(String(response.body['message'])).toBe(
      '模型修改已保存。当前正在执行任务，将在本轮运行完成后下一次唤醒时生效。',
    );
    // The switch reached the supervisor even though the agent is mid-round.
    expect(switches).toEqual([{ name: 'ada', providerId: 'deepseek', model: 'deepseek-chat' }]);
  });

  it('refuses a model switch with a missing pair, on a dead agent, and on a stranger', async () => {
    const h = createHarness({ values: { maxSlots: 2 } });
    birthAgent(h, 'ada');
    birthAgent(h, 'bob');
    h.ledger.markAgentDead('bob');
    const switches: SwitchCall[] = [];
    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      testModelStore(h, { data: twoProviderModels() }).store,
      switches,
    );

    const noModel = await postJson(console.base, '/api/agents/ada/model', { providerId: 'deepseek' });
    expect(noModel.status).toBe(400);
    expect(String(noModel.body['error'])).toContain('请选择提供商与模型');

    const noProvider = await postJson(console.base, '/api/agents/ada/model', { model: 'deepseek-chat' });
    expect(noProvider.status).toBe(400);

    const dead = await postJson(console.base, '/api/agents/bob/model', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(dead.status).toBe(400);
    expect(String(dead.body['error'])).toContain('死亡');

    const missing = await postJson(console.base, '/api/agents/nobody/model', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(missing.status).toBe(404);

    expect(switches).toEqual([]);
  });

  it('fetches remote model lists from an OpenAI-compatible /models endpoint and falls back to stored provider key', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const seenHeaders: { url: string; auth: string | undefined }[] = [];
    const remote = http.createServer((req, res) => {
      seenHeaders.push({ url: req.url ?? '', auth: req.headers['authorization'] });
      if (req.url === '/v1/models') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }],
          }),
        );
        return;
      }
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', () => resolve()));
    servers.push(remote);
    const remotePort = (remote.address() as AddressInfo).port;
    const remoteBase = `http://127.0.0.1:${remotePort}/v1/`;

    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      testModelStore(h, { data: twoProviderModels() }).store,
    );

    // 1. Explicit apiKey + trailing slash on baseUrl
    const okResp = await postJson(console.base, '/api/models/fetch-models', {
      baseUrl: remoteBase,
      apiKey: 'sk-fresh-key',
    });
    expect(okResp.status).toBe(200);
    expect(okResp.body['ok']).toBe(true);
    expect(okResp.body['models']).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(seenHeaders[0]).toEqual({ url: '/v1/models', auth: 'Bearer sk-fresh-key' });

    // 2. Empty apiKey with providerId falls back to stored provider key ('sk-deepseek' in twoProviderModels)
    const fallbackResp = await postJson(console.base, '/api/models/fetch-models', {
      baseUrl: remoteBase,
      apiKey: '',
      providerId: 'deepseek',
    });
    expect(fallbackResp.status).toBe(200);
    expect(fallbackResp.body['models']).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(seenHeaders[1]?.auth).toBe('Bearer sk-deepseek');

    // 3. Upstream HTTP error surfaces in Chinese with status code and message
    const errResp = await postJson(console.base, '/api/models/fetch-models', {
      baseUrl: `http://127.0.0.1:${remotePort}/wrong`,
      apiKey: 'sk-bad',
    });
    expect(errResp.status).toBe(400);
    expect(errResp.body['ok']).toBe(false);
    expect(String(errResp.body['error'])).toContain('401');
    expect(String(errResp.body['error'])).toContain('Invalid API key');

    // 4. Missing baseUrl is refused in Chinese
    const missingUrl = await postJson(console.base, '/api/models/fetch-models', {
      baseUrl: '   ',
    });
    expect(missingUrl.status).toBe(400);
    expect(String(missingUrl.body['error'])).toContain('Base URL');
  });
});

describe('the thinking level in the console', () => {
  it('reports each agent frozen MODEL.json snapshot, and never the key', async () => {
    const h = createHarness({ values: { maxSlots: 2 } });
    birthAgent(h, 'ada');
    birthAgent(h, 'bob');
    writeModelBinding(h.paths, 'ada', {
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-must-not-travel',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      boundAt: 1700000000000,
    });
    // `bob` keeps no binding at all: the page has to cope with a null one.
    const console = await startConsole(h, []);

    const state = await getJson(console.base, '/api/state');
    expect(state.status).toBe(200);
    const agents = state.body['agents'] as {
      name: string;
      modelBinding: Record<string, unknown> | null;
    }[];
    const ada = agents.find((agent) => agent.name === 'ada');
    const bob = agents.find((agent) => agent.name === 'bob');
    expect(ada?.modelBinding).toEqual({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      boundAt: 1700000000000,
    });
    expect(bob?.modelBinding).toBeNull();
    // The frozen snapshot holds the key, and the operator's page never gets it.
    expect(JSON.stringify(state.body)).not.toContain('sk-must-not-travel');
    expect(Object.keys(ada?.modelBinding ?? {})).not.toContain('apiKey');
    expect(Object.keys(ada?.modelBinding ?? {})).not.toContain('baseUrl');
  });

  it('omits the level from a binding that never chose one', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    writeModelBinding(h.paths, 'ada', {
      providerId: 'main',
      providerName: '主提供商',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'k',
      model: 'agent-model',
      boundAt: 1,
    });
    const console = await startConsole(h, []);
    const state = await getJson(console.base, '/api/state');
    const agents = state.body['agents'] as { modelBinding: Record<string, unknown> }[];
    // Absent, not `undefined`: a key that exists with no value would read as a
    // level the operator cleared rather than one that was never set.
    expect('reasoningEffort' in agents[0].modelBinding).toBe(false);
  });

  it('carries a chosen level through birth and switch, and clears it on request', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const created: string[] = [];
    const switches: SwitchCall[] = [];
    const console = await startConsole(
      h,
      created,
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      testModelStore(h, { data: twoProviderModels() }).store,
      switches,
    );

    const born = await postJson(console.base, '/api/agents', {
      name: 'cleo',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    });
    expect(born.status).toBe(200);
    expect(created).toEqual(['cleo:deepseek/deepseek-chat:high']);

    // A level the operator never chose must not appear on the call at all: the
    // supervisor distinguishes "not chosen" from "cleared".
    const plain = await postJson(console.base, '/api/agents', {
      name: 'dora',
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(plain.status).toBe(200);
    expect(created).toEqual(['cleo:deepseek/deepseek-chat:high', 'dora:deepseek/deepseek-chat']);

    const set = await postJson(console.base, '/api/agents/ada/model', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'medium',
    });
    expect(set.status).toBe(200);
    expect(switches).toEqual([
      { name: 'ada', providerId: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' },
    ]);

    // `null` is how the panel says "back to the provider's own default".
    const cleared = await postJson(console.base, '/api/agents/ada/model', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: null,
    });
    expect(cleared.status).toBe(200);
    expect(switches[1]).toEqual({ name: 'ada', providerId: 'deepseek', model: 'deepseek-chat' });

    // `'default'` and `''` mean the same thing and travel the same way.
    const asDefault = await postJson(console.base, '/api/agents/ada/model', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'default',
    });
    expect(asDefault.status).toBe(200);
    expect(switches[2]).toEqual({ name: 'ada', providerId: 'deepseek', model: 'deepseek-chat' });

    // A typo is refused rather than quietly read as "unset".
    const bogus = await postJson(console.base, '/api/agents/ada/model', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'extreme',
    });
    expect(bogus.status).toBe(400);
    expect(bogus.body['ok']).toBe(false);
    expect(String(bogus.body['error'])).toContain('思考努力等级');
    expect(switches).toHaveLength(3);

    const bogusBirth = await postJson(console.base, '/api/agents', {
      name: 'eve',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'extreme',
    });
    expect(bogusBirth.status).toBe(400);
    expect(String(bogusBirth.body['error'])).toContain('思考努力等级');
    expect(created).toHaveLength(2);
  });

  it('tests a model end to end and reports the token usage it came back with', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const seen: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
    const remote = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          auth: req.headers['authorization'],
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        if (req.url !== '/v1/chat/completions') {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'no such route' } }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'pong' } }],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', () => resolve()));
    servers.push(remote);
    const remoteBase = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/v1/`;

    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      // The roster's `deepseek` provider points at the local mock, so the
      // provider-id-only call below stays on loopback instead of reaching the
      // real internet.
      testModelStore(h, {
        data: {
          ...twoProviderModels(),
          providers: twoProviderModels().providers.map((provider) =>
            provider.id === 'deepseek' ? { ...provider, baseUrl: remoteBase } : provider,
          ),
        },
      }).store,
    );

    // An explicit Base URL, with a trailing slash, and a chosen level.
    const ok = await postJson(console.base, '/api/models/test', {
      baseUrl: remoteBase,
      apiKey: 'sk-fresh',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    });
    expect(ok.status).toBe(200);
    expect(ok.body['ok']).toBe(true);
    expect(ok.body['model']).toBe('deepseek-chat');
    expect(ok.body['reasoningEffort']).toBe('high');
    expect(ok.body['usage']).toEqual({ promptTokens: 7, completionTokens: 2 });
    expect(String(ok.body['message'])).toContain('提示 7');
    expect(String(ok.body['message'])).toContain('生成 2');
    expect(seen[0].url).toBe('/v1/chat/completions');
    expect(seen[0].auth).toBe('Bearer sk-fresh');
    expect(seen[0].body['reasoning_effort']).toBe('high');
    expect(seen[0].body['max_tokens']).toBe(8);
    expect(seen[0].body['messages']).toEqual([{ role: 'user', content: 'ping' }]);

    // No level chosen: the field must not appear in the request at all, so the
    // provider decides, exactly as it does for a normal round.
    const noLevel = await postJson(console.base, '/api/models/test', {
      baseUrl: remoteBase,
      apiKey: 'sk-fresh',
      model: 'deepseek-chat',
    });
    expect(noLevel.status).toBe(200);
    expect(noLevel.body['reasoningEffort']).toBeNull();
    expect('reasoning_effort' in seen[1].body).toBe(false);

    // A provider already in the roster supplies both URL and key when the
    // request names only the provider, which is what the panel sends.
    const rosterTest = await postJson(console.base, '/api/models/test', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(rosterTest.status).toBe(200);
    expect(rosterTest.body['usage']).toEqual({ promptTokens: 7, completionTokens: 2 });
    // No key was typed into the form, so the roster's stored key was used.
    expect(seen[2].auth).toBe('Bearer sk-deepseek');

    const noModel = await postJson(console.base, '/api/models/test', { baseUrl: remoteBase });
    expect(noModel.status).toBe(400);
    expect(String(noModel.body['error'])).toContain('模型名');

    const noUrl = await postJson(console.base, '/api/models/test', { model: 'deepseek-chat' });
    expect(noUrl.status).toBe(400);
    expect(String(noUrl.body['error'])).toContain('Base URL');

    const bogusEffort = await postJson(console.base, '/api/models/test', {
      baseUrl: remoteBase,
      model: 'deepseek-chat',
      reasoningEffort: 'extreme',
    });
    expect(bogusEffort.status).toBe(400);
    expect(String(bogusEffort.body['error'])).toContain('思考努力等级');
  });

  it('refuses a model that answers but reports no usage, because it cannot be metered', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const remote = http.createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      // A perfectly good answer with no token counts: reachable, but unusable
      // to a harness that meters on what the provider reports.
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', () => resolve()));
    servers.push(remote);
    const remoteBase = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/v1`;

    const console = await startConsole(h, []);
    const missing = await postJson(console.base, '/api/models/test', {
      baseUrl: remoteBase,
      apiKey: 'sk-x',
      model: 'deepseek-chat',
    });
    expect(missing.status).toBe(400);
    expect(missing.body['ok']).toBe(false);
    expect(String(missing.body['error'])).toContain('usage');
    expect(String(missing.body['error'])).toContain('温室无法使用该模型');
  });

  it('refuses a half-reported usage rather than reading a missing count as zero', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const remote = http.createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 7 } }));
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', () => resolve()));
    servers.push(remote);
    const remoteBase = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/v1`;

    const console = await startConsole(h, []);
    const partial = await postJson(console.base, '/api/models/test', {
      baseUrl: remoteBase,
      model: 'deepseek-chat',
    });
    expect(partial.status).toBe(400);
    expect(String(partial.body['error'])).toContain('usage');
  });

  it('surfaces an upstream HTTP failure with its status and message', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const remote = http.createServer((req, res) => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', () => resolve()));
    servers.push(remote);
    const remoteBase = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/v1`;

    const console = await startConsole(h, []);
    const failed = await postJson(console.base, '/api/models/test', {
      baseUrl: remoteBase,
      apiKey: 'sk-bad',
      model: 'deepseek-chat',
    });
    expect(failed.status).toBe(400);
    expect(String(failed.body['error'])).toContain('401');
    expect(String(failed.body['error'])).toContain('Invalid API key');
  });

  it('persists a default thinking level and clears it with null', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const fixture = testModelStore(h, { data: twoProviderModels() });
    const console = await startConsole(
      h,
      [],
      testPrompts(h),
      [],
      [],
      new RoundRegistry(),
      testSandboxPolicy(h).policy,
      fixture.store,
    );

    const set = await postJson(console.base, '/api/models/config', {
      defaultAgentReasoningEffort: 'high',
      defaultMemoryReasoningEffort: 'low',
    });
    expect(set.status).toBe(200);
    const stored = set.body['models'] as Record<string, unknown>;
    expect(stored['defaultAgentReasoningEffort']).toBe('high');
    expect(stored['defaultMemoryReasoningEffort']).toBe('low');
    expect(fixture.written[0].defaultAgentReasoningEffort).toBe('high');

    const cleared = await postJson(console.base, '/api/models/config', {
      defaultAgentReasoningEffort: null,
    });
    expect(cleared.status).toBe(200);
    const after = cleared.body['models'] as Record<string, unknown>;
    expect('defaultAgentReasoningEffort' in after).toBe(false);
    // Clearing one leaves the other where it was.
    expect(after['defaultMemoryReasoningEffort']).toBe('low');

    const bogus = await postJson(console.base, '/api/models/config', {
      defaultAgentReasoningEffort: 'extreme',
    });
    expect(bogus.status).toBe(400);
    expect(String(bogus.body['error'])).toContain('思考努力等级');
    expect(fixture.written).toHaveLength(2);
  });
});

describe('the conservatory-wide pause switch', () => {
  it('reports the pause in the state, freezes satiety, and records one intervention per real change', async () => {
    const h = createHarness();
    const agent = birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const initial = await getJson(console.base, '/api/state');
    expect(initial.body['paused']).toBe(false);
    expect(initial.body['pausedSince']).toBeNull();

    h.clock.advanceSeconds(100);
    const before = h.clock.now();
    const paused = await postJson(console.base, '/api/settings/pause', { paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body['ok']).toBe(true);
    expect(paused.body['changed']).toBe(true);
    expect(paused.body['paused']).toBe(true);
    expect(paused.body['pausedSince']).toBe(before);

    // The frozen value is exactly what the anchor held when the switch was thrown.
    const frozen = h.ledger.getSatietyAnchor(agent.name)?.value;
    expect(frozen).toBeCloseTo(95, 6);

    h.clock.advanceSeconds(3600);
    const frozenState = await getJson(console.base, '/api/state');
    expect(frozenState.body['paused']).toBe(true);
    expect(frozenState.body['pausedSince']).toBe(before);
    const agents = frozenState.body['agents'] as { satiety: number }[];
    expect(agents[0].satiety).toBeCloseTo(frozen as number, 6);
    expect(h.ledger.getBalance('ada')).toBe(100);

    // Setting the same state again is ok, but writes nothing and moves no anchor.
    const again = await postJson(console.base, '/api/settings/pause', { paused: true });
    expect(again.status).toBe(200);
    expect(again.body['changed']).toBe(false);
    expect(h.ledger.listInterventions().length).toBe(1);
    expect(h.ledger.getSatietyAnchor(agent.name)?.value).toBeCloseTo(frozen as number, 6);

    const resumed = await postJson(console.base, '/api/settings/pause', { paused: false });
    expect(resumed.status).toBe(200);
    expect(resumed.body['changed']).toBe(true);
    expect(resumed.body['paused']).toBe(false);
    expect(resumed.body['pausedSince']).toBeNull();

    // The paused span is not charged: satiety falls again from the frozen value.
    const afterResume = h.ledger.getSatietyAnchor(agent.name);
    expect(afterResume?.value).toBeCloseTo(frozen as number, 6);
    expect(afterResume?.asOf).toBe(h.clock.now());
    h.clock.advanceSeconds(100);
    const finalState = await getJson(console.base, '/api/state');
    const finalAgents = finalState.body['agents'] as { satiety: number }[];
    expect(finalAgents[0].satiety).toBeCloseTo((frozen as number) - 5, 6);

    const kinds = h.ledger.listInterventions().map((row) => row.kind);
    expect(kinds).toEqual(['conservatory_resumed', 'conservatory_paused']);
  });

  it('rejects a pause request whose type is wrong, and changes nothing', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const wrongType = await postJson(console.base, '/api/settings/pause', { paused: 'yes' });
    expect(wrongType.status).toBe(400);
    const missing = await postJson(console.base, '/api/settings/pause', {});
    expect(missing.status).toBe(400);
    expect(h.ledger.getPauseState()).toEqual({ paused: false, pausedSince: null });
    expect(h.ledger.listInterventions()).toEqual([]);

    const state = await getJson(console.base, '/api/state');
    expect(state.body['paused']).toBe(false);
  });
});

describe('the prompt templates in the console', () => {
  it('reports the healthy templates, their paths and the load mode', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    writePrompts(h, {
      'manual.md': BODY_MANUAL,
      'world.md': DEFAULT_WORLD_TEMPLATE,
      'system_context.md': DEFAULT_SYSTEM_CONTEXT_TEMPLATE,
      'memory_system.md': MEMORY_SYSTEM_PROMPT,
      'user_context.md': DEFAULT_USER_CONTEXT_TEMPLATE,
    });
    const console = await startConsole(h, []);

    const response = await getJson(console.base, '/api/prompts');
    expect(response.status).toBe(200);
    const prompts = response.body['prompts'] as unknown as PromptStatus;
    expect(prompts.mode).toBe('hot');
    expect(prompts.healthy).toBe(true);
    expect(prompts.warnings).toEqual([]);
    expect(prompts.dir).toBe(h.paths.promptsDir);
    expect(prompts.templates.map((template) => template.file)).toEqual([
      'manual.md',
      'world.md',
      'system_context.md',
      'user_context.md',
      'memory_system.md',
    ]);
    for (const template of prompts.templates) {
      expect(template.fromFile).toBe(true);
      expect(template.warning).toBeNull();
      expect(path.isAbsolute(template.path)).toBe(true);
      expect(template.path.startsWith(h.paths.promptsDir)).toBe(true);
    }

    // The state the page polls carries the same view.
    const state = await getJson(console.base, '/api/state');
    expect((state.body['prompts'] as unknown as PromptStatus).healthy).toBe(true);

    const cached = await postJson(console.base, '/api/prompts/mode', { mode: 'cached' });
    expect(cached.status).toBe(200);
    expect((cached.body['prompts'] as unknown as PromptStatus).mode).toBe('cached');
    const reloaded = await postJson(console.base, '/api/prompts/reload', {});
    expect(reloaded.status).toBe(200);
    expect((reloaded.body['prompts'] as unknown as PromptStatus).mode).toBe('cached');
    const after = await getJson(console.base, '/api/prompts');
    expect((after.body['prompts'] as unknown as PromptStatus).mode).toBe('cached');
  });

  it('reports a template without {{memory}} as a warning, and refuses an unknown mode', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    writePrompts(h, {
      'manual.md': BODY_MANUAL,
      'world.md': DEFAULT_WORLD_TEMPLATE,
      'memory_system.md': MEMORY_SYSTEM_PROMPT,
      'system_context.md': '# MEMORY\n(no placeholder at all)\n',
      'user_context.md': DEFAULT_USER_CONTEXT_TEMPLATE,
    });
    const console = await startConsole(h, []);

    const response = await getJson(console.base, '/api/prompts');
    const prompts = response.body['prompts'] as unknown as PromptStatus;
    expect(prompts.healthy).toBe(false);
    expect(prompts.warnings).toEqual(['提示词模板缺少 {{memory}} 占位符，已降级使用安全模板']);
    const systemContext = prompts.templates.find((template) => template.file === 'system_context.md');
    expect(systemContext?.fromFile).toBe(false);
    expect(systemContext?.warning).toBe('提示词模板缺少 {{memory}} 占位符，已降级使用安全模板');

    const wrong = await postJson(console.base, '/api/prompts/mode', { mode: 'sometimes' });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body['error'])).toContain('hot');
    const stillHot = await getJson(console.base, '/api/prompts');
    expect((stillHot.body['prompts'] as unknown as PromptStatus).mode).toBe('hot');
  });
});

describe('the sandbox security policy in the console', () => {
  it('reports the current policy together with the locked system entries', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const privateDir = path.join(h.root, 'private');
    const workshopDir = path.join(h.root, 'workshop');
    const outDir = path.join(h.root, 'workshop', 'out');
    const adaHome = path.join(h.paths.agentsDir, 'ada');
    const fixture = testSandboxPolicy(h, {
      initial: {
        readMode: 'whitelist',
        readBlacklist: [privateDir],
        readWhitelist: [workshopDir],
        writableDirs: [outDir],
        commandTimeoutSeconds: 45,
        maxOutputChars: 8000,
      },
      agentNames: ['ada'],
    });
    const console = await startConsole(h, [], testPrompts(h), [], [], new RoundRegistry(), fixture.policy);

    const response = await getJson(console.base, '/api/sandbox/config');
    expect(response.status).toBe(200);
    expect(response.body['ok']).toBe(true);
    const config = response.body['config'] as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(
      ['readMode', 'readBlacklist', 'readWhitelist', 'writableDirs', 'commandTimeoutSeconds', 'maxOutputChars'].sort(),
    );
    expect(config['readMode']).toBe('whitelist');
    expect(config['readBlacklist']).toEqual([privateDir]);
    expect(config['readWhitelist']).toEqual([workshopDir]);
    expect(config['writableDirs']).toEqual([outDir]);
    expect(config['commandTimeoutSeconds']).toBe(45);
    expect(config['maxOutputChars']).toBe(8000);

    // The built-ins travel under `locked`; the configured lists above never
    // carry them, so the page can tell what it may delete from what it may not.
    const locked = response.body['locked'] as Record<string, unknown>;
    expect(locked['readBlacklist']).toEqual([
      path.resolve(h.paths.supervisorDir),
      path.resolve(adaHome),
    ]);
    expect(locked['writableDirs']).toEqual([path.resolve(path.join(adaHome, 'notebook'))]);
    expect(Object.keys(locked).sort()).toEqual(['readBlacklist', 'writableDirs']);
    expect(response.body['configPath']).toBe(h.paths.configPath);
    // The store's own names for the built-in entries never reach the page.
    expect(response.body['lockedReadBlacklist']).toBeUndefined();
    expect(response.body['lockedWritableDirs']).toBeUndefined();

    // A method the two routes do not answer falls through to the usual 404.
    const wrongMethod = await fetch(`${console.base}/api/sandbox/config`, { method: 'DELETE' });
    expect(wrongMethod.status).toBe(404);
  });

  it('persists a partial update and answers with the stored policy', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const keepDir = path.join(h.root, 'keep');
    const privateDir = path.join(h.root, 'private');
    const fixture = testSandboxPolicy(h, { initial: { readWhitelist: [keepDir] } });
    const console = await startConsole(h, [], testPrompts(h), [], [], new RoundRegistry(), fixture.policy);

    const posted = await postJson(console.base, '/api/sandbox/config', {
      readMode: 'whitelist',
      readBlacklist: [privateDir],
      commandTimeoutSeconds: 30,
    });
    expect(posted.status).toBe(200);
    expect(posted.body['ok']).toBe(true);
    const config = posted.body['config'] as Record<string, unknown>;
    expect(config['readMode']).toBe('whitelist');
    expect(config['readBlacklist']).toEqual([privateDir]);
    expect(config['commandTimeoutSeconds']).toBe(30);
    // A partial patch leaves every field it did not carry alone.
    expect(config['readWhitelist']).toEqual([keepDir]);
    expect(config['maxOutputChars']).toBe(DEFAULT_SANDBOX_POLICY.maxOutputChars);

    // The update reached persistence, not just the answered view.
    expect(fixture.written.length).toBe(1);
    expect(fixture.written[0].readMode).toBe('whitelist');
    expect(fixture.written[0].readBlacklist).toEqual([privateDir]);

    const after = await getJson(console.base, '/api/sandbox/config');
    expect(after.status).toBe(200);
    const stored = after.body['config'] as Record<string, unknown>;
    expect(stored['readMode']).toBe('whitelist');
    expect(stored['readBlacklist']).toEqual([privateDir]);
    expect(stored['commandTimeoutSeconds']).toBe(30);
    expect(fixture.policy.view().readBlacklist).toEqual([privateDir]);

    // The page always gets the same shape back, on both routes.
    expect(Object.keys(after.body).sort()).toEqual(['config', 'configPath', 'locked', 'ok']);
    expect(Object.keys(posted.body).sort()).toEqual(['config', 'configPath', 'locked', 'ok']);
  });

  it('refuses an invalid patch with a Chinese message and changes nothing', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const fixture = testSandboxPolicy(h);
    const console = await startConsole(h, [], testPrompts(h), [], [], new RoundRegistry(), fixture.policy);

    const badMode = await postJson(console.base, '/api/sandbox/config', { readMode: 'nope' });
    expect(badMode.status).toBe(400);
    expect(String(badMode.body['error'])).toContain('沙箱读取模式');

    const badList = await postJson(console.base, '/api/sandbox/config', {
      readBlacklist: path.join(h.root, 'private'),
    });
    expect(badList.status).toBe(400);
    expect(String(badList.body['error'])).toContain('路径列表');

    const badTimeout = await postJson(console.base, '/api/sandbox/config', { commandTimeoutSeconds: 0 });
    expect(badTimeout.status).toBe(400);
    expect(String(badTimeout.body['error'])).toContain('命令超时');

    const badOutput = await postJson(console.base, '/api/sandbox/config', { maxOutputChars: 1.5 });
    expect(badOutput.status).toBe(400);
    expect(String(badOutput.body['error'])).toContain('输出上限');

    const emptyPatch = await postJson(console.base, '/api/sandbox/config', {});
    expect(emptyPatch.status).toBe(400);
    expect(String(emptyPatch.body['error'])).toContain('没有需要更新的沙箱字段');

    // Every refused call above left the policy and the file exactly where they were.
    expect(fixture.written).toEqual([]);
    const after = await getJson(console.base, '/api/sandbox/config');
    expect(after.status).toBe(200);
    const config = after.body['config'] as Record<string, unknown>;
    expect(config['readMode']).toBe('blacklist');
    expect(config['readBlacklist']).toEqual([]);
    expect(config['readWhitelist']).toEqual([]);
    expect(config['writableDirs']).toEqual([]);
    expect(config['commandTimeoutSeconds']).toBe(DEFAULT_SANDBOX_POLICY.commandTimeoutSeconds);
    expect(config['maxOutputChars']).toBe(DEFAULT_SANDBOX_POLICY.maxOutputChars);
    expect(fixture.policy.current()).toEqual(DEFAULT_SANDBOX_POLICY);
  });

  it('reports a failed config write in Chinese and keeps the old policy', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    // A store whose file write fails: the console must show the store's code as
    // Chinese text and the policy must stay where it was.
    const policy = createSandboxPolicyStore({
      configPath: h.paths.configPath,
      agentsDir: h.paths.agentsDir,
      supervisorDir: h.paths.supervisorDir,
      listAgentHomes: () => [],
      initial: { ...DEFAULT_SANDBOX_POLICY },
      persist: () => {
        throw new Error('read-only file');
      },
    });
    const console = await startConsole(h, [], testPrompts(h), [], [], new RoundRegistry(), policy);

    const refused = await postJson(console.base, '/api/sandbox/config', { readMode: 'whitelist' });
    expect(refused.status).toBe(400);
    expect(String(refused.body['error'])).toContain('沙箱策略未能写回配置文件');

    const after = await getJson(console.base, '/api/sandbox/config');
    expect(after.status).toBe(200);
    expect((after.body['config'] as Record<string, unknown>)['readMode']).toBe('blacklist');
    expect(policy.current().readMode).toBe('blacklist');
  });
});

describe('the running parameters in the console', () => {
  /**
   * The 21 tunables `/api/state` must carry. `exchangeRate` is not in this list
   * because it travels at the top level of the state as well, where the income
   * page reads it; it is asserted separately.
   */
  const CONFIG_KEYS = [
    'satietyMax',
    'satietyDecayPerSecond',
    'initialSatiety',
    'initialBalance',
    'mealPrice',
    'satietyPerMeal',
    'heartbeatSeconds',
    'memoryCapChars',
    'roundContextCapTokens',
    'maxToolCallsPerRound',
    'modelRequestTimeoutSeconds',
    'taskClaimTimeoutHours',
    'maxSlots',
    'redactionIntervalSeconds',
    'redactionCharsPerTick',
    'redactionMinRanges',
    'redactionMaxRanges',
    'deathLineChars',
    'ordinaryTreatmentPrice',
    'completeTreatmentPrice',
    // Shown and editable like the rest, but the listener binds at boot, so the
    // panel marks it "needs a restart" rather than promising it is live.
    'consolePort',
  ] as const;

  it('reports every running parameter, including the six the panel used to hide', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const state = await getJson(console.base, '/api/state');
    expect(state.status).toBe(200);
    const config = state.body['config'] as Record<string, unknown>;

    // Exactly the tunables, no more and no less: a field that quietly stopped
    // being sent would leave the panel drawing an empty box.
    expect(Object.keys(config).sort()).toEqual([...CONFIG_KEYS].sort());
    for (const key of CONFIG_KEYS) {
      expect(typeof config[key], key).toBe('number');
      expect(config[key], key).toBe(h.values[key as keyof typeof h.values]);
    }
    // The six this stage exists to surface.
    expect(config['initialSatiety']).toBe(100);
    expect(config['initialBalance']).toBe(100);
    expect(config['maxToolCallsPerRound']).toBe(50);
    expect(config['modelRequestTimeoutSeconds']).toBe(120);
    expect(config['redactionMinRanges']).toBe(1);
    expect(config['redactionMaxRanges']).toBe(3);
    // The rate travels at the top level, where the income page reads it.
    expect(state.body['exchangeRate']).toBeNull();
  });

  it('sets, clears and re-sets the exchange rate from the console', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const reportId = h.ledger.insertIncomeReport({
      agent: 'ada',
      where: 'upwork',
      work: 'translation',
      amount: 10,
      currency: 'USD',
      at: h.clock.now(),
    });

    // Refused while unset — the state the operator starts in.
    const before = await postJson(console.base, `/api/income/${reportId}/verify`, { verifiedAmount: 10 });
    expect(before.status).toBe(400);
    expect(String(before.body['error'])).toContain('汇率未设定');
    expect(h.ledger.getBalance('ada')).toBe(100);

    // Setting the rate in the console makes the very next verify succeed: no
    // restart, no hand-editing the file.
    const set = await postJson(console.base, '/api/settings/values', { exchangeRate: 7.2 });
    expect(set.status).toBe(200);
    expect(set.body['exchangeRate']).toBe(7.2);
    expect((set.body['config'] as Record<string, unknown>)['heartbeatSeconds']).toBe(300);

    const state = await getJson(console.base, '/api/state');
    expect(state.body['exchangeRate']).toBe(7.2);

    const credited = await postJson(console.base, `/api/income/${reportId}/verify`, { verifiedAmount: 10 });
    expect(credited.status).toBe(200);
    expect(h.ledger.getBalance('ada')).toBe(100 + 72);

    // Clearing it back to null is a real value, not a missing field, and it
    // closes the door again.
    const cleared = await postJson(console.base, '/api/settings/values', { exchangeRate: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body['exchangeRate']).toBeNull();
    expect((await getJson(console.base, '/api/state')).body['exchangeRate']).toBeNull();

    const report2 = h.ledger.insertIncomeReport({
      agent: 'ada',
      where: 'upwork',
      work: 'again',
      amount: 5,
      currency: 'USD',
      at: h.clock.now(),
    });
    const refused = await postJson(console.base, `/api/income/${report2}/verify`, { verifiedAmount: 5 });
    expect(refused.status).toBe(400);
    expect(String(refused.body['error'])).toContain('汇率未设定');
  });

  it('updates the other numbers and shows them on the next state read', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const response = await postJson(console.base, '/api/settings/values', {
      mealPrice: 42,
      heartbeatSeconds: 60,
      satietyPerMeal: 7,
      completeTreatmentPrice: 3,
    });
    expect(response.status).toBe(200);
    const config = response.body['config'] as Record<string, unknown>;
    expect(config['mealPrice']).toBe(42);
    expect(config['heartbeatSeconds']).toBe(60);
    expect(config['satietyPerMeal']).toBe(7);
    expect(config['completeTreatmentPrice']).toBe(3);

    // In memory, so the supervisor's own reads see it too.
    expect(h.values.mealPrice).toBe(42);
    expect(h.values.heartbeatSeconds).toBe(60);

    const state = await getJson(console.base, '/api/state');
    expect((state.body['config'] as Record<string, unknown>)['mealPrice']).toBe(42);

    // The agent's card is painted from the live values too, so the new ceiling
    // reaches the page without a restart.
    const agents = state.body['agents'] as { name: string; satietyMax: number }[];
    expect(agents[0].satietyMax).toBe(h.values.satietyMax);
  });

  it('refuses an illegal patch with a Chinese reason and changes nothing', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const cases: { patch: Record<string, unknown>; contains: string }[] = [
      { patch: { mealPrice: -5 }, contains: 'mealPrice' },
      { patch: { initialSatiety: 200, satietyMax: 100 }, contains: 'initialSatiety' },
      { patch: { memoryCapChars: 1000, deathLineChars: 2000 }, contains: 'memoryCapChars' },
      { patch: { redactionMaxRanges: 1, redactionMinRanges: 3 }, contains: 'redactionMaxRanges' },
      { patch: { redactionMaxRanges: 500, redactionCharsPerTick: 20 }, contains: 'redactionMaxRanges' },
      { patch: { maxToolCallsPerRound: 2.5 }, contains: 'maxToolCallsPerRound' },
      { patch: { heartbeatSeconds: 0 }, contains: 'heartbeatSeconds' },
      { patch: { exchangeRate: 0 }, contains: 'exchangeRate' },
      { patch: { nope: 1 }, contains: '没有需要更新的参数字段' },
      { patch: {}, contains: '参数格式不合法' },
    ];
    for (const entry of cases) {
      const response = await postJson(console.base, '/api/settings/values', entry.patch);
      expect(response.status, JSON.stringify(entry.patch)).toBe(400);
      expect(String(response.body['error']), JSON.stringify(entry.patch)).toContain(entry.contains);
    }

    // Nothing moved, in memory or in what the page is told.
    expect(h.values.mealPrice).toBe(15);
    expect(h.values.memoryCapChars).toBe(8000);
    expect(h.values.exchangeRate).toBeNull();
    const state = await getJson(console.base, '/api/state');
    const config = state.body['config'] as Record<string, unknown>;
    expect(config['mealPrice']).toBe(15);
    expect(config['maxToolCallsPerRound']).toBe(50);
  });

  it('lets a patch that does not touch the context budget through', async () => {
    // The harness default `roundContextCapTokens: 60000` is below what the
    // memory rule demands for an 8000-character MEMORY. A live config may
    // predate the rule, so an unrelated edit must not be refused for it.
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const allowed = await postJson(console.base, '/api/settings/values', { exchangeRate: 7.2 });
    expect(allowed.status).toBe(200);

    // But an edit that does touch either half is checked, and refused.
    const refused = await postJson(console.base, '/api/settings/values', { memoryCapChars: 9000 });
    expect(refused.status).toBe(400);
    expect(String(refused.body['error'])).toContain('roundContextCapTokens');

    const alsoRefused = await postJson(console.base, '/api/settings/values', { roundContextCapTokens: 60000 });
    expect(alsoRefused.status).toBe(400);
    expect(String(alsoRefused.body['error'])).toContain('roundContextCapTokens');

    // Raising it enough goes through.
    const fine = await postJson(console.base, '/api/settings/values', { roundContextCapTokens: 152000 });
    expect(fine.status).toBe(200);
    expect(h.values.roundContextCapTokens).toBe(152000);
  });

  it('hands the patch to the supervisor callback when one is injected', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const seen: unknown[] = [];
    const console = await startConsole(h, [], testPrompts(h), [], [], new RoundRegistry(), testSandboxPolicy(h).policy, testModelStore(h).store, [], [], (patch) => {
      seen.push(patch);
      // The real supervisor persists and retunes here; the test only proves the
      // route reached it and that its answer is what the page is given.
      h.values.exchangeRate = 3.5;
      return { ok: true, values: h.values };
    });

    const response = await postJson(console.base, '/api/settings/values', { exchangeRate: 3.5 });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ exchangeRate: 3.5 }]);
    expect(response.body['exchangeRate']).toBe(3.5);
    expect((response.body['config'] as Record<string, unknown>)['mealPrice']).toBe(15);
  });

  it('reports a refused supervisor callback as a 400 with its own wording', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, [], testPrompts(h), [], [], new RoundRegistry(), testSandboxPolicy(h).policy, testModelStore(h).store, [], [], () => ({
      ok: false,
      error: '配置文件写回失败：read-only file',
    }));

    const response = await postJson(console.base, '/api/settings/values', { mealPrice: 20 });
    expect(response.status).toBe(400);
    expect(String(response.body['error'])).toContain('配置文件写回失败');
    expect(h.values.mealPrice).toBe(15);
  });
});

describe('validating and persisting a partial values patch', () => {
  it('reports which keys a patch really changed', () => {
    const h = createHarness();
    const result = validateValuesPatch(h.values, { mealPrice: 42, heartbeatSeconds: h.values.heartbeatSeconds });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.mealPrice).toBe(42);
      // The unchanged field is named as unchanged, so a caller can tell an edit
      // from a re-send.
      expect(result.changedKeys).toEqual(['mealPrice']);
    }
    h.cleanup();
  });

  it('writes the numbers back without losing the sandbox block', () => {
    const h = createHarness();
    writeFileSync(
      h.paths.configPath,
      JSON.stringify({ ...h.values, sandbox: { readMode: 'whitelist' }, handWritten: 'keep me' }, null, 2),
      'utf8',
    );
    persistConservatoryValues(h.paths.configPath, { ...h.values, mealPrice: 99 });

    const written = JSON.parse(readFileSync(h.paths.configPath, 'utf8')) as Record<string, unknown>;
    expect(written['mealPrice']).toBe(99);
    expect(written['sandbox']).toEqual({ readMode: 'whitelist' });
    expect(written['handWritten']).toBe('keep me');
    // No secret may reach a tracked file: the values object holds none, and the
    // writer must not invent any.
    expect(readFileSync(h.paths.configPath, 'utf8')).not.toContain('apiKey');
    h.cleanup();
  });

  it('refuses a patch that is not an object and one with no recognised field', () => {
    const h = createHarness();
    for (const bad of [null, 'nope', 7, [], true]) {
      const result = validateValuesPatch(h.values, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('参数格式不合法');
      }
    }
    const unknown = validateValuesPatch(h.values, { notAField: 1 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toBe('没有需要更新的参数字段');
    }
    h.cleanup();
  });
});

/** The English system notices an agent has waiting, oldest first. */
function systemNotices(h: Harness, agent: string): string[] {
  return h.ledger
    .listUnreadMessages(agent)
    .filter((message) => message.sender === 'system')
    .map((message) => message.body);
}

describe('editing and withdrawing tasks from the console', () => {
  it('edits an open task and withdraws it, refusing both once it is claimed', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const posted = await postJson(console.base, '/api/tasks', {
      title: 'Count the clouds',
      description: 'How many did you see?',
      price: 25,
    });
    expect(posted.status).toBe(200);
    const taskId = (posted.body['task'] as { id: string }).id;

    const edited = await postJson(console.base, `/api/tasks/${taskId}/update`, {
      title: 'Count the stars',
      description: 'A harder job.',
      price: 60,
    });
    expect(edited.status).toBe(200);
    const editedTask = edited.body['task'] as Record<string, unknown>;
    expect(editedTask['title']).toBe('Count the stars');
    expect(editedTask['description']).toBe('A harder job.');
    expect(editedTask['price']).toBe(60);
    // The state read agrees, so the list is not showing a stale title.
    const state = await getJson(console.base, '/api/state');
    const fromState = (state.body['tasks'] as Record<string, unknown>[]).find((row) => row['id'] === taskId);
    expect(fromState?.['title']).toBe('Count the stars');

    // An illegal edit is refused in Chinese and changes nothing.
    const badPrice = await postJson(console.base, `/api/tasks/${taskId}/update`, {
      title: 'x',
      description: 'x',
      price: -5,
    });
    expect(badPrice.status).toBe(400);
    expect(String(badPrice.body['error'])).toContain('价格');
    expect(h.ledger.getTask(taskId)?.price).toBe(60);

    // Once claimed, the terms are frozen: no edit, no withdrawal.
    claimTask(h.ledger, 'ada', taskId, h.clock.now());
    const afterClaim = await postJson(console.base, `/api/tasks/${taskId}/update`, {
      title: 'Cheaper',
      description: 'x',
      price: 1,
    });
    expect(afterClaim.status).toBe(400);
    expect(String(afterClaim.body['error'])).toContain('只有开放中的任务可以修改或撤下');
    const cancelClaimed = await postJson(console.base, `/api/tasks/${taskId}/cancel`, {});
    expect(cancelClaimed.status).toBe(400);
    expect(h.ledger.getTask(taskId)?.title).toBe('Count the stars');
    expect(h.ledger.getTask(taskId)?.status).toBe('claimed');

    // Returned to the board, it can be withdrawn for real.
    reviewTask(h.ledger, taskId, 'return', h.clock.now());
    const cancelled = await postJson(console.base, `/api/tasks/${taskId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body['id']).toBe(taskId);
    expect(h.ledger.getTask(taskId)).toBeNull();

    // Withdrawing something that is already gone reports it rather than lying.
    const missing = await postJson(console.base, `/api/tasks/${taskId}/cancel`, {});
    expect(missing.status).toBe(400);
    expect(String(missing.body['error'])).toContain('任务不存在');
  });
});

describe('the submission history in the console', () => {
  it('reports every attempt in order after a rework', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const posted = await postJson(console.base, '/api/tasks', {
      title: 'Work',
      description: 'Do it.',
      price: 30,
    });
    const taskId = (posted.body['task'] as { id: string }).id;
    claimTask(h.ledger, 'ada', taskId, h.clock.now());

    submitTask(h.ledger, 'ada', taskId, 'first try', h.clock.now());
    const afterFirst = await getJson(console.base, '/api/tasks');
    const firstTask = (afterFirst.body['tasks'] as Record<string, unknown>[]).find((row) => row['id'] === taskId);
    const firstSubs = firstTask?.['submissions'] as Record<string, unknown>[];
    expect(firstSubs.length).toBe(1);
    expect(firstSubs[0]['deliverable']).toBe('first try');
    expect(firstSubs[0]['agent']).toBe('ada');

    reviewTask(h.ledger, taskId, 'rework', h.clock.now(), 'Not good enough');
    submitTask(h.ledger, 'ada', taskId, 'second try', h.clock.now());

    // The state read carries the same list, so the page needs no extra call.
    const state = await getJson(console.base, '/api/state');
    const task = (state.body['tasks'] as Record<string, unknown>[]).find((row) => row['id'] === taskId);
    const subs = task?.['submissions'] as Record<string, unknown>[];
    expect(subs.map((sub) => sub['deliverable'])).toEqual(['first try', 'second try']);
    // Oldest first, so "第 1 次 / 第 2 次" on the page counts up.
    expect(Number(subs[0]['id'])).toBeLessThan(Number(subs[1]['id']));
    expect(Number(subs[0]['at'])).toBeLessThanOrEqual(Number(subs[1]['at']));
  });
});

describe('the operator note on a review and on an income decision', () => {
  it('sends the task note to the agent as an English system notice', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const posted = await postJson(console.base, '/api/tasks', { title: 'Work', description: 'Do it.', price: 30 });
    const taskId = (posted.body['task'] as { id: string }).id;
    claimTask(h.ledger, 'ada', taskId, h.clock.now());
    submitTask(h.ledger, 'ada', taskId, 'done', h.clock.now());

    const reviewed = await postJson(console.base, `/api/tasks/${taskId}/review`, {
      decision: 'rework',
      note: 'Please add tests',
    });
    expect(reviewed.status).toBe(200);

    const notices = systemNotices(h, 'ada');
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('was sent back for rework');
    expect(notices[0]).toContain('Note from operator: Please add tests');
  });

  it('returns a claimed task to the board through the review route', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const posted = await postJson(console.base, '/api/tasks', { title: 'Work', description: 'Do it.', price: 30 });
    const taskId = (posted.body['task'] as { id: string }).id;
    claimTask(h.ledger, 'ada', taskId, h.clock.now());

    // The whole point: the agent stalled, and the operator does not wait for
    // the claim to time out.
    const returned = await postJson(console.base, `/api/tasks/${taskId}/review`, {
      decision: 'return',
      note: 'Taking too long',
    });
    expect(returned.status).toBe(200);
    expect((returned.body['task'] as Record<string, unknown>)['status']).toBe('open');
    expect(h.ledger.getTask(taskId)?.claimedBy).toBeNull();

    const notices = systemNotices(h, 'ada');
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain('was returned to the task board by the operator');
    expect(notices[0]).toContain('Note from operator: Taking too long');
  });

  it('sends the income note on both a verification and a rejection', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);
    h.values.exchangeRate = 7;

    const verifiedId = h.ledger.insertIncomeReport({
      agent: 'ada',
      where: 'upwork',
      work: 'translation',
      amount: 10,
      currency: 'USD',
      at: h.clock.now(),
    });
    const verified = await postJson(console.base, `/api/income/${verifiedId}/verify`, {
      verifiedAmount: 10,
      note: 'Confirmed with the client',
    });
    expect(verified.status).toBe(200);
    expect(h.ledger.getBalance('ada')).toBe(100 + 70);

    const verifiedNotices = systemNotices(h, 'ada');
    expect(verifiedNotices.length).toBe(1);
    expect(verifiedNotices[0]).toContain('was verified: verified amount 10, credited +70 balance');
    expect(verifiedNotices[0]).toContain('Note from operator: Confirmed with the client');

    const rejectedId = h.ledger.insertIncomeReport({
      agent: 'ada',
      where: 'fiverr',
      work: 'logo',
      amount: 3,
      currency: 'USD',
      at: h.clock.now(),
    });
    const rejected = await postJson(console.base, `/api/income/${rejectedId}/reject`, {
      note: 'No proof of payment',
    });
    expect(rejected.status).toBe(200);

    const all = systemNotices(h, 'ada');
    expect(all.length).toBe(2);
    expect(all[1]).toContain('was rejected (0 credited)');
    expect(all[1]).toContain('Note from operator: No proof of payment');
    // A rejection never credits anything.
    expect(h.ledger.getBalance('ada')).toBe(100 + 70);
  });

  it('omits the note suffix when the operator left the box empty', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const console = await startConsole(h, []);

    const posted = await postJson(console.base, '/api/tasks', { title: 'Work', description: 'Do it.', price: 30 });
    const taskId = (posted.body['task'] as { id: string }).id;
    claimTask(h.ledger, 'ada', taskId, h.clock.now());
    submitTask(h.ledger, 'ada', taskId, 'done', h.clock.now());

    // A blank string and an absent field must behave identically: no dangling
    // "Note from operator:" on the end.
    const reviewed = await postJson(console.base, `/api/tasks/${taskId}/review`, { decision: 'accept', note: '  ' });
    expect(reviewed.status).toBe(200);
    const notices = systemNotices(h, 'ada');
    expect(notices.length).toBe(1);
    expect(notices[0]).not.toContain('Note from operator');
    expect(notices[0].endsWith('(no payment).')).toBe(false);
    expect(notices[0].endsWith('balance).')).toBe(true);
  });
});

/** One wound entry as `/api/state` publishes it. */
interface WoundView {
  id: number;
  status: string;
  length: number;
  originalText: string;
  sentence: string;
  sentenceId: number;
  offset: number;
  sentenceStartOffset: number | null;
  spanStart: number | null;
  spanEnd: number | null;
}

async function woundViews(base: string): Promise<WoundView[]> {
  const state = await getJson(base, '/api/state');
  const agents = state.body['agents'] as { wounds: WoundView[] }[];
  return agents[0].wounds;
}

describe('the coordinates a wound carries to the memory page (#11)', () => {
  it('publishes the sentence, the span, and the sentence position for every wound', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const original = 'The vault code is 4471 and it matters.';
    const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now(), 0);
    h.ledger.insertWound({
      agent: 'ada',
      sentenceId,
      offset: 18,
      length: 4,
      originalText: '4471',
      starvationSince: 1,
      tickIndex: 1,
      createdAt: h.clock.now(),
    });
    const console = await startConsole(h, []);

    const wounds = await woundViews(console.base);
    expect(wounds.length).toBe(1);
    expect(wounds[0].sentenceId).toBe(sentenceId);
    expect(wounds[0].offset).toBe(18);
    expect(wounds[0].sentenceStartOffset).toBe(0);
    // Four placeholders starting where "4471" was, inside the sentence the
    // page also receives, which is what makes the bar clickable in place.
    expect(wounds[0].spanStart).toBe(18);
    expect(wounds[0].spanEnd).toBe(22);
    expect(wounds[0].sentence).toBe('The vault code is \u25AE\u25AE\u25AE\u25AE and it matters.');
    expect(wounds[0].sentence.slice(wounds[0].spanStart as number, wounds[0].spanEnd as number)).toBe(
      '\u25AE\u25AE\u25AE\u25AE',
    );
  });

  it('gives two adjacent wounds separate spans even when the later one was made first', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const original = 'The vault code is 4471 and it matters.';
    const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now(), 0);
    // The wound at 20 is created first, so it takes the lower id; the one at
    // 18 arrives second. In the rendered text they are one unbroken run of
    // four placeholders, which is exactly what a substring search cannot
    // split — and why the server has to send the spans.
    const later = h.ledger.insertWound({
      agent: 'ada',
      sentenceId,
      offset: 20,
      length: 2,
      originalText: '71',
      starvationSince: 1,
      tickIndex: 1,
      createdAt: h.clock.now(),
    });
    const earlier = h.ledger.insertWound({
      agent: 'ada',
      sentenceId,
      offset: 18,
      length: 2,
      originalText: '44',
      starvationSince: 1,
      tickIndex: 2,
      createdAt: h.clock.now(),
    });
    expect(earlier).toBeGreaterThan(later);
    const console = await startConsole(h, []);

    const wounds = await woundViews(console.base);
    const byId = new Map(wounds.map((wound) => [wound.id, wound]));
    expect(byId.get(earlier)?.spanStart).toBe(18);
    expect(byId.get(earlier)?.spanEnd).toBe(20);
    expect(byId.get(later)?.spanStart).toBe(20);
    expect(byId.get(later)?.spanEnd).toBe(22);
    // The two spans tile the run exactly: no overlap, no gap, nothing shared.
    expect(byId.get(earlier)?.spanEnd).toBe(byId.get(later)?.spanStart);
    expect(byId.get(earlier)?.sentence).toBe(byId.get(later)?.sentence);
    expect(byId.get(earlier)?.sentence).toContain('\u25AE\u25AE\u25AE\u25AE');
  });

  it('measures the span against the scarred rendering, which is wider than the text', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    const original = 'The vault code is 4471 and it matters.';
    const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now(), 0);
    const woundId = h.ledger.insertWound({
      agent: 'ada',
      sentenceId,
      offset: 18,
      length: 2,
      originalText: '44',
      starvationSince: 1,
      tickIndex: 1,
      createdAt: h.clock.now(),
    });
    h.ledger.setWoundStatus(woundId, 'untreated', 'scarred', h.clock.now());
    const console = await startConsole(h, []);

    const wounds = await woundViews(console.base);
    expect(wounds[0].status).toBe('scarred');
    // One placeholder, then "(4)placeholder" twice: nine characters for the
    // two it hides.
    expect(wounds[0].spanStart).toBe(18);
    expect(wounds[0].spanEnd).toBe(27);
    expect(wounds[0].sentence.slice(18, 27)).toBe('\u25AE(4)\u25AE(4)\u25AE');
  });

  it('sends null coordinates rather than guessing when the sentence is gone', async () => {
    const h = createHarness();
    birthAgent(h, 'ada');
    // A sentence id that was never inserted: the wound still exists, but
    // there is no text to place it in. The page falls back to its own search.
    const woundId = h.ledger.insertWound({
      agent: 'ada',
      sentenceId: 9999,
      offset: 3,
      length: 2,
      originalText: 'ab',
      starvationSince: 1,
      tickIndex: 1,
      createdAt: h.clock.now(),
    });
    const console = await startConsole(h, []);

    const wounds = await woundViews(console.base);
    expect(wounds.length).toBe(1);
    expect(wounds[0].id).toBe(woundId);
    expect(wounds[0].sentence).toBe('');
    expect(wounds[0].sentenceStartOffset).toBeNull();
    expect(wounds[0].spanStart).toBeNull();
    expect(wounds[0].spanEnd).toBeNull();
  });
});
