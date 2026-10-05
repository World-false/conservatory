import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConsoleServer } from '../src/console/server';
import { BODY_MANUAL } from '../src/organs/manual';
import { MEMORY_SYSTEM_PROMPT } from '../src/organs/memory';
import { createPauseOrgan } from '../src/organs/pause';
import { RoundRegistry } from '../src/organs/population';
import {
  DEFAULT_SYSTEM_CONTEXT_TEMPLATE,
  DEFAULT_USER_CONTEXT_TEMPLATE,
  type PromptLibrary,
  type PromptStatus,
} from '../src/organs/prompts';
import { claimTask, createTask, submitTask } from '../src/organs/taskboard';
import {
  createSandboxPolicyStore,
  DEFAULT_SANDBOX_POLICY,
  type SandboxPolicyConfig,
  type SandboxPolicyStore,
} from '../src/organs/sandbox/policy';
import type { ModelConfigStore } from '../src/organs/models/store';
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
    createAgent: async (name, providerId, model) => {
      created.push(providerId === undefined && model === undefined ? name : `${name}:${providerId}/${model}`);
      return { ok: true };
    },
    switchAgentModel: (name, providerId, model) => {
      switches.push({ name, providerId, model });
      return registry.isBusy(name)
        ? {
            ok: true,
            deferred: true,
            message: '模型修改已保存。当前正在执行任务，将在本轮运行完成后下一次唤醒时生效。',
          }
        : { ok: true, deferred: false, message: '模型修改已保存，将在下次唤醒时生效。' };
    },
    wakeAgent: async () => ({ ok: true, woken: false, reason: '该 agent 正在一轮中，本次唤醒已跳过' }),
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
