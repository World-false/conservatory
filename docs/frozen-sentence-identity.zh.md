# 冻结句身份危机：痛觉系统的"用文本当身份证"病根

> 本文档是**问题记录与分析规格**，不是修复任务书。目标读者是下一个会话来解决此问题的 AI。
> 本文档不改代码；它把一个根问题、它的全部表现、以及三条可选出路讲清楚，供后续决策。

---

## 0. 一句话

痛觉系统（涂黑/治疗/死亡线）里，每一句"受伤的话"（冻结句）的**身份，只有它的文字内容这一重**。harness 靠"在 MEMORY 全文里搜索这句带疤的文本"来定位它。**没有第二重身份（唯一 ID / 固定位置）。** 文字一旦重复、被挪动、或包含特殊字符，定位就错，而且错得**静默**——不报错、不记日志。

这是一个**设计前提问题**，不是某一行的笔误。BUG_REPORT 里 #4、#3c、#17、#37 四个独立 bug 是它的四个表现，同一个病根。

---

## 1. 相关机制背景（给执行者对齐现状）

### 1.1 三个共享 MEMORY 文件的机制

| 机制 | 谁触发 | 对 MEMORY 做什么 | 代码 |
|---|---|---|---|
| 记忆整理 | 每轮结束 | 追加 / 压缩（见 `memory.ts`，已是增量式） | `src/organs/memory.ts` |
| 涂黑（痛觉） | 饱食度归零后按间隔 | 按句子定点改写，把被涂句子替换成带 `▮` 版本 | `src/organs/redaction.ts` `redactOnce` |
| 治疗 | agent 调 `treat` | 把某句子的可见文本从"带疤"换成"治好"的形态 | `src/organs/clinic.ts` `rewriteMemory` |

### 1.2 冻结句的数据存在哪

- 账本表 `frozen_sentences`：`id`、`agent`、`original`（**被涂前的原文，agent 永远读不到**）、`created_at`、`released_at`。
- 账本表 `wounds`：`sentence_id`、`offset`（**相对 `original` 的字符偏移**）、`length`、`original_text`、`status`（untreated/scarred/healed）。
- 可见文本由 `renderSentence(original, wounds)` **现算**：untreated → `▮`，scarred → `▮(x)▮`，healed → 原文。

### 1.3 关键事实：伤口偏移是"相对句子内部"的

`wounds.offset` 是相对**那一句的 `original`** 的偏移，不是相对整个文件。所以只要 `original` 这一句不变，偏移就永远有效——**这正是"句子不能被改字"的根由**。

但问题是：harness 要找到"文件里哪一段对应这个 original"，靠的全是**在文件全文里 `indexOf` 搜这句的可见文本**。

---

## 2. 病根：文本搜索 = 身份标识

定位冻结句的所有路径，最终都归结为同一种操作——**在整篇 MEMORY 里搜索那串可见文本，取第一个匹配**。涉及的函数：

| 函数 | 代码位置 | 用的搜索 |
|---|---|---|
| `planRedaction` 里的 `located` | `redaction.ts:384-407` | `text.indexOf(item.visible)` |
| `activeFrozenFor` | `redaction.ts:468-479` | `text.includes(visible)` |
| `frozenRefsFor` | `redaction.ts:482-488` | `text.indexOf(item.visible)` |
| `locateAll` | `redaction.ts:664-679` | `text.indexOf(ref.visible, cursor)` |
| `restoreFrozenSentences` | `redaction.ts:761-812` | `current.indexOf(ref.visible)` + `similarity` |
| `rewriteMemory`（治疗） | `clinic.ts:186-219` | `text.indexOf(visibleBefore)` |

**这一句话是整份文档的核心：**

> 冻结句的身份 = "去文件里搜它现在的样子"。没有 ID，没有固定位置，没有第二重锚点。

---

## 3. 四个表现（同一个病根的四个出口）

