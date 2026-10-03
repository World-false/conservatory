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
  DEFAULT_USER_CONTEXT_TEMPLATE,
  type PromptLibrary,
  type PromptStatus,
} from '../src/organs/prompts';
import { claimTask, createTask, submitTask } from '../src/organs/taskboard';
import { birthAgent, createHarness, testPrompts, writePrompts, type Harness } from './helpers';

interface RunningConsole {
  server: http.Server;
  base: string;
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

async function startConsole(
  h: Harness,
  created: string[],
  prompts: PromptLibrary = testPrompts(h),
): Promise<RunningConsole> {
  const registry = new RoundRegistry();
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
    indexHtmlPath: path.join(process.cwd(), 'src', 'console', 'public', 'index.html'),
    now: h.clock.now,
    getRuntime: () => ({
      busy: registry.busyAgents().length > 0,
      lastWakeAt: null,
      lastRoundAt: null,
      lastRoundEndReason: null,
      lastError: null,
    }),
    createAgent: async (name) => {
      created.push(name);
      return { ok: true };
    },
    wakeAgent: async () => ({ ok: true, woken: false, reason: '该 agent 正在一轮中，本次唤醒已跳过' }),
    setPaused: (paused) => ({
      ok: true,
      changed: pause.set(paused, h.clock.now()).changed,
      state: pause.read(),
    }),
    intervene: async () => ({ ok: true, balance: 110, satiety: 100 }),
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

  it('creates a task only when the fields are usable', async () => {
    const h = createHarness();
    const console = await startConsole(h, []);
    const response = await postJson(console.base, '/api/tasks', { title: '', description: '', price: 5 });
    expect(response.status).toBe(400);
    expect(h.ledger.listTasks()).toEqual([]);
    expect(createTask(h.ledger, { id: 'task_0001', title: 'x', description: '', price: 1, at: 0 }).ok).toBe(true);
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
      'user_context.md': '=== MEMORY ===\n(no placeholder at all)\n',
    });
    const console = await startConsole(h, []);

    const response = await getJson(console.base, '/api/prompts');
    const prompts = response.body['prompts'] as unknown as PromptStatus;
    expect(prompts.healthy).toBe(false);
    expect(prompts.warnings).toEqual(['提示词模板缺少 {{memory}} 占位符，已降级使用安全模板']);
    const userContext = prompts.templates.find((template) => template.file === 'user_context.md');
    expect(userContext?.fromFile).toBe(false);
    expect(userContext?.warning).toBe('提示词模板缺少 {{memory}} 占位符，已降级使用安全模板');

    const wrong = await postJson(console.base, '/api/prompts/mode', { mode: 'sometimes' });
    expect(wrong.status).toBe(400);
    expect(String(wrong.body['error'])).toContain('hot');
    const stillHot = await getJson(console.base, '/api/prompts');
    expect((stillHot.body['prompts'] as unknown as PromptStatus).mode).toBe('hot');
  });
});
