# 执行提示词（请求体重排 · 数值 · 校验 · 测试文档）

> 直接复制本文下方"任务书"那一整块发给执行型 coding agent。
>
> **注意：本任务书不含"记忆机制"（MEMORY 两段式结构、增量追加、压缩、涂黑保护）。**
> 记忆机制是另一个独立任务，有它自己的文档，请勿在本任务里做、也勿依赖它完成。
> 本任务只改：请求体结构、配置数值、配置校验、以及这三者对应的测试与文档。

---

## 项目背景（一句）

`I:\conservatory`，一个 TypeScript + Node 写的 agent harness（"温室"）。要做一批有明确目标、精确数值、验收标准的改动。不重构、不顺手改、不碰无关代码。

---

## 任务书（复制这段发给执行 agent）

你是一个执行型 coding agent。项目根目录 `I:\conservatory`。请严格按下面 4 块完成改动，每块完成后自己跑相关测试确认，最后一次性汇报改了什么、哪些测试通过、哪些没跑。

**动手前先读：** `docs/design.zh.md` 的 §2（生命流）、§5（损伤与治疗）。理解现状即可，不要按它的旧描述去改别处。

---

### 块 1：请求体结构重排（把"自我"从 user 挪进 system）

**目标：** 每轮发给 agent 的请求体变成——

```
messages[0]  role=system   内容 = 身体说明书(manual.md) + "# MEMORY\n{{memory}}" + "# BODY STATE\n{{body_state}}"
messages[1]  role=user     内容 = "# SYSTEM REMINDERS\n{{system_reminders}}" + "# MESSAGES\n{{messages}}"
tools        16 个工具（不变）
```

**重要边界：** MEMORY 块的**内部内容**不用动（它现在就是 `Name`/`Born` + 正文；正文格式的改造属于另一个独立任务，本任务不碰）。本任务只改 MEMORY 和 BODY STATE 在请求体里的**位置**。

**具体改动：**
- `src/supervisor/round.ts` 的 `buildContext()`：现在它把五块（memory / body_state / task_board / system_reminders / messages）全塞进一条 user 文本。改成：
  - **MEMORY 和 BODY STATE 拼进 system**，跟在 `manual.md`（说明书）文本之后；
  - **SYSTEM REMINDERS 和 MESSAGES 留在 user**；
  - **TASK BOARD 不再注入**。
- `prompts/user_context.md`：现在有 5 个占位符。改成只保留 `{{system_reminders}}` 和 `{{messages}}`。同时需要一个 system 侧模板（或等价实现）承载 `{{memory}}` 和 `{{body_state}}`，与 `manual.md` 拼在一起。
- `src/organs/prompts.ts`：`DEFAULT_USER_CONTEXT_TEMPLATE` 与渲染逻辑同步改，保证 system、user 两个模板都正确填充；`{{memory}}` 的"丢失即拒绝"保护语义要**从 user 模板挪到 system 模板**（即 system 侧模板缺少 `{{memory}}` 时降级用内置兜底）。
- `prompts/manual.md` 两处文案改：
  1. 第一句 `It is the only thing that is always true about you, and it does not change between rounds.` → 改成不再宣称"唯一且不变"（因为 system 里现在同时有每轮都变的 MEMORY 和 BODY STATE）。建议类似 `It describes your body and how it works.`，具体措辞自定，但必须消除"唯一不变"这个自相矛盾的表述。
  2. `THE ROUND` 段里 `this manual, your MEMORY, your current body state, the task board, and any messages waiting for you` → 去掉任务板，改为说明"任务板用 `list_tasks` 工具查看"。

**验收：** 读 `src/supervisor/round.ts` 确认 `buildContext` 返回的 `system` 含 MEMORY 和 BODY STATE、`user` 只含提醒和消息、任务板内容不在任何一处注入。

---

### 块 2：数值配置（`conservatory.config.json`）

把以下键改成这些值（其余不动）：

| 键 | 改为 |
|---|---|
| `satietyDecayPerSecond` | `0.00028935` |
| `redactionCharsPerTick` | `46` |
| `redactionMinRanges` | `2` |
| `redactionMaxRanges` | `6` |
| `deathLineChars` | `400000` |
| `memoryCapChars` | `3000000` |
| `roundContextCapTokens` | `900000` |

（`redactionIntervalSeconds` 保持 `60` 不变。）

---

### 块 3：`src/config.ts` 新增一条交叉校验

现在只校验 `memoryCapChars > deathLineChars`。再补一条：

> `roundContextCapTokens` 必须 ≥ `ceil(memoryCapChars / 4) + 150000`，
> 否则记忆一长大每轮就超预算、agent 永久醒不来。违反则加入 errors 报错。

（说明：约 4 字符/token，`memoryCapChars/4` 是记忆的 token 量，+150000 是给一轮内工具往返留的余量。）

---

### 块 4：同步测试与文档（仅请求体重排相关）

**测试会挂是"预期"**——那是断言过时，不是功能坏了。分清楚"改断言"和"改坏了"。

- `test/round.test.ts`：多处 `expect(wake.user).toContain('# BODY STATE')`、`toContain('# MEMORY')`、`toContain('Count the clouds')`（任务板）、`toContain('# SYSTEM REMINDERS')`、`toContain('# MESSAGES')` 等。重排后：
  - BODY STATE / MEMORY 的断言改到 `wake.system`；
  - 任务板相关断言删除；
  - SYSTEM REMINDERS / MESSAGES 仍断 `wake.user`。
- `test/society.test.ts`：`section(bobWake.user, '# BODY STATE')`、`section(bobWake.user, '# MEMORY')` 同理改到 `wake.system`；`# SYSTEM REMINDERS` / `# MESSAGES` 仍断 `wake.user`。
- `test/prompts.test.ts`：`DEFAULT_USER_CONTEXT_TEMPLATE` 与模板拆分的断言同步改。
- 文档：`docs/design.zh.md`（和 `docs/design.md`）§2 更新两处：
  1. 任务板改为"用 `list_tasks` 工具主动查看"；
  2. 补一句明确说明：**MEMORY 被放进 system 后，模型会把过去的承诺当作更硬的约束、更不易反悔**（这是设计决定，不是副作用）。

---

### 全局要求（务必遵守）

1. 只改上面列出的文件和目标，不重构、不顺手优化、不碰无关代码。
2. 每改一块就跑 `pnpm test`（或项目现有测试命令）里相关的测试，确认是"断言过时"还是"真改坏了"。
3. 改完汇报：每个文件改了什么、哪些测试通过、哪些没跑、有没有偏离本任务书的点。
4. 遇到与规格冲突的地方，停下来说清楚，不要自行扩大或缩小范围。
