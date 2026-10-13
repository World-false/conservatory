import { readFileSync } from 'node:fs';
import http from 'node:http';
import { isReasoningEffort, validateValuesPatch, type ConservatoryValues, type ReasoningEffort, type RuntimePaths } from '../config';
import { parseDeathCertificate } from '../organs/death';
import { verifyIncome, rejectIncome, type IncomeResult } from '../organs/income';
import type {
  IncomeReportRecord,
  InterventionKind,
  Ledger,
  PauseState,
  TaskRecord,
  TreatmentRecord,
  TreatmentTier,
  WoundRecord,
} from '../organs/ledger';
import { readSatiety } from '../organs/metabolism';
import { readMemoryFile } from '../organs/memory';
import { readModelBinding } from '../organs/models/binding';
import type { ModelConfigStore } from '../organs/models/store';
import { NotebookError, listNotebook, readNotebookFile } from '../organs/notebook';
import type { PromptLibrary } from '../organs/prompts';
import { renderSentenceWithSpans } from '../organs/redaction';
import { cancelTask, createTask, reviewTask, updateTask, type ReviewDecision } from '../organs/taskboard';
import type { Blackbox } from '../organs/blackbox';
import type { RoundRegistry } from '../organs/population';
import type { SandboxPolicyStore, SandboxPolicyView } from '../organs/sandbox/policy';

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
  /**
   * The OS command sandbox's read/write policy. The store owns validation and
   * persistence; the console only carries the operator's edits to it and back.
   */
  sandboxPolicy: SandboxPolicyStore;
  /**
   * The model roster: the providers and models the operator may choose from.
   * Binding one to an agent is the supervisor's job, not the console's.
   */
  modelStore: ModelConfigStore;
  /**
   * Applies a partial update of the body's numbers. The supervisor owns this
   * because a change to the decay rate has to re-anchor every living agent
   * before the new rate is in force, and it is the supervisor that holds the
   * ledger and the two heartbeats.
   *
   * When it is not injected the console validates and applies the patch itself
   * against `values`, which is what a test that only wants the route does.
   */
  updateValues?(
    patch: unknown,
  ): { ok: true; values: ConservatoryValues } | { ok: false; error: string };
  indexHtmlPath: string;
  now(): number;
  getRuntime(name: string): RuntimeInfo;
  createAgent(
    name: string,
    providerId?: string,
    model?: string,
    reasoningEffort?: ReasoningEffort | null,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Rebinds one living agent's brain. `deferred` means the agent is mid-round,
   * so the new model lands on its next wake-up instead of now.
   */
  switchAgentModel(
    name: string,
    providerId: string,
    model: string,
    reasoningEffort?: ReasoningEffort | null,
  ): { ok: true; deferred: boolean; message: string } | { ok: false; error: string; agents?: string[] };
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
  /** The operator treats a wound for the agent; the price is not charged to it. */
  treatWound(agent: string, woundId: number, tier: TreatmentTier): { ok: true } | { ok: false; error: string };
  /** The operator's forced termination. There is no way back from it. */
  terminateAgent(agent: string, confirmName: string): { ok: true } | { ok: false; error: string };
  /**
   * Total erasure: the agent and every record naming it are destroyed, as if it
   * had never existed. The confirmation name must match; this cannot be undone.
   */
  eraseAgent(agent: string, confirmName: string): { ok: true } | { ok: false; error: string };
  getNotices(): ConsoleNotice[];
}

const MAX_BODY_BYTES = 256 * 1024;

