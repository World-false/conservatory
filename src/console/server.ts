import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { ConservatoryValues, RuntimePaths } from '../config';
import { verifyIncome, rejectIncome, type IncomeResult } from '../organs/income';
import type { IncomeReportRecord, InterventionKind, Ledger, PauseState, TaskRecord } from '../organs/ledger';
import { readSatiety } from '../organs/metabolism';
import { readMemoryFile } from '../organs/memory';
import { NotebookError, listNotebook, readNotebookFile } from '../organs/notebook';
import type { PromptLibrary } from '../organs/prompts';
import { createTask, reviewTask, type ReviewDecision } from '../organs/taskboard';
import type { Blackbox } from '../organs/blackbox';
import type { RoundRegistry } from '../organs/population';

export interface RuntimeInfo {
  busy: boolean;
  lastWakeAt: number | null;
  lastRoundAt: number | null;
  lastRoundEndReason: string | null;
  lastError: string | null;
}

export interface ConsoleNotice {
  at: number;
  agent: string;
  message: string;
}

export interface ConsoleDeps {
  values: ConservatoryValues;
  paths: RuntimePaths;
  ledger: Ledger;
  blackbox: Blackbox;
  registry: RoundRegistry;
  /** The live prompt templates: the console reports them and switches their mode. */
  prompts: PromptLibrary;
  indexHtmlPath: string;
  now(): number;
  getRuntime(name: string): RuntimeInfo;
  createAgent(name: string): Promise<{ ok: true } | { ok: false; error: string }>;
  wakeAgent(
    name: string,
  ): Promise<{ ok: true; woken: boolean; reason: string | null } | { ok: false; error: string }>;
  /**
   * The conservatory-wide pause switch. Returns whether the call was a real
   * transition; the implementation records the intervention and freezes or
   * releases the anchors. `false` means the request matched the state already
   * in force, and then nothing at all was written.
   */
  setPaused(paused: boolean): { ok: true; changed: boolean; state: PauseState };
  intervene(
    agent: string,
    kind: InterventionKind,
    amount: number,
  ): Promise<{ ok: true; balance: number; satiety: number } | { ok: false; error: string }>;
  getNotices(): ConsoleNotice[];
}

const MAX_BODY_BYTES = 256 * 1024;

/** Operator-facing text is Chinese; everything an agent sees stays English. */
const MESSAGES: Record<string, string> = {
  agent_not_found: '没有这个 agent',
  invalid_name: '名字只能包含小写字母、数字和下划线',
  name_taken: '这个名字已经被占用',
  no_free_slot: '没有空槽位（第 1 步只允许 1 个活着的 agent）',
  home_exists: 'AGENTS 下已存在同名目录',
  invalid_title: '标题不能为空',
  invalid_price: '价格必须是不小于 0 的数字',
  invalid_deliverable: '交付内容不能为空',
  task_not_found: '任务不存在',
  task_not_open: '任务不是待认领状态',
  task_not_claimed_by_you: '该任务不由这个 agent 持有',
  task_not_submitted: '任务不在待审核状态',
  report_not_found: '收入申报不存在',
  report_not_pending: '该收入申报已经处理过了',
  exchange_rate_unset: '汇率未设定：请在 conservatory.config.json 里设置 exchangeRate 后再核验入账',
  invalid_amount: '金额必须是不小于 0 的数字',
  invalid_field: '字段不合法',
  empty_path: '记事本路径不能为空',
  drive_letter: '记事本路径不允许盘符',
  absolute_path: '记事本路径不允许绝对路径',
  parent_traversal: '记事本路径不允许 .. 上跳',
  outside_notebook: '记事本路径超出 notebook 目录',
  symlink_not_allowed: '记事本路径不允许符号链接',
  not_a_file: '不是记事本文件',
  not_found: '记事本里没有这个文件',
  agent_busy: '该 agent 正在一轮中，本次唤醒已跳过',
  invalid_amount_intervention: '干预数量必须是不小于 0 的数字',
  invalid_paused: 'paused 必须是 true 或 false',
  invalid_prompt_mode: '提示词加载模式必须是 hot 或 cached',
};

function messageFor(code: string): string {
  return MESSAGES[code] ?? code;
}

function taskView(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    price: task.price,
    status: task.status,
    claimedBy: task.claimedBy,
    claimedAt: task.claimedAt,
    submittedAt: task.submittedAt,
    deliverable: task.deliverable,
    createdAt: task.createdAt,
    decidedAt: task.decidedAt,
    decision: task.decision,
  };
}