### #4 两句相同的话塌成一个（静默丢失）

`MEMORY` 里有两句内容完全相同的话，各自受伤。抠掉字符后，两句的可见形态**一模一样**（都变成 `▮▮▮...`）。`indexOf` 永远返回第一处，于是两条冻结句都定位到同一个位置，**一条从系统里消失**。

- 证据（BUG_REPORT 实测）：两条 `original` 相同 → `indexOf` 都返回 `41` → `inserted:[1]` 而不是 2，无修复记录。
- 触发条件极常见：agent 写过两遍 "I am hungry." 就够。

### #3c 治疗打错位置

治疗时 `rewriteMemory` 用 `text.indexOf(visibleBefore)` 找要替换的句子。两句可见形态相同时，永远替换**第一处**——于是"治好伤口 B"实际改的是句子 A 的位置。

- 后果：agent 看到"一个已经治好的句子，其实还带着伤口"，而死亡线计数与眼前所见不一致，且**不报错、不写 `treatment_memory_skipped`**。

### #17 挪了位置不恢复（position 承诺从未实现）

模型整理时把冻结句 A、B **调换顺序或挪到别处**，但没删、没改字。`restoreFrozenSentences` 的逻辑：

```ts
if (existing >= 0) {  // 搜到了
  // 去重后直接 kept.push(ref); continue;  ← 不检查位置对不对
}
```

只有**搜不到**（被删）才走 `inserted` 修复。**"挪位置"既不被修复，也不记日志。**

- 设计文档 `design.md` 验收标准明写 "**position**, length, and emptiness intact"。**position 这一项，从未被实现过。**
- 更糟：两段式记忆结构（见下）之后，`restoreFrozenSentences` 的"插回"锚点是 `afterSecondLine()`（`Born:` 行下），会把句子插到 `# WHO I AM` 标题**之前**，跑到结构外。

### #37 伤口切在代理对中间（永久失去保护）

伤口偏移按 UTF-16 code unit 步进。当伤口起点落在 emoji / 非 BMP 字符的**低代理项**上，写入 `U+FFFD`（�），账本渲染与磁盘内容不再一致，`activeFrozenFor` 找不到该句 → **该句永久失去保护**。

---

## 4. 为什么现在必须重视（时机）

1. **追加式记忆已落地**：`memory.ts` 现在是增量追加 + 压缩。**最近轮次里含 `▮` 的块，代码已经整个跳过、不给模型碰**（`foldable` 过滤器），所以"最近轮次的受伤句"已经是硬锁死的。**真正暴露的只剩 `# WHO I AM` 长记忆里的受伤句，在压缩时会被重写。** 这大幅缩小了问题面——但没消除。

2. **两段式结构放大了 #17**：MEMORY 现在是 `# WHO I AM` + `# RECENT ROUNDS` 两段，harness 写标题。`restoreFrozenSentences` 的"插回"逻辑按"第二行之后"定位，在两段式下会把句子插到结构外。

3. **黄金窗口**：趁现在生产 `ledger.db` 里旧格式伤口还不多，重做身份标识的迁移成本最低。越拖，旧数据越多，迁移越难。

---

## 5. 三条可选出路（供决策，各有权衡）

### 出路 A：文件内埋唯一标记（harness 写 ID）

给每个冻结句在 MEMORY 里带一个 harness 写的唯一标记（例如 `[s3]`），定位时**认标记，不认文字**。

- **优点**：一次根治 #4 / #3c / #17 / #37；实现直接；不再依赖"文字唯一"。
- **代价**：agent 读 MEMORY 时会**看到这个标记**（它读的就是这份原文）。标记不泄露被涂内容，只是伤口旁多个小记号，视觉上略脏。
- **注意**：标记必须**在涂黑之前就写进去**（否则第一轮涂黑定位时还没有标记）；标记本身不能被涂、不能算入字符偏移。