/** Operator-facing text is Chinese; everything an agent sees stays English. */
const MESSAGES: Record<string, string> = {
  agent_not_found: '没有这个 agent',
  invalid_name: '名字只能包含小写字母、数字和下划线',
  name_taken: '这个名字已经被占用',
  no_free_slot: '没有空槽位',
  home_exists: 'AGENTS 下已存在同名目录',
  invalid_title: '标题不能为空',
  invalid_price: '价格必须是不小于 0 的数字',
  invalid_deliverable: '交付内容不能为空',
  task_not_found: '任务不存在',
  task_not_open: '只有开放中的任务可以修改或撤下',
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
  agent_busy_try_later: '该 agent 正在一轮中，请稍后再试',
  agent_dead: '这个 agent 已经死亡，任何操作都无法撤销这件事',
  claimant_not_alive: '该任务的认领 agent 已经死亡，无法付款',
  reporter_not_alive: '该收入申报的 agent 已经死亡，无法入账',
  wound_not_found: '没有这个伤口',
  wound_not_treatable: '这个伤口不能用这一档治疗（普通治疗只能治未治疗伤口，完全治疗可以治疤痕）',
  insufficient_balance: '该 agent 的余额不足以支付这档治疗',
  confirm_name_mismatch: '确认名字与 agent 名不一致，已取消',
  erase_name_mismatch: '确认名字与 agent 名不一致，已取消删除',
  invalid_tier: 'tier 必须是 ordinary 或 complete',
  invalid_wound_id: '伤口编号不合法',
  invalid_amount_intervention: '干预数量必须是不小于 0 的数字',
  invalid_paused: 'paused 必须是 true 或 false',
  invalid_prompt_mode: '提示词加载模式必须是 hot 或 cached',
  invalid_read_mode: '沙箱读取模式必须是 blacklist 或 whitelist',
  invalid_path_list: '路径列表必须是不为空字符串的数组',
  invalid_command_timeout: '命令超时必须是大于 0 的数字（秒）',
  invalid_max_output: '输出上限必须是大于 0 的整数（字符）',
  empty_sandbox_patch: '没有需要更新的沙箱字段',
  sandbox_config_write_failed: '沙箱策略未能写回配置文件',
  // Models
  invalid_providers: 'providers 必须是一个数组',
  no_providers: '至少要保留一个模型提供商',
  invalid_provider: '提供商的名称、Base URL 或 API Key 不合法',
  invalid_provider_id: '提供商 ID 只能包含字母、数字、下划线和短横线',
  invalid_provider_models: '提供商的 models 必须是一个数组',
  empty_provider_models: '每个提供商至少要有一个模型名',
  duplicate_provider_id: '提供商 ID 不能重复',
  invalid_models_patch: '模型配置字段不合法',
  empty_models_patch: '没有需要更新的模型配置字段',
  unknown_default_agent_model: '默认 Agent 模型必须属于选中的提供商',
  unknown_default_memory_model: '默认 Memory 模型必须属于选中的提供商',
  models_config_write_failed: '模型配置未能写回配置文件',
  provider_in_use: '这个提供商仍有存活的 Agent 在用，请先把这些 Agent 切到别的提供商',
  unknown_provider: '没有这个模型提供商',
  unknown_model: '这个提供商下没有这个模型',
  provider_removed: '这个提供商已经被删除，请重新选择',
  invalid_model_selection: '请选择提供商与模型',
  invalid_reasoning_effort: '思考努力等级必须是 low、medium、high 或留空（默认）',
};

function messageFor(code: string): string {
  return MESSAGES[code] ?? code;
}