function incomeView(report: IncomeReportRecord): Record<string, unknown> {
  return {
    id: report.id,
    agent: report.agent,
    where: report.where,
    work: report.work,
    amount: report.amount,
    currency: report.currency,
    status: report.status,
    verifiedAmount: report.verifiedAmount,
    exchangeRate: report.exchangeRate,
    credited: report.credited,
    createdAt: report.createdAt,
    decidedAt: report.decidedAt,
  };
}

function incomeError(result: IncomeResult): string {
  return result.ok ? '' : messageFor(result.code);
}

export function createConsoleServer(deps: ConsoleDeps): http.Server {
  return http.createServer((request, response) => {
    void handle(deps, request, response);
  });
}

async function handle(
  deps: ConsoleDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  try {
    await route(deps, request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { ok: false, error: `控制台内部错误：${message}` });
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (text.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`请求体不是合法 JSON：${detail}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是一个 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildState(deps: ConsoleDeps): Record<string, unknown> {
  const { ledger, values } = deps;
  const now = deps.now();
  const pause = ledger.getPauseState();
  const agents = ledger.listAgents().map((agent) => {
    const runtime = deps.getRuntime(agent.name);
    const anchor = ledger.getSatietyAnchor(agent.name);
    return {
      name: agent.name,
      bornAt: agent.bornAt,
      model: agent.model,
      status: agent.status,
      satiety: anchor === null ? null : readSatiety(ledger, values, agent.name, now),
      satietyMax: values.satietyMax,
      balance: ledger.getBalance(agent.name),
      busy: deps.registry.isBusy(agent.name),
      lastWakeAt: runtime.lastWakeAt,
      lastRoundAt: runtime.lastRoundAt,
      lastRoundEndReason: runtime.lastRoundEndReason,
      lastError: runtime.lastError,
      tokens: {
        agent: ledger.sumUsage(agent.name, 'agent'),
        memory: ledger.sumUsage(agent.name, 'memory'),
      },
    };
  });
  return {
    now,
    exchangeRate: values.exchangeRate,
    paused: pause.paused,
    pausedSince: pause.pausedSince,
    prompts: deps.prompts.status(),
    config: {
      satietyMax: values.satietyMax,
      satietyDecayPerSecond: values.satietyDecayPerSecond,
      mealPrice: values.mealPrice,
      satietyPerMeal: values.satietyPerMeal,
      heartbeatSeconds: values.heartbeatSeconds,
      memoryCapChars: values.memoryCapChars,
      roundContextCapTokens: values.roundContextCapTokens,
      taskClaimTimeoutHours: values.taskClaimTimeoutHours,
      maxSlots: values.maxSlots,
    },
    agents,
    busy: deps.registry.busyAgents(),
    tasks: ledger.listTasks().map(taskView),
    income: ledger.listIncomeReports().map(incomeView),
    messages: ledger
      .listMessagesForOperator()
      .slice(-100)
      .reverse()
      .map((message) => ({
        id: message.id,
        sender: message.sender,
        recipient: message.recipient,
        body: message.body,
        at: message.at,
        readAt: message.readAt,
      })),
    interventions: ledger.listInterventions().map((row) => ({
      id: row.id,
      kind: row.kind,
      agent: row.agent,
      detail: row.detail,
      at: row.at,
    })),
    notices: deps.getNotices(),
  };
}

async function route(
  deps: ConsoleDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter((part) => part !== '');

  if (segments.length === 0) {
    if (method !== 'GET') {
      sendJson(response, 405, { ok: false, error: '只支持 GET' });
      return;
    }
    sendHtml(response, readFileSync(deps.indexHtmlPath, 'utf8'));
    return;
  }

  if (segments[0] !== 'api') {
    sendJson(response, 404, { ok: false, error: '未知路径' });
    return;
  }

  // GET /api/state
  if (segments.length === 2 && segments[1] === 'state' && method === 'GET') {
    sendJson(response, 200, buildState(deps));
    return;
  }

  // POST /api/agents
  if (segments.length === 2 && segments[1] === 'agents' && method === 'POST') {
    const body = await readJsonBody(request);
    const name = readString(body, 'name');
    if (name === null || name.trim() === '') {
      sendJson(response, 400, { ok: false, error: '请填写名字' });
      return;
    }
    const result = await deps.createAgent(name.trim());
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: messageFor(result.error) });
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  // /api/agents/:name/...
  if (segments.length >= 4 && segments[1] === 'agents') {
    const agentName = decodeURIComponent(segments[2]);
    const resource = segments[3];
    if (deps.ledger.getAgent(agentName) === null) {
      sendJson(response, 404, { ok: false, error: messageFor('agent_not_found') });
      return;
    }
    if (resource === 'memory' && method === 'GET') {
      sendJson(response, 200, { ok: true, memory: readMemoryFile(deps.paths, agentName) });
      return;
    }
    if (resource === 'notebook' && segments.length === 4 && method === 'GET') {
      sendJson(response, 200, { ok: true, files: listNotebook(deps.paths, agentName) });
      return;
    }
    if (resource === 'notebook' && segments.length === 5 && segments[4] === 'file' && method === 'GET') {
      const requested = url.searchParams.get('path');
      if (requested === null || requested === '') {
        sendJson(response, 400, { ok: false, error: '请提供 path 参数' });
        return;
      }
      try {
        const content = readNotebookFile(deps.paths, agentName, requested);
        sendJson(response, 200, { ok: true, path: requested, content });
      } catch (error) {
        if (error instanceof NotebookError) {
          sendJson(response, 400, { ok: false, error: messageFor(error.code) });
          return;
        }
        throw error;
      }
      return;
    }
    if (resource === 'blackbox' && method === 'GET') {
      const raw = url.searchParams.get('rounds');
      const parsedRounds = raw === null ? 5 : Number.parseInt(raw, 10);
      const rounds = Number.isFinite(parsedRounds) && parsedRounds > 0 ? Math.min(parsedRounds, 50) : 5;
      sendJson(response, 200, { ok: true, rounds: deps.blackbox.readRecentRounds(agentName, rounds) });
      return;
    }
  }

  // /api/tasks
  if (segments.length >= 2 && segments[1] === 'tasks') {
    if (segments.length === 2 && method === 'GET') {
      sendJson(response, 200, { ok: true, tasks: deps.ledger.listTasks().map(taskView) });
      return;
    }
    if (segments.length === 2 && method === 'POST') {
      const body = await readJsonBody(request);
      const title = readString(body, 'title');
      const description = readString(body, 'description');
      const price = readNumber(body, 'price');
      if (title === null || description === null || price === null) {
        sendJson(response, 400, { ok: false, error: '标题、描述和价格都要填写' });
        return;
      }
      const id = nextTaskId(deps.ledger);
      const result = createTask(deps.ledger, { id, title, description, price, at: deps.now() });
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.code) });
        return;
      }
      sendJson(response, 200, { ok: true, task: taskView(result.task) });
      return;
    }
    if (segments.length === 4 && segments[3] === 'review' && method === 'POST') {
      const taskId = decodeURIComponent(segments[2]);
      const body = await readJsonBody(request);
      const decision = readString(body, 'decision');
      if (decision !== 'accept' && decision !== 'reject' && decision !== 'rework' && decision !== 'return') {
        sendJson(response, 400, { ok: false, error: 'decision 必须是 accept / reject / rework / return' });
        return;
      }
      const result = reviewTask(deps.ledger, taskId, decision as ReviewDecision, deps.now());
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.code) });
        return;
      }
      sendJson(response, 200, { ok: true, task: taskView(result.task) });
      return;
    }
  }

  // /api/income
  if (segments.length >= 2 && segments[1] === 'income') {
    if (segments.length === 2 && method === 'GET') {
      sendJson(response, 200, { ok: true, income: deps.ledger.listIncomeReports().map(incomeView) });
      return;
    }
    if (segments.length === 4 && segments[3] === 'verify' && method === 'POST') {
      const reportId = Number.parseInt(decodeURIComponent(segments[2]), 10);
      const body = await readJsonBody(request);
      const verifiedAmount = readNumber(body, 'verifiedAmount');
      if (!Number.isFinite(reportId) || verifiedAmount === null) {
        sendJson(response, 400, { ok: false, error: '请填写核实金额' });
        return;
      }
      const result = verifyIncome(deps.ledger, reportId, verifiedAmount, deps.values.exchangeRate, deps.now());
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: incomeError(result) });
        return;
      }
      sendJson(response, 200, { ok: true, report: incomeView(result.report), credited: result.credited });
      return;
    }
    if (segments.length === 4 && segments[3] === 'reject' && method === 'POST') {
      const reportId = Number.parseInt(decodeURIComponent(segments[2]), 10);
      if (!Number.isFinite(reportId)) {
        sendJson(response, 400, { ok: false, error: '申报编号不合法' });
        return;
      }
      const result = rejectIncome(deps.ledger, reportId, deps.now());
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: incomeError(result) });
        return;
      }
      sendJson(response, 200, { ok: true, report: incomeView(result.report) });
      return;
    }
  }

  // /api/messages
  if (segments.length === 2 && segments[1] === 'messages') {
    if (method === 'GET') {
      deps.ledger.markOperatorMessagesRead(deps.now());
      sendJson(response, 200, {
        ok: true,
        messages: deps.ledger
          .listMessagesForOperator()
          .slice(-100)
          .reverse()
          .map((message) => ({
            id: message.id,
            sender: message.sender,
            recipient: message.recipient,
            body: message.body,
            at: message.at,
            readAt: message.readAt,
          })),
      });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(request);
      const agent = readString(body, 'agent');
      const text = readString(body, 'body');
      if (agent === null || text === null || text.trim() === '') {
        sendJson(response, 400, { ok: false, error: '请选择 agent 并填写留言' });
        return;
      }
      if (deps.ledger.getAgent(agent) === null) {
        sendJson(response, 404, { ok: false, error: messageFor('agent_not_found') });
        return;
      }
      const id = deps.ledger.appendMessage('operator', agent, text, deps.now());
      sendJson(response, 200, { ok: true, id });
      return;
    }
  }

  // /api/prompts
  if (segments.length === 2 && segments[1] === 'prompts' && method === 'GET') {
    sendJson(response, 200, { ok: true, prompts: deps.prompts.status() });
    return;
  }
  // POST /api/prompts/mode
  if (segments.length === 3 && segments[1] === 'prompts' && segments[2] === 'mode' && method === 'POST') {
    const body = await readJsonBody(request);
    const mode = readString(body, 'mode');
    if (mode !== 'hot' && mode !== 'cached') {
      sendJson(response, 400, { ok: false, error: messageFor('invalid_prompt_mode') });
      return;
    }
    deps.prompts.setMode(mode);
    sendJson(response, 200, { ok: true, prompts: deps.prompts.status() });
    return;
  }
  // POST /api/prompts/reload
  if (segments.length === 3 && segments[1] === 'prompts' && segments[2] === 'reload' && method === 'POST') {
    deps.prompts.reload();
    sendJson(response, 200, { ok: true, prompts: deps.prompts.status() });
    return;
  }

  // POST /api/settings/pause
  if (segments.length === 3 && segments[1] === 'settings' && segments[2] === 'pause' && method === 'POST') {
    const body = await readJsonBody(request);
    const paused = body['paused'];
    if (typeof paused !== 'boolean') {
      sendJson(response, 400, { ok: false, error: messageFor('invalid_paused') });
      return;
    }
    const result = deps.setPaused(paused);
    sendJson(response, 200, {
      ok: true,
      changed: result.changed,
      paused: result.state.paused,
      pausedSince: result.state.pausedSince,
    });
    return;
  }

  // POST /api/wake
  if (segments.length === 2 && segments[1] === 'wake' && method === 'POST') {
    const body = await readJsonBody(request);
    const agent = readString(body, 'agent');
    if (agent === null) {
      sendJson(response, 400, { ok: false, error: '请选择 agent' });
      return;
    }
    const result = await deps.wakeAgent(agent);
    if (!result.ok) {
      sendJson(response, 404, { ok: false, error: messageFor(result.error) });
      return;
    }
    if (!result.woken) {
      sendJson(response, 200, { ok: true, woken: false, note: result.reason ?? messageFor('agent_busy') });
      return;
    }
    sendJson(response, 200, { ok: true, woken: true });
    return;
  }

  // POST /api/intervene
  if (segments.length === 2 && segments[1] === 'intervene' && method === 'POST') {
    const body = await readJsonBody(request);
    const agent = readString(body, 'agent');
    const kind = readString(body, 'kind');
    const amount = readNumber(body, 'amount');
    if (agent === null || (kind !== 'give_balance' && kind !== 'give_satiety')) {
      sendJson(response, 400, { ok: false, error: '请选择 agent 与干预类型' });
      return;
    }
    if (amount === null || amount <= 0) {
      sendJson(response, 400, { ok: false, error: messageFor('invalid_amount_intervention') });
      return;
    }
    const result = await deps.intervene(agent, kind, amount);
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: messageFor(result.error) });
      return;
    }
    sendJson(response, 200, { ok: true, balance: result.balance, satiety: result.satiety });
    return;
  }

  sendJson(response, 404, { ok: false, error: '未知路径' });
}

function nextTaskId(ledger: Ledger): string {
  let counter = ledger.listTasks().length + 1;
  for (;;) {
    const candidate = `task_${String(counter).padStart(4, '0')}`;
    if (ledger.getTask(candidate) === null) {
      return candidate;
    }
    counter += 1;
  }
}
