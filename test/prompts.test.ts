import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimePaths } from '../src/config';
import { BODY_MANUAL } from '../src/organs/manual';
import { MEMORY_SYSTEM_PROMPT, writeMemoryAtomic } from '../src/organs/memory';
import {
  createPromptLibrary,
  DEFAULT_USER_CONTEXT_TEMPLATE,
  MEMORY_PLACEHOLDER,
  PromptWarningNotices,
  renderUserContext,
} from '../src/organs/prompts';
import { createTask } from '../src/organs/taskboard';
import { RoundCoordinator } from '../src/supervisor/round';
import {
  birthAgent,
  createHarness,
  initWorker,
  InProcessWorker,
  memoryResponse,
  ScriptedModelClient,
  testPrompts,
  textResponse,
  writePrompts,
  type Harness,
} from './helpers';

const MISSING_MEMORY_WARNING = '提示词模板缺少 {{memory}} 占位符，已降级使用安全模板';

function coordinatorFor(
  h: Harness,
  memoryResponses: ReturnType<typeof memoryResponse>[] = [],
  onPromptWarnings?: (warnings: string[]) => void,
): RoundCoordinator {
  return new RoundCoordinator({
    ledger: h.ledger,
    values: h.values,
    paths: h.paths,
    blackbox: h.blackbox,
    now: h.clock.now,
    memory: new ScriptedModelClient(memoryResponses),
    prompts: testPrompts(h),
    onPromptWarnings,
    onMemoryError: () => undefined,
  });
}

function wakeOf(worker: InProcessWorker): { system: string; user: string } {
  const wake = worker.sent.find((message) => message.type === 'wake');
  if (wake === undefined || wake.type !== 'wake') {
    throw new Error('the round never sent a wake message');
  }
  return wake;
}