function taskView(ledger: Ledger, task: TaskRecord): Record<string, unknown> {
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
    // Every attempt, oldest first, so the page can show what changed across a
    // rework. The task row only keeps the latest deliverable.
    submissions: ledger.listTaskSubmissions(task.id).map((submission) => ({
      id: submission.id,
      agent: submission.agent,
      deliverable: submission.deliverable,
      at: submission.at,
    })),
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

/**
 * The sandbox policy as the console hands it to the page. The built-in entries
 * travel as `locked`, because the page must show them and refuse to delete
 * them; the store's own field names for them are never sent on.
 */
function sandboxConfigView(view: SandboxPolicyView): Record<string, unknown> {
  return {
    ok: true,
    config: {
      readMode: view.readMode,
      readBlacklist: view.readBlacklist,
      readWhitelist: view.readWhitelist,
      writableDirs: view.writableDirs,
      commandTimeoutSeconds: view.commandTimeoutSeconds,
      maxOutputChars: view.maxOutputChars,
    },
    locked: {
      readBlacklist: view.lockedReadBlacklist,
      writableDirs: view.lockedWritableDirs,
    },
    configPath: view.configPath,
  };
}

function buildModelsEndpointUrl(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = trimmedPath.endsWith('/models') ? trimmedPath : `${trimmedPath}/models`;
  return parsed.toString();
}

/**
 * The chat endpoint for a test call, derived the same way the `/models` URL is:
 * the operator's Base URL may or may not already end in `/v1`, and may or may
 * not carry a trailing slash. A URL that already names the route is left alone
 * rather than doubled up.
 */
function buildChatCompletionsUrl(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = trimmedPath.endsWith('/chat/completions')
    ? trimmedPath
    : `${trimmedPath}/chat/completions`;
  return parsed.toString();
}

function extractModelIds(payload: unknown): string[] {
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null
      ? Array.isArray((payload as Record<string, unknown>)['data'])
        ? ((payload as Record<string, unknown>)['data'] as unknown[])
        : Array.isArray((payload as Record<string, unknown>)['models'])
          ? ((payload as Record<string, unknown>)['models'] as unknown[])
          : []
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let rawId: unknown = null;
    if (typeof item === 'string') {
      rawId = item;
    } else if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      rawId = typeof record['id'] === 'string' ? record['id'] : record['name'];
    }
    if (typeof rawId !== 'string') {
      continue;
    }
    const id = rawId.trim();
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function fetchRemoteModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const endpoint = buildModelsEndpointUrl(baseUrl);
  if (endpoint === null) {
    return { ok: false, error: '请填写合法的 Base URL（以 http:// 或 https:// 开头）' };
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey.trim() !== '') {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `连接模型接口失败：${detail}` };
  }
  const rawText = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (rawText.trim() !== '') {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    let remoteMsg = '';
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const errObj = record['error'];
      if (typeof errObj === 'string') {
        remoteMsg = errObj;
      } else if (typeof errObj === 'object' && errObj !== null) {
        const msg = (errObj as Record<string, unknown>)['message'];
        if (typeof msg === 'string') {
          remoteMsg = msg;
        }
      } else if (typeof record['message'] === 'string') {
        remoteMsg = record['message'];
      }
    }
    const suffix = remoteMsg.trim() !== '' ? `（${remoteMsg.trim()}）` : '';
    return { ok: false, error: `拉取模型列表失败：HTTP ${String(response.status)}${suffix}` };
  }
  const models = extractModelIds(parsed);
  if (models.length === 0) {
    return { ok: false, error: '接口返回成功，但没有找到任何可用的模型名称' };
  }
  return { ok: true, models };
}

interface TestedUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * One tiny round trip to prove a model is usable at all.
 *
 * A reply is not enough. The whole harness meters on the usage the provider
 * reports, so a model that answers but reports no token counts is a model the
 * conservatory cannot run: the round would end with `usage_missing` and the
 * operator would be left guessing why. The check is therefore deliberately
 * stricter than "did it answer" — reachable, and metered.
 */
