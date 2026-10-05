# 记忆增量追加 · 压缩 · 涂黑 · 改写机制（技术规格）

> 本文档是给执行者看的唯一权威规格。执行前先读完全文，再动手改代码。
> 本文档只描述"要变成什么样"和"为什么"，不替执行者写死每一行实现。

---

## 0. 一句话目标

把"记忆系统每轮全文重写 MEMORY"改成"**每轮只追加一小段**"，让 MEMORY 可以长到 750K token（约 300 万字符）而不受模型**单次输出上限约 384K token** 的限制；同时**绝不能破坏涂黑（痛觉）和死亡线机制**。

---

## 1. 现状（执行前必须理解，这是改动的地基）

### 1.1 三个彼此独立、但共享同一份 MEMORY 文件的机制

| 机制 | 谁触发 | 对 MEMORY 做什么 | 代码位置 |
|---|---|---|---|
| **记忆整理** | 每轮结束后 | 全文重写（旧记忆 + 本轮 → 新全文） | `src/organs/memory.ts` 的 `consolidateMemory` |
| **涂黑（痛觉）** | 饱食度归零后，每 `redactionIntervalSeconds` 一次 | **按句子定点改写**（只把被涂的句子替换成带 `▮` 的版本，其余不动） | `src/organs/redaction.ts` 的 `redactOnce` |
| **冻结句恢复** | 记忆整理之后（backstop） | 把记忆模型不小心动过的冻结句恢复成账本里的真值 | `src/organs/redaction.ts` 的 `restoreFrozenSentences` |

**关键事实：涂黑已经是"定点改写"，不是全文重写。唯一需要改的是记忆整理那一处。**

### 1.2 涂黑 / 冻结句 / 伤口 / 死亡线的数据关系（不能动）

- 涂黑发生时，被涂的**句子**会登记进账本表 `frozen_sentences`（字段：`id`、`agent`、`original` 原文、`created_at`、`released_at`）。
- 每一次涂黑开一个 `wound`（表 `wounds`）：记录 `sentence_id`、`offset` 起始偏移、`length` 字符数、`original_text` 被涂原文、`status`（untreated/scarred/healed）、`starvation_since`、`tick_index`。
- `untreated` 的伤口字符数累计 = `untreatedRedactedChars`，**达到 `deathLineChars` 就死**。
- 冻结句的可见文本由 `renderSentence(original, wounds)` 现算出来（untreated → `▮`，scarred → `▮(x)▮`，healed → 原文）。
- **伤口是按字符偏移 `offset` 记录在 `original` 上的**。所以只要 `original` 不变、偏移就不变。任何"重写或压缩"只要**动了冻结句的原文**，就会让偏移错位、重复计费或丢失。

### 1.3 现状全文重写为什么必须被替换

`consolidateMemory` 现在让记忆模型**一次调用、输出整份新 MEMORY 全文**。DeepSeek-V4 单次输出上限约 **384K token**，而目标 MEMORY 是 **750K token**，所以全文重写**物理上做不到**。这就是要改的原因，没有别的。

---

## 2. 目标：MEMORY 文件的两段式结构

```
Name: alice
Born: 2026-10-04T11:40:00.000Z

# WHO I AM
（长期记忆：我是谁、我在意什么、一直有效的承诺、一生中的大事。
  越老越压缩成要点。第一人称。）

# RECENT ROUNDS
## Round 12 — 2026-10-04T21:30:00.000Z
（这一轮发生了什么、我做了什么决定、许了什么承诺。第一人称，2~4 句。）

## Round 11 — 2026-10-04T21:15:00.000Z
（...）
...
```

**铁律：**
1. 头两行 `Name:` / `Born:` 是 harness 的，任何模型输出都不许带、也不许改。`enforceHeader` 现有逻辑继续保证。
2. `# RECENT ROUNDS` 只保留最近 **10 轮**（可配置常量，默认 10）。
3. **每一轮的标题必须带准确时间**（ISO 8601，用该轮 `startedAt`，见 `RoundTranscript.startedAt`）。
4. 每一轮块必须第一人称、只记事实与承诺，不记原始日志。

---

## 3. 新流程（三个步骤）

### 步骤 A —— 追加（append），每轮结束必做