describe('the prompt templates on disk', () => {
  it("loads the repository's own prompts/ directory", () => {
    // The real files, not a temp copy: this is what the running conservatory
    // reads, so it must match the built-in fallbacks exactly.
    const root = process.cwd();
    const library = createPromptLibrary(
      createRuntimePaths(root, path.join(root, 'conservatory.config.json'), path.join(root, '.env')),
    );
    const status = library.status();
    expect(status.healthy).toBe(true);
    expect(status.warnings).toEqual([]);
    expect(status.dir).toBe(path.join(root, 'prompts'));
    expect(status.templates.map((template) => template.file)).toEqual([
      'manual.md',
      'user_context.md',
      'memory_system.md',
    ]);
    expect(library.manual().text).toBe(BODY_MANUAL.trimEnd());
    expect(library.userContext().text).toBe(DEFAULT_USER_CONTEXT_TEMPLATE);
    expect(library.memorySystem().text).toBe(MEMORY_SYSTEM_PROMPT);
  });

  it('falls back to the built-in manual when the file is gone, and says so', () => {
    const h = createHarness();
    try {
      const library = testPrompts(h);
      const manual = library.manual();
      expect(manual.fromFile).toBe(false);
      expect(manual.text).toBe(BODY_MANUAL);
      expect(manual.warning).toContain('提示词模板无法读取');
      expect(manual.warning).toContain('prompts/manual.md');
      expect(manual.path).toBe(path.join(h.paths.promptsDir, 'manual.md'));

      const status = library.status();
      expect(status.healthy).toBe(false);
      expect(status.warnings).toHaveLength(3);
      expect(status.templates.every((template) => !template.fromFile)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a user context template that lost its memory placeholder', () => {
    const h = createHarness();
    try {
      writePrompts(h, { 'user_context.md': '=== BODY STATE ===\n{{body_state}}\n' });
      const template = testPrompts(h).userContext();
      expect(template.fromFile).toBe(false);
      expect(template.text).toBe(DEFAULT_USER_CONTEXT_TEMPLATE);
      expect(template.warning).toBe(MISSING_MEMORY_WARNING);
    } finally {
      h.cleanup();
    }
  });

  it('reads a changed file on the next wake, and holds it in cached mode until reload', () => {
    const h = createHarness();
    try {
      writePrompts(h, { 'manual.md': 'FIRST VERSION' });
      const library = testPrompts(h);
      expect(library.manual().text).toBe('FIRST VERSION');

      // Hot: an edit is live without touching the library.
      writePrompts(h, { 'manual.md': 'SECOND VERSION' });
      expect(library.manual().text).toBe('SECOND VERSION');

      library.setMode('cached');
      expect(library.getMode()).toBe('cached');
      writePrompts(h, { 'manual.md': 'THIRD VERSION' });
      expect(library.manual().text).toBe('SECOND VERSION');

      library.reload();
      expect(library.manual().text).toBe('THIRD VERSION');

      library.setMode('hot');
      writePrompts(h, { 'manual.md': 'FOURTH VERSION' });
      expect(library.manual().text).toBe('FOURTH VERSION');
    } finally {
      h.cleanup();
    }
  });

  it('normalizes CRLF line endings and a trailing newline', () => {
    const h = createHarness();
    try {
      writePrompts(h, { 'manual.md': 'line one\r\nline two\r\n' });
      expect(testPrompts(h).manual().text).toBe('line one\nline two');
    } finally {
      h.cleanup();
    }
  });

  it('treats an empty template file as unusable', () => {
    const h = createHarness();
    try {
      writePrompts(h, { 'memory_system.md': '   \n\n' });
      const loaded = testPrompts(h).memorySystem();
      expect(loaded.fromFile).toBe(false);
      expect(loaded.text).toBe(MEMORY_SYSTEM_PROMPT);
      expect(loaded.warning).toContain('内容为空');
    } finally {
      h.cleanup();
    }
  });
});

describe('assembling the user context', () => {
  it('puts each block in the place its placeholder holds', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      writePrompts(h, {
        'user_context.md':
          'MEM>>{{memory}}<<\nBODY>>{{body_state}}<<\nBOARD>>{{task_board}}<<\nMSG>>{{messages}}<<\n',
      });
      createTask(h.ledger, {
        id: 'task_0001',
        title: 'Count the clouds',
        description: 'Write down how many you saw.',
        price: 12,
        at: h.clock.now(),
      });
      h.ledger.appendMessage('operator', 'ada', 'Please eat something soon.', h.clock.now());

      const context = coordinatorFor(h).buildContext(agent, h.clock.now());

      expect(context.user).toContain(`MEM>>Name: ada\nBorn: ${new Date(agent.bornAt).toISOString()}<<`);
      expect(context.user).toContain(
        'BODY>>satiety: 100 / 100\nbalance: 100\nmeal price: 15 (restores 25 satiety)<<',
      );
      expect(context.user).toContain(
        'BOARD>>Open tasks (fixed price, first come first served):\n' +
          '- task_0001 | Count the clouds | price 12\n' +
          '  Write down how many you saw.\n' +
          'Held by you:\n' +
          '- (none)<<',
      );
      expect(context.user).toMatch(/MSG>>- \d{4}-\d{2}-\d{2}T[\d:.]+Z: Please eat something soon\.<</);
      expect(context.system).toBe(BODY_MANUAL);
      // The message was consumed by the same pass that injected it.
      expect(h.ledger.listUnreadMessages('ada')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('never substitutes inside a value it just injected', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      writePrompts(h, { 'user_context.md': '{{memory}}\n---\n{{task_board}}' });
      writeMemoryAtomic(h.paths, 'ada', 'I wrote the literal string {{task_board}} in my own record.');
      const context = coordinatorFor(h).buildContext(agent, h.clock.now());
      expect(context.user).toContain('I wrote the literal string {{task_board}} in my own record.');
      expect(context.user.endsWith('---\nOpen tasks (fixed price, first come first served):\n- (none)\nHeld by you:\n- (none)')).toBe(
        true,
      );
    } finally {
      h.cleanup();
    }
  });

  it('leaves unknown placeholders and unmentioned blocks alone', () => {
    expect(renderUserContext('a {{memory}} b {{nobody}} c', {
      memory: 'MEM',
      bodyState: 'BODY',
      taskBoard: 'BOARD',
      messages: 'MSG',
    })).toBe('a MEM b {{nobody}} c');
  });

  it('warns once and uses the safe template when {{memory}} is missing', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      // The other two templates are fine, so the memory placeholder is the only
      // thing that can produce a warning here.
      writePrompts(h, {
        'manual.md': BODY_MANUAL,
        'memory_system.md': MEMORY_SYSTEM_PROMPT,
        'user_context.md': 'BODY ONLY: {{body_state}}',
      });
      const warnings: string[] = [];
      const coordinator = coordinatorFor(h, [], (fresh) => warnings.push(...fresh));

      const context = coordinator.buildContext(agent, h.clock.now());
      expect(warnings).toEqual([MISSING_MEMORY_WARNING]);
      // The memory survives the fallback, which is the whole point.
      expect(context.user).toContain('=== MEMORY ===');
      expect(context.user).toContain('Name: ada');
      expect(context.user).toContain(`=== END MEMORY ===`);
      expect(context.user).toContain('=== BODY STATE ===');
      expect(context.user).toContain('satiety: 100 / 100');
      expect(context.user).toContain('=== TASK BOARD ===');
      expect(context.user).toContain('=== MESSAGES FROM THE OPERATOR ===');
      expect(context.user).not.toContain('BODY ONLY');
    } finally {
      h.cleanup();
    }
  });

  it('turns a persistent problem into exactly one notice', () => {
    const notices = new PromptWarningNotices();
    expect(notices.take([MISSING_MEMORY_WARNING])).toEqual([MISSING_MEMORY_WARNING]);
    expect(notices.take([MISSING_MEMORY_WARNING])).toEqual([]);
    // Fixed: the condition is forgotten, so a relapse is reported again.
    expect(notices.take([])).toEqual([]);
    expect(notices.take([MISSING_MEMORY_WARNING])).toEqual([MISSING_MEMORY_WARNING]);
  });

  it('runs a whole round from the templates on disk', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      writePrompts(h, {
        'manual.md': 'MANUAL FROM DISK',
        'user_context.md': DEFAULT_USER_CONTEXT_TEMPLATE,
        'memory_system.md': 'MEMORY SYSTEM FROM DISK',
      });
      const memoryModel = new ScriptedModelClient([memoryResponse('ada', agent.bornAt, 'I woke and looked around.')]);
      const coordinator = new RoundCoordinator({
        ledger: h.ledger,
        values: h.values,
        paths: h.paths,
        blackbox: h.blackbox,
        now: h.clock.now,
        memory: memoryModel,
        prompts: testPrompts(h),
        onMemoryError: () => undefined,
      });
      const worker = initWorker(h, new ScriptedModelClient([textResponse('I am fine.')]));

      const outcome = await coordinator.run(agent, worker);
      expect(outcome.endReason).toBe('final');
      expect(outcome.memory?.status).toBe('updated');

      const wake = wakeOf(worker);
      expect(wake.system).toBe('MANUAL FROM DISK');
      expect(wake.user).toContain('=== MEMORY ===');
      expect(wake.user).toContain('Name: ada');
      expect(wake.user).toContain('=== BODY STATE ===');
      expect(wake.user).toContain('Name: ada');

      const system = memoryModel.requests[0].messages.find((message) => message.role === 'system');
      expect(system?.content).toBe('MEMORY SYSTEM FROM DISK');
      expect(MEMORY_PLACEHOLDER).toBe('{{memory}}');
    } finally {
      h.cleanup();
    }
  });
});
