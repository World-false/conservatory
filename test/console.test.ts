import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConsoleServer } from '../src/console/server';
import { RoundRegistry } from '../src/organs/population';
import { claimTask, createTask, submitTask } from '../src/organs/taskboard';
import { birthAgent, createHarness, type Harness } from './helpers';

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

async function startConsole(h: Harness, created: string[]): Promise<RunningConsole> {
  const registry = new RoundRegistry();
  const server = createConsoleServer({
    values: h.values,
    paths: h.paths,
    ledger: h.ledger,
    blackbox: h.blackbox,
    registry,
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