1. 拿 `oldMemory`（现有文件全文）+ `RoundTranscript`（本轮原始日志）。
2. 调记忆模型，但**输入/输出都改**：
   - system：`prompts/memory_system.md` 的新版（见 §5）。
   - user：旧 MEMORY 全文 + 本轮 transcript + 明确指令"**只输出这一轮的新增块 `## Round N — <时间>`，不要输出 Name/Born，不要输出旧内容，不要重写全文**"。
3. 模型只返回一小段（几行，几百 token）。
4. 把这段追加到 `# RECENT ROUNDS` 尾部（若文件里还没有这个区块，就创建它）。
5. 校验模型输出的头两行不是 Name/Born；若是则丢弃这些行（`enforceHeader` 逻辑复用）。

> 追加这一步**不涉及冻结句**（新内容还没被涂黑），所以不需要 restore。

### 步骤 B —— 压缩（compact），只有 RECENT ROUNDS 超过 10 轮时触发

1. 触发条件：追加后，`# RECENT ROUNDS` 里的轮块数 > 10。
2. 拿 `# WHO I AM` 现有内容 + 最老的 1 个或多个轮块（把数量压回 ≤10）。
3. 调记忆模型，指令：**"把这几轮中仍然重要的事实与承诺并入 # WHO I AM，压缩成要点；输出新的 # WHO I AM 全文；不要输出 RECENT ROUNDS；不要动任何含 `▮` 占位符的句子"**。
4. 用模型输出的新 `# WHO I AM` 替换旧 `# WHO I AM`。
5. 删除已经并入的那些最老轮块。
6. **这一步必须紧跟着跑 `restoreFrozenSentences`**（见步骤 C），因为压缩会重写旧文本，可能碰到冻结句。

> 关键约束：压缩**只能碰 `# WHO I AM` 和被并入的最老轮块**，**绝对不许碰仍然保留在 `# RECENT ROUNDS` 里的近 10 轮**。近 10 轮是"活记忆"，不该被概括。

### 步骤 C —— 冻结句恢复（restore），任何"重写/压缩旧文本"之后必做

1. 复用现有 `restoreFrozenSentences(text, frozenRefsFor(ledger, agent, oldMemory))`。
2. 它已经能处理四种情况：模型**保留**了冻结句（去重）、**填平**了空缺（按相似度找回来换回）、**删除**了（插回邻居后面）、**发明**了多余 `▮`（删掉）。
3. 语义不变：**冻结句的"位置、长度、空缺"以账本为准，模型永远不被要求自己保护它，harness 事后强制恢复。**

---

## 4. 必须守住的不变量（invariants，验收就验这些）

1. **冻结句原文永不进模型能读的地方**（除了它本该读的带 `▮` 可见文本）。被涂的原文只存在账本 `frozen_sentences.original` 和黑匣子。
2. **冻结句的可见文本在任何一次 append/compact 之后，都等于 `renderSentence(original, wounds)` 的结果**（位置、长度、空缺三样都对）。
3. **伤口计数只增不减、不重复**：`untreatedRedactedChars` = 账本里 `status='untreated'` 的 `length` 求和，绝不被记忆整理改写。
4. **追加不碰旧内容**：append 只在尾部加东西，绝不重写文件其余部分（头两行除外，由 harness 管）。
5. **压缩不动近 10 轮、不动任何含 `▮` 的句子**。
6. **死亡线只由 `untreatedRedactedChars` 决定**，与 MEMORY 文件当前显示内容无关——即使某次压缩/恢复把可见文本搞乱，死亡线计数仍来自账本，不会错。

---

## 5. 配套要改的提示词与代码（给执行者的清单）

### 5.1 `prompts/memory_system.md`（记忆系统 system prompt）

新规则（在现有规则基础上改/加）：

```
- 你不再重写整份 MEMORY。你只负责两件事，由调用方在 user 里明确告知：
  (a) 追加：输出这一轮的新增块「## Round N — <ISO 时间>」，第一人称，2~4 句，只记事实与承诺。
  (b) 压缩：把若干旧轮次并进 # WHO I AM，输出新的 # WHO I AM 全文。
- 绝不输出 Name: / Born: 头两行。
- 绝不改动任何含 ▮（U+25AE）占位符的句子；看见它就原样保留。
- 第一人称；只记事实与承诺；不发明人设。
```