async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
  reasoningEffort: ReasoningEffort | null,
): Promise<{ ok: true; usage: TestedUsage } | { ok: false; error: string }> {
  const endpoint = buildChatCompletionsUrl(baseUrl);
  if (endpoint === null) {
    return { ok: false, error: '请填写合法的 Base URL（以 http:// 或 https:// 开头）' };
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (apiKey.trim() !== '') {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 8,
  };
  if (reasoningEffort !== null) {
    payload['reasoning_effort'] = reasoningEffort;
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `模型测试失败（网络错误）：${detail}` };
  }
  const rawText = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (rawText.trim() !== '') {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    let remoteMsg = '';
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const errObj = record['error'];
      if (typeof errObj === 'string') {
        remoteMsg = errObj;
      } else if (typeof errObj === 'object' && errObj !== null) {
        const msg = (errObj as Record<string, unknown>)['message'];
        if (typeof msg === 'string') {
          remoteMsg = msg;
        }
      } else if (typeof record['message'] === 'string') {
        remoteMsg = record['message'];
      }
    }
    const detail = remoteMsg.trim() !== '' ? remoteMsg.trim() : rawText.trim().slice(0, 200);
    return { ok: false, error: `模型测试失败（HTTP ${String(response.status)}）：${detail}` };
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  const usage = record === null ? null : record['usage'];
  const usageRecord = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : null;
  const promptTokens = usageRecord === null ? null : usageRecord['prompt_tokens'];
  const completionTokens = usageRecord === null ? null : usageRecord['completion_tokens'];
  if (
    typeof promptTokens !== 'number' ||
    !Number.isFinite(promptTokens) ||
    typeof completionTokens !== 'number' ||
    !Number.isFinite(completionTokens)
  ) {
    return {
      ok: false,
      error: '接口连通成功，但未返回 token 用量（usage），温室无法使用该模型',
    };
  }
  return { ok: true, usage: { promptTokens, completionTokens } };
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

/**
 * The optional thinking level off a request body. Absent, `null`, `''` and
 * `'default'` all mean "the operator did not choose one", which is not an
 * error — it is how the panel says "clear it and let the provider decide".
 * Anything else that is not one of the three levels is refused rather than
 * ignored: a typo silently treated as "unset" would look like it worked.
 */
function readReasoningEffort(
  body: Record<string, unknown>,
): { ok: true; value: ReasoningEffort | null } | { ok: false } {
  const raw = body['reasoningEffort'];
  if (raw === undefined || raw === null || raw === '' || raw === 'default') {
    return { ok: true, value: null };
  }
  if (isReasoningEffort(raw)) {
    return { ok: true, value: raw };
  }
  return { ok: false };
}

function readNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One wound, as the memory page needs it: what was taken, the whole sentence
 * it was taken from as the agent reads it, and exactly where inside that
 * sentence this wound sits.
 *
 * The coordinates are what let the page point at the right wound when two of
 * them are neighbours. The rendered sentence alone cannot say which run of
 * placeholders belongs to which wound, so the renderer is asked and its answer
 * is passed through rather than re-derived in the browser.
 */
function woundView(ledger: Ledger, agent: string, wound: WoundRecord): Record<string, unknown> {
  const sentence = ledger.getFrozenSentence(wound.sentenceId);
  const siblings = ledger.listWounds(agent).filter((row) => row.sentenceId === wound.sentenceId);
  const rendered = sentence === null ? null : renderSentenceWithSpans(sentence.original, siblings);
  const span = rendered === null ? undefined : rendered.spans.find((item) => item.woundId === wound.id);
  return {
    id: wound.id,
    status: wound.status,
    length: wound.length,
    createdAt: wound.createdAt,
    treatedAt: wound.treatedAt,
    // The operator may read the original text; the agent never can.
    originalText: wound.originalText,
    sentence: rendered === null ? '' : rendered.text,
    sentenceId: wound.sentenceId,
    offset: wound.offset,
    sentenceStartOffset: sentence === null ? null : sentence.startOffset,
    spanStart: span === undefined ? null : span.start,
    spanEnd: span === undefined ? null : span.end,
  };
}

function treatmentView(record: TreatmentRecord): Record<string, unknown> {
  return {
    id: record.id,
    woundId: record.woundId,
    tier: record.tier,
    price: record.price,
    paidBy: record.paidBy,
    at: record.at,
  };
}

function buildState(deps: ConsoleDeps): Record<string, unknown> {
  const { ledger, values } = deps;
  const now = deps.now();
  const pause = ledger.getPauseState();
  const agents = ledger.listAgents().map((agent) => {
    const runtime = deps.getRuntime(agent.name);
    const anchor = ledger.getSatietyAnchor(agent.name);
    const injuries = ledger.listWounds(agent.name);
    const certificate = ledger.getDeathCertificate(agent.name);
    // The frozen snapshot, minus the key. The page shows what an agent is
    // actually running on; `apiKey` stays on the server, where the agent's own
    // binding file already keeps it out of the operator's view.
    const binding = readModelBinding(deps.paths, agent.name);
    return {
      name: agent.name,
      bornAt: agent.bornAt,
      model: agent.model,
      modelBinding:
        binding === null
          ? null
          : {
              providerId: binding.providerId,
              providerName: binding.providerName,
              model: binding.model,
              ...(binding.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: binding.reasoningEffort }),
              boundAt: binding.boundAt,
            },
      status: agent.status,
      satiety: anchor === null ? null : readSatiety(ledger, values, agent.name, now),
      satietyMax: values.satietyMax,
      balance: ledger.getBalance(agent.name),
      busy: deps.registry.isBusy(agent.name),
      lastWakeAt: runtime.lastWakeAt,
      lastRoundAt: runtime.lastRoundAt,
      lastRoundEndReason: runtime.lastRoundEndReason,
      lastError: runtime.lastError,
      untreatedRedactedChars: ledger.untreatedRedactedChars(agent.name),
      lifetimeRedactedChars: ledger.lifetimeRedactedChars(agent.name),
      deathLineChars: values.deathLineChars,
      wounds: injuries.map((wound) => woundView(ledger, agent.name, wound)),
      treatments: ledger.listTreatments(agent.name).map(treatmentView),
      death: certificate === null
        ? null
        : {
            diedAt: certificate.diedAt,
            cause: certificate.cause,
            body: certificate.body,
            facts: parseDeathCertificate(certificate.body),
          },
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
    // The roster the page paints its model pickers from. It is only a menu:
    // which brain an agent actually runs on is in its own frozen binding.
    models: deps.modelStore.view(),
    config: {
      satietyMax: values.satietyMax,
      satietyDecayPerSecond: values.satietyDecayPerSecond,
      initialSatiety: values.initialSatiety,
      initialBalance: values.initialBalance,
      mealPrice: values.mealPrice,
      satietyPerMeal: values.satietyPerMeal,
      heartbeatSeconds: values.heartbeatSeconds,
      memoryCapChars: values.memoryCapChars,
      roundContextCapTokens: values.roundContextCapTokens,
      maxToolCallsPerRound: values.maxToolCallsPerRound,
      modelRequestTimeoutSeconds: values.modelRequestTimeoutSeconds,
      taskClaimTimeoutHours: values.taskClaimTimeoutHours,
      maxSlots: values.maxSlots,
      redactionIntervalSeconds: values.redactionIntervalSeconds,
      redactionCharsPerTick: values.redactionCharsPerTick,
      redactionMinRanges: values.redactionMinRanges,
      redactionMaxRanges: values.redactionMaxRanges,
      deathLineChars: values.deathLineChars,
      ordinaryTreatmentPrice: values.ordinaryTreatmentPrice,
      completeTreatmentPrice: values.completeTreatmentPrice,
      // Stored and shown like the rest, but the listener is bound once at boot:
      // the panel marks this one "needs a restart" rather than pretending the
      // change is live.
      consolePort: values.consolePort,
    },
    agents,
    busy: deps.registry.busyAgents(),
    tasks: ledger.listTasks().map((task) => taskView(ledger, task)),
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

/**
 * One patch of the body's numbers, through whichever owner is available.
 *
 * With `updateValues` injected (the supervisor) that callback does the whole
 * job: validate, re-anchor satiety, persist, retune the clocks. Without it —
 * a console test, or any embedder that only wants the route — the shared
 * validator is applied to the live `values` object in place, which is enough
 * for `/api/state` and income verification to see the change immediately.
 */
function applyValuesPatch(
  deps: ConsoleDeps,
  patch: unknown,
): { ok: true; values: ConservatoryValues } | { ok: false; error: string } {
  const update = deps.updateValues;
  if (update !== undefined) {
    return update(patch);
  }
  const result = validateValuesPatch(deps.values, patch);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  Object.assign(deps.values, result.next);
  return { ok: true, values: deps.values };
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
    // The operator may pick a provider and a model, or leave both out and take
    // the configured defaults; the supervisor refuses a pair it cannot resolve.
    const providerId = readString(body, 'providerId');
    const model = readString(body, 'model');
    const effort = readReasoningEffort(body);
    if (!effort.ok) {
      sendJson(response, 400, { ok: false, error: messageFor('invalid_reasoning_effort') });
      return;
    }
    // The level is only passed on when it was actually chosen, so a request
    // that says nothing about thinking is indistinguishable from one made
    // before this setting existed.
    const result =
      effort.value === null
        ? await deps.createAgent(
            name.trim(),
            providerId === null ? undefined : providerId.trim(),
            model === null ? undefined : model.trim(),
          )
        : await deps.createAgent(
            name.trim(),
            providerId === null ? undefined : providerId.trim(),
            model === null ? undefined : model.trim(),
            effort.value,
          );
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: messageFor(result.error) });
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  // GET/POST /api/models/config
  if (segments.length === 3 && segments[1] === 'models' && segments[2] === 'config') {
    if (method === 'GET') {
      sendJson(response, 200, { ok: true, models: deps.modelStore.view() });
      return;
    }
    if (method === 'POST') {
      // The store owns validation and persistence; the console hands the whole
      // body over and reports what came back, exactly like the sandbox panel.
      const body = await readJsonBody(request);
      const result = deps.modelStore.update(body);
      if (!result.ok) {
        const detail =
          result.error === 'provider_in_use' && result.agents !== undefined && result.agents.length > 0
            ? `${messageFor(result.error)}：${result.agents.join('、')}`
            : messageFor(result.error);
        sendJson(response, 400, { ok: false, error: detail, agents: result.agents ?? [] });
        return;
      }
      sendJson(response, 200, { ok: true, models: result.data });
      return;
    }
  }

  // POST /api/models/fetch-models
  if (segments.length === 3 && segments[1] === 'models' && segments[2] === 'fetch-models' && method === 'POST') {
    const body = await readJsonBody(request);
    const rawBaseUrl = readString(body, 'baseUrl');
    const rawApiKey = readString(body, 'apiKey');
    const providerId = readString(body, 'providerId');
    if (rawBaseUrl === null || rawBaseUrl.trim() === '') {
      sendJson(response, 400, { ok: false, error: '请先填写 Base URL' });
      return;
    }
    const storedKey =
      providerId !== null && providerId.trim() !== ''
        ? (deps.modelStore.getProvider(providerId.trim())?.apiKey ?? '')
        : '';
    const apiKey = rawApiKey !== null && rawApiKey !== '' ? rawApiKey : storedKey;
    const outcome = await fetchRemoteModels(rawBaseUrl.trim(), apiKey);
    if (!outcome.ok) {
      sendJson(response, 400, { ok: false, error: outcome.error });
      return;
    }
    sendJson(response, 200, { ok: true, models: outcome.models });
    return;
  }

  // POST /api/models/test
  // Proves one brain works before the operator commits to it: reachable,
  // metered, and — when a level was chosen — accepted at that level. Nothing
  // is written; this route only answers.
  if (segments.length === 3 && segments[1] === 'models' && segments[2] === 'test' && method === 'POST') {
    const body = await readJsonBody(request);
    const rawModel = readString(body, 'model');
    if (rawModel === null || rawModel.trim() === '') {
      sendJson(response, 400, { ok: false, error: '请先选择或填写要测试的模型名' });
      return;
    }
    const model = rawModel.trim();
    const effort = readReasoningEffort(body);
    if (!effort.ok) {
      sendJson(response, 400, { ok: false, error: messageFor('invalid_reasoning_effort') });
      return;
    }
    const rawBaseUrl = readString(body, 'baseUrl');
    const rawApiKey = readString(body, 'apiKey');
    const providerId = readString(body, 'providerId');
    const provider =
      providerId !== null && providerId.trim() !== ''
        ? deps.modelStore.getProvider(providerId.trim())
        : null;
    // An explicit Base URL wins; a chosen provider is the fallback, so testing
    // a saved provider needs no retyping. The key follows the same order, and a
    // form that is still being filled in may legitimately have none yet.
    const baseUrl = rawBaseUrl !== null && rawBaseUrl.trim() !== '' ? rawBaseUrl.trim() : (provider?.baseUrl ?? '');
    if (baseUrl === '') {
      sendJson(response, 400, { ok: false, error: '请先填写 Base URL 或选择提供商' });
      return;
    }
    const apiKey = rawApiKey !== null && rawApiKey !== '' ? rawApiKey : (provider?.apiKey ?? '');
    const outcome = await testModelConnection(baseUrl, apiKey, model, effort.value);
    if (!outcome.ok) {
      sendJson(response, 400, { ok: false, error: outcome.error });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      model,
      reasoningEffort: effort.value,
      usage: {
        promptTokens: outcome.usage.promptTokens,
        completionTokens: outcome.usage.completionTokens,
      },
      message: `测试通过（提示 ${String(outcome.usage.promptTokens)} / 生成 ${String(
        outcome.usage.completionTokens,
      )} tokens）`,
    });
    return;
  }

  // /api/agents/:name/...
  if (segments.length >= 4 && segments[1] === 'agents') {
    const agentName = decodeURIComponent(segments[2]);
    const resource = segments[3];
    const record = deps.ledger.getAgent(agentName);
    if (record === null) {
      sendJson(response, 404, { ok: false, error: messageFor('agent_not_found') });
      return;
    }
    const dead = record.status !== 'alive';

    // POST /api/agents/:name/wounds/:id/treat
    if (resource === 'wounds' && segments.length === 6 && segments[5] === 'treat' && method === 'POST') {
      if (dead) {
        sendJson(response, 400, { ok: false, error: messageFor('agent_dead') });
        return;
      }
      // A round may end and rewrite MEMORY; a treatment must not race it.
      if (deps.registry.isBusy(agentName)) {
        sendJson(response, 400, { ok: false, error: messageFor('agent_busy_try_later') });
        return;
      }
      const woundId = Number.parseInt(decodeURIComponent(segments[4]), 10);
      const body = await readJsonBody(request);
      const tier = readString(body, 'tier');
      if (!Number.isInteger(woundId)) {
        sendJson(response, 400, { ok: false, error: messageFor('invalid_wound_id') });
        return;
      }
      if (tier !== 'ordinary' && tier !== 'complete') {
        sendJson(response, 400, { ok: false, error: messageFor('invalid_tier') });
        return;
      }
      const result = deps.treatWound(agentName, woundId, tier);
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.error) });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    // POST /api/agents/:name/model
    if (resource === 'model' && segments.length === 4 && method === 'POST') {
      if (dead) {
        sendJson(response, 400, { ok: false, error: messageFor('agent_dead') });
        return;
      }
      const body = await readJsonBody(request);
      const providerId = readString(body, 'providerId');
      const model = readString(body, 'model');
      if (providerId === null || providerId.trim() === '' || model === null || model.trim() === '') {
        sendJson(response, 400, { ok: false, error: messageFor('invalid_model_selection') });
        return;
      }
      const effort = readReasoningEffort(body);
      if (!effort.ok) {
        sendJson(response, 400, { ok: false, error: messageFor('invalid_reasoning_effort') });
        return;
      }
      // A model change is an operator intervention, so it is allowed while the
      // agent is mid-round: the ledger and the binding are written now and the
      // running process picks the new brain up on its next wake-up.
      const result =
        effort.value === null
          ? deps.switchAgentModel(agentName, providerId.trim(), model.trim())
          : deps.switchAgentModel(agentName, providerId.trim(), model.trim(), effort.value);
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.error) });
        return;
      }
      sendJson(response, 200, { ok: true, deferred: result.deferred, message: result.message });
      return;
    }

    // POST /api/agents/:name/terminate
    if (resource === 'terminate' && segments.length === 4 && method === 'POST') {
      if (dead) {
        sendJson(response, 400, { ok: false, error: messageFor('agent_dead') });
        return;
      }
      const body = await readJsonBody(request);
      const confirmName = readString(body, 'confirmName');
      if (confirmName === null || confirmName.trim() === '') {
        sendJson(response, 400, { ok: false, error: messageFor('confirm_name_mismatch') });
        return;
      }
      const result = deps.terminateAgent(agentName, confirmName.trim());
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.error) });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    // POST /api/agents/:name/erase
    // The only route that destroys history, so it asks for more than the
    // termination route does: a matching typed name, and never a live round.
    // It works on a dead agent too, which is the point — a grave someone made
    // by accident has to be removable.
    if (resource === 'erase' && segments.length === 4 && method === 'POST') {
      const body = await readJsonBody(request);
      const confirmName = readString(body, 'confirmName');
      if (confirmName === null || confirmName.trim() === '') {
        sendJson(response, 400, { ok: false, error: messageFor('erase_name_mismatch') });
        return;
      }
      const result = deps.eraseAgent(agentName, confirmName.trim());
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.error) });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (resource === 'death-certificate' && method === 'GET') {
      const certificate = deps.ledger.getDeathCertificate(agentName);
      if (certificate === null) {
        sendJson(response, 404, { ok: false, error: '这个 agent 还没有死亡证明' });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        certificate: {
          agent: certificate.agent,
          diedAt: certificate.diedAt,
          cause: certificate.cause,
          body: certificate.body,
          facts: parseDeathCertificate(certificate.body),
        },
      });
      return;
    }

    if (resource === 'memory' && method === 'GET') {
      sendJson(response, 200, { ok: true, memory: readMemoryFile(deps.paths, agentName) });
      return;
    }
    if (resource === 'wounds' && segments.length === 4 && method === 'GET') {
      const wounds = deps.ledger.listWounds(agentName).map((wound) => woundView(deps.ledger, agentName, wound));
      sendJson(response, 200, { ok: true, wounds });
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
      sendJson(response, 200, { ok: true, tasks: deps.ledger.listTasks().map((task) => taskView(deps.ledger, task)) });
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
      sendJson(response, 200, { ok: true, task: taskView(deps.ledger, result.task) });
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
      const note = readString(body, 'note');
      const result = reviewTask(deps.ledger, taskId, decision as ReviewDecision, deps.now(), note ?? undefined);
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.code) });
        return;
      }
      sendJson(response, 200, { ok: true, task: taskView(deps.ledger, result.task) });
      return;
    }
    if (segments.length === 4 && segments[3] === 'update' && method === 'POST') {
      const taskId = decodeURIComponent(segments[2]);
      const body = await readJsonBody(request);
      const title = readString(body, 'title');
      const description = readString(body, 'description');
      const price = readNumber(body, 'price');
      if (title === null || description === null || price === null) {
        sendJson(response, 400, { ok: false, error: '标题、描述和价格都要填写' });
        return;
      }
      const result = updateTask(deps.ledger, taskId, { title, description, price }, deps.now());
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.code) });
        return;
      }
      sendJson(response, 200, { ok: true, task: taskView(deps.ledger, result.task) });
      return;
    }
    if (segments.length === 4 && segments[3] === 'cancel' && method === 'POST') {
      const taskId = decodeURIComponent(segments[2]);
      const result = cancelTask(deps.ledger, taskId);
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.code) });
        return;
      }
      sendJson(response, 200, { ok: true, id: result.id });
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
      const note = readString(body, 'note');
      const result = verifyIncome(
        deps.ledger,
        reportId,
        verifiedAmount,
        deps.values.exchangeRate,
        deps.now(),
        note ?? undefined,
      );
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
      const body = await readJsonBody(request);
      const note = readString(body, 'note');
      const result = rejectIncome(deps.ledger, reportId, deps.now(), note ?? undefined);
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

  // GET /api/sandbox/config, POST /api/sandbox/config
  if (segments.length === 3 && segments[1] === 'sandbox' && segments[2] === 'config') {
    if (method === 'GET') {
      sendJson(response, 200, sandboxConfigView(deps.sandboxPolicy.view()));
      return;
    }
    if (method === 'POST') {
      // The store owns validation and persistence; the console reads the JSON
      // body and hands it over whole, then reports what came back.
      const body = await readJsonBody(request);
      const result = deps.sandboxPolicy.update(body);
      if (!result.ok) {
        sendJson(response, 400, { ok: false, error: messageFor(result.error) });
        return;
      }
      sendJson(response, 200, sandboxConfigView(result.view));
      return;
    }
  }

  // POST /api/settings/values
  if (segments.length === 3 && segments[1] === 'settings' && segments[2] === 'values' && method === 'POST') {
    const body = await readJsonBody(request);
    const result = applyValuesPatch(deps, body);
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    // The panel is repainted from this answer, so it is the state after the
    // change rather than the request's echo: what the operator sees next is
    // what the supervisor is actually holding.
    sendJson(response, 200, {
      ok: true,
      config: buildState(deps)['config'],
      exchangeRate: deps.values.exchangeRate,
    });
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
    const target = deps.ledger.getAgent(agent);
    if (target !== null && target.status !== 'alive') {
      sendJson(response, 400, { ok: false, error: messageFor('agent_dead') });
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
    const target = deps.ledger.getAgent(agent);
    if (target !== null && target.status !== 'alive') {
      sendJson(response, 400, { ok: false, error: messageFor('agent_dead') });
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