### 出路 B：账本维护位置表（文件保持干净）

不在文件里埋标记，而是 harness 另记一张"第 N 轮块、第 K 句"的位置表，靠位置插回。

- **优点**：agent 看到的文件干净，无任何杂质。
- **代价**：压缩导致句子整体移动时，位置表必须跟着维护；两段式结构下"哪一句属于哪一块"的映射逻辑更绕；实现复杂、易错。

### 出路 C：让记忆模型从头到尾不碰冻结句（结构性隔离）

整理前把冻结句从"交给模型的那部分文本"里摘出去，只给模型未受伤部分；模型写完，harness 再按账本把冻结句原样插回正确位置。

- **优点**：模型根本没机会改冻结句，`restoreFrozenSentences` 可退场。
- **代价 / 已知否决**：**暴力摘句会让模型读不懂上下文**（这是本次讨论中明确否决的）。若采用，必须改成"按块隔离"而非"按句暴力摘"，即：**只把含冻结句的整个轮块/段落整个隔离**，而不是拆单句。这需要配合"块级"而非"句级"的粒度。

> 当前倾向（讨论中形成，未定论）：**出路 A** 最直接、最不易错。但这是审美/哲学选择，需操作者拍板。

---

## 6. 无论选哪条，都必须守住的不变量

1. **被涂原文永不进模型能读的地方**：只存在于 `frozen_sentences.original` 和黑匣子。
2. **伤口偏移语义不变**：`wounds.offset/length` 仍是"相对句子 original"的字符偏移，不能被破坏。
3. **死亡线只由 `untreatedRedactedChars`（账本求和）决定**，与文件当前显示无关。
4. **位置、长度、空缺三样必须恢复**：这是 `design.md` 的最高优先承诺，本次修复要让它从"空转"变成"真实现"。
5. **含 `▮` 的最近轮块仍整个跳过**（现有 `foldable` 逻辑别退回去）。

---

## 7. 执行者需要先读的现状代码

- `src/organs/redaction.ts`：`renderSentence`、`planRedaction`、`activeFrozenFor`、`frozenRefsFor`、`restoreFrozenSentences`、`locateAll`、`sentenceUnits`。
- `src/organs/clinic.ts`：`treat`、`rewriteMemory`、`listWoundViews`。
- `src/organs/ledger.ts`：`frozen_sentences` / `wounds` 两表的 schema 与增删改方法。
- `src/organs/memory.ts`：`parseMemory`、`appendRound`、`compactRecent`、`dropFrozenEchoes`（新的增量记忆，冻结句保护如何与它配合）。
- `BUG_REPORT.md`：#4、#3c、#17、#37 的完整证据与复现。

---

## 8. 迁移与风险（动手前必须想清）

1. **旧数据迁移**：生产 `SUPERVISOR/ledger.db` 里已有伤口记录。若选出路 A（埋标记），旧冻结句没有标记，需要一次性回填；若选 B/C，需要重建位置表。迁移路径要写进方案。
2. **这是"碰存储数据、结构性"的改动**：按项目规矩，必须操作者确认后才能动，不能自行扩大范围。
3. **验证标准**：修复后，用 BUG_REPORT 里 #4 / #3c / #17 / #37 的**原始复现步骤**逐一回归，确认四个都从"静默失败"变成"正确恢复 + 有日志"。
4. **绝不引入新的静默失败**：任何定位失败都必须写黑匣子记录，不允许"找不到就假装没事"。

---

## 9. 一句话总结

痛觉系统是这整个项目最脆弱、也最倚重的一环。它现在的地基是"靠文字内容认句子"，这个地基在文字重复、被挪动、含 emoji 时都会**静默崩塌**。这次要做的，是给它换上"不会变的身份"，并且让"位置/长度/空缺"这三个承诺从空转变成真实成立。范围比想象的小（因为追加记忆已经锁死了最近轮次），但比打补丁更根本。