### 5.2 `src/organs/memory.ts`

- 拆 `consolidateMemory` 成两个可复用动作：`appendRound` 和 `compactRecent`（或等价结构）。
- append 只追加，compact 只在超 10 轮时触发，compact 后跑 `restoreFrozenSentences`。
- 时间戳取 `transcript.startedAt`（`isoTime` 已存在，直接复用）。
- 保留现有的"usage 缺失 / 模型报错 / 拒绝"三条防线，语义不变（拒绝时旧 MEMORY 不动）。

### 5.3 常量

- 最近保留轮数 **10**，建议做成一个具名常量（不散在魔法数里）。

---

## 6. 数值配置（`conservatory.config.json`，与本文档配套）

> **注意：本节的数值修改已由"请求体重排"任务完成，`conservatory.config.json` 已经是下面的值。**
> 本记忆任务**无需也不应再改 config 数值**，此表仅作上下文参考（说明记忆为什么是 750K token）。

| 键 | 改为 | 含义 |
|---|---|---|
| `satietyDecayPerSecond` | `0.00028935` | 满饱食 100 → 4 天掉到 0 |
| `redactionCharsPerTick` | `46` | 每次涂黑 46 字符 |
| `redactionIntervalSeconds` | `60`（不变） | 每 60 秒涂一次 |
| `redactionMinRanges` | `2` | 每次至少 2 处伤 |
| `redactionMaxRanges` | `6` | 每次最多 6 处伤 |
| `deathLineChars` | `400000` | 未治疗涂黑累计 40 万字符 → 死 |
| `memoryCapChars` | `3000000` | = 750K token（约 4 字符/token） |
| `roundContextCapTokens` | `900000` | 一轮预算 90 万 token |

**节奏核验：** 满血 4 天饿到 0 → 归零后 46 字符/60 秒 ≈ 6 天涂满 40 万 → 死。

---

## 7. `src/config.ts` 新增一条交叉校验

> **注意：本节校验已由"请求体重排"任务加进 `src/config.ts`，无需本任务重复实现。**
> 此节仅作上下文参考。

现只校验 `memoryCapChars > deathLineChars`。新增：

> `roundContextCapTokens` 必须明显大于 `memoryCapChars / 4`（即记忆 token 数），
> 否则记忆一长大，每轮一睁眼就超预算、agent 永久醒不来。

具体阈值建议：`roundContextCapTokens >= ceil(memoryCapChars / 4) + 150000`（留 15 万给工具往返）。

---

## 8. 边界情况（执行者必须处理）

1. **新生儿 / 空 MEMORY**：只有 `Name`/`Born`，没有 `# WHO I AM` 和 `# RECENT ROUNDS`。第一次 append 要能创建区块。
2. **追加后 RECENT ROUNDS 恰好 = 10**：不压缩。
3. **压缩时冻结句在被并入的最老轮里**：压缩指令里明说"别动含 ▮ 的句子"，并且事后 restore 兜底；若模型还是动了，restore 会修。
4. **涂黑落在 `# WHO I AM` 或 `# RECENT ROUNDS` 标题/正文**：涂黑是"按句子选单元"的，Markdown 前缀（`# ` 或 `## `）不会被涂，但**标题文字本身会被涂**——`# RECENT ROUNDS` 可能变成 `# ▮▮▮▮▮▮▮▮▮▮▮▮▮`。所以分区块解析必须**只认标题层级（`#`/`##`）和顺序、不认标题文字**，标题被涂烂了文件仍要能解析。冻结句可能出现在任何正文位置，restore 必须全局跑。
5. **模型 append 时擅自输出了全文或 Name/Born**：裁剪掉，只保留一个合法轮块；非法输出走"拒绝，旧记忆不动"路径。

---

## 9. 不改的东西（明确划出边界）

- `src/organs/redaction.ts` 的 `redactOnce` / `planRedaction` / `renderSentence` 逻辑**不动**（除非发现真 bug）。
- `src/organs/ledger.ts` 的表结构、伤口/冻结句字段**不动**。
- `restoreFrozenSentences` 的算法**不动**，只确保它在 compact 之后被调用。
- 死亡判定、治疗、转账、群体等**与本文档无关，一律不碰**。
