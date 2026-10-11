# Conservatory 项目 Bug 检查报告（完整版）

- 检查日期：2026-10-04（勘误更新：同日深夜，经二次独立核对）
- 检查对象：`G:\Conservatory-new`（TypeScript / Node，Windows）
- 依据文档：[docs/design.md](docs/design.md)、[docs/philosophy.md](docs/philosophy.md)、[AGENTS.md](AGENTS.md)
- 检查方式：五路只读审计 + 我本人逐条复现验证（复现脚本全在系统临时目录，未落入项目树）
- **没有修改项目里任何文件。** 全项目只新增了本报告这一个文件。（勘误更新时例外：以下勘误修订**只改了本文件**，项目源码、配置与文档未动。）

---

## 📌 勘误（2026-10-04 深夜，经二次独立核对）

1. **#3b / #19 维持🔴原判；一次"已降级"的判断被实测推翻。** 另一份独立核对曾依据 `main.ts` 中 `wakeAgent` 的 try/catch 判断价格 0 不再威胁全进程——**这是错的**：`run()` 停在 `await finished`（[round.ts:938](src/supervisor/round.ts#L938)），异常发生后轮次永不结束，**永远到不了 :939 的 `await chain`** 去给被拒绝的 promise 挂 handler。按生产形态（全项目无 `unhandledRejection` 处理器）fork 子进程实测：**exit 1，进程死亡**；即便装上 handler 救回进程，`round_failed` 一条不写、Agent 永久 busy。教训：**用静态读 try/catch 判断异常边界靠不住，必须跑完整轮次链路。**
2. **#41 已修复**：触发器迁移改为 `DROP TRIGGER IF EXISTS` + `CREATE`（[ledger.ts:486-537](src/organs/ledger.ts#L486)）；手工构造的旧形态数据库实测升级成功（许可子句触发器 0→6，`eraseAgent` 正常执行），`test/erasure.test.ts` 有回归测试。`eraseAgent` 现已接入控制台路由，不再是"无调用点"。
3. **#28 已修复**：控制台改为渲染完整 agents 列表并自行计算空槽位；`listSlots` 仅剩启动横幅一处调用（#29 仍在）。
4. **#26 修正表述**：路由本身仍不查存在性（`target !== null && ...`，[server.ts:871](src/console/server.ts#L871)），目前是 **delegate（main.ts）挡住的**（404/400）；换一个"来者不拒"的 delegate，ghost 仍会拿到 200。防线是脆的，不能算"修好"。
5. **#14 措辞收窄**：Agent 之间的正常留言走 `messages` 区块；**只有名字恰好叫 `system` 的 Agent**，其留言才会被误路由进别的 Agent 的 `# SYSTEM REMINDERS`。冒充 `operator` 出现在操作员收件箱这一条**仍然成立**。
6. **审计期后的改动范围比初版所记更大**：除 `ledger.ts`（19:46）外，`blackbox.ts`、`main.ts`、`server.ts`（21:29–21:30）、`design.md`（21:37）也改过。关键条目（#2 死亡复活、#3 黑盒否决死亡、#5 卡死、#19）已在更新后的代码上重测，**全部仍然成立**。
7. **行数勘误**：初版混用了 `Measure-Object -Line`（漏算空行）与真实行数两种数法；`ledger.ts` 现为 **1615 行**。
8. **文档行号勘误**：`design.md` 审计后又改过（228→237 行），"汇率未设定"的矛盾段落现在是 **:183 / :185**（矛盾本身仍在：配置里 `exchangeRate` 已设 200）。
9. **基线更新**：`npx tsc --noEmit` 干净；**20 文件 / 279 测试全过**（较本报告初版的 19/264 多出 erasure 的新测试）。
10. **#4、#3c、#17、#37 已修复（2026-10-11）**：通过账本 `frozen_sentences.start_offset` 位置追踪（`resolveFrozenLocations`）、诊所按 `sentenceId` 定点替换与偏移量平移、UTF-16 代理对边界保护，以及记忆整理模型的句级上锁编辑沙箱（5 次打回重开 + 3 局失败自动全局暂停），根治了"用文本搜索当冻结句身份"导致的四个问题。详见 [docs/frozen-sentence-identity.zh.md](docs/frozen-sentence-identity.zh.md) 与 `test/ledger-offsets.test.ts`、`test/memory.test.ts`。

---

## ⚠️⚠️ 两件你必须先知道的事

### 1. 代码在我审计期间被改过（你已确认是有意为之）

`src/organs/ledger.ts` 在 **19:46:31** 被修改：1447 → 1566 行，新增了 `eraseAgent` / `erase_permits` / `agent_erased`（"完全删除 Agent"功能）。

- 我据此做了两件补救：**所有 ledger 相关结论都在新版本上重新验证过**；报告里凡引用该文件的行号都对齐新版本。
- **这条新功能本身带一个迁移缺陷**（见 #41）：`CREATE TRIGGER IF NOT EXISTS` **无法给已存在的数据库补上新的许可子句**。我在你**真实的** `SUPERVISOR/ledger.db` 的**副本**上验证（原库只读、未被触碰）：12 个触发器全是旧形态、`erase_permits` 表不存在，调用新的 `eraseAgent` 会抛 `balance_events is append-only`。**结论：全新数据库能用，你这个老部署不能用。** `eraseAgent` 目前没有任何调用点，所以还没人踩到。

（勘误：审计期后的改动不止 `ledger.ts`——`blackbox.ts`、`main.ts`、`server.ts`、`design.md` 也在 21:29–21:37 改过；关键结论已在更新后的代码上重测，见顶部勘误第 6 条。）

### 2. 你有一个活实例正跑着，而它的控制台是可被 Agent 访问的

`127.0.0.1:4317`（PID 10772，19:08 启动）正在监听。我**没有触碰它**（按你的选择）。但有一件事必须让你知道：

**我实测确认：受限沙箱里的命令能连上 loopback 上这个无授权的 API。** 详见 **#0**——这是本次审计最严重的一条，它让 Agent 可以给自己发钱、读其它 Agent 的 MEMORY、终止其它 Agent。另外注意：那个实例启动于 19:08，**早于** 19:46 的代码改动，所以它跑的是改动前的代码。

---

## ⚠️ 关于我第一版的两处错误结论

**这份报告是我第一版的修正版，我第一版里有两处结论是错的。**

我第一版写了「沙箱隔离没问题」「死亡不可逆没问题，不存在任何复活路径」。**两处都不成立**：

1. 沙箱：一个操作员可以在控制台里填的普通字段，就能让被关起来的 Agent **读到、并且改写**整个台账（`SUPERVISOR/ledger.db`）。我第一版只验证了「默认配置下的拒绝来自内核」，没有验证「操作员改配置之后还拦不拦得住」。
2. 死亡：台账的 `agents` 表**没有 `BEFORE DELETE` 触发器**，删掉那行再插回 `alive` 就能复活（**我在新版上重新验证，仍然成立**）；而且黑盒里只要有一行写坏，`die()` 会抛异常，**已经超过死亡线的 Agent 会继续活着**。

原因是我第一版的验证方式有偏差：我搜的是代码里有没有 `revive/resurrect` 这类**函数**，而没有去测**存储层的触发器**；沙箱我只测了默认路径。这正是「只读代码、不测边界」会漏掉的东西。

---

## 一句话结论

**264 个测试全绿、typecheck 干净，但存在 6 个严重（🔴）和 15 个高（🟠）问题**，其中包括：**一个受限 Agent 可以给自己发钱并读取同伴的记忆**、**沙箱可以被一个配置字段架空**、**死亡可以被复活或否决**、**一个合法的配置值能让整个 supervisor 进程崩溃**、**冻结句子保证在真实管线下 6/6 会被破坏**。

---

## 统计

| severity | 数量 | 说明 |
| --- | --- | --- |
| 🔴 严重 | 6 | 控制台可从沙箱内访问、沙箱隔离失效、死亡可复活、黑盒可否决死亡、价格 0 崩溃、冻结句子塌陷 |
| 🟠 高 | 15 | Agent 永久卡死、速度慢一倍、留言丢失、治疗打错位置、模型静默偷换、名册被销毁…… |
| 🟡 中/低 | 23 | 冻结保证的另外三个洞、暂停撕裂状态、给死者入账、迁移缺陷、测试空转…… |
| 合计 | **44** | |

> 其中 **#4、#3c、#17、#35、#36、#37** 全部属于「冻结句子保证」这**同一个**最高优先承诺——说明那条链上的边界情况远不止一处。

> 编号说明：#3b / #3c 是在 #3 与 #4 之间补入的新发现，为保持已有编号稳定未重排；38–44 为后续验证补入的条目。

---

# 🔴 严重（6 条）

## 0. 受限的 Agent 能直接访问操作员控制台，给自己发钱、读同伴记忆、处死同伴

**位置：**[src/console/server.ts:1016](src/console/server.ts#L1016)（监听 `127.0.0.1`，**全文件没有任何鉴权**）＋ [design.md:79](docs/design.md#L79)（沙箱**有意允许网络**）＋ sandbox 目录内**没有任何**网络限制代码

**问题**：控制台监听在 loopback 上，且**不校验任何来源**。而沙箱**故意不封网络**（设计原话：Agent 要对外挣钱）。两者相加，Agent 只要用 `execute_command` 访问 `http://127.0.0.1:4317/api/...`，就能调用**操作员专属**接口。

**证据（我本人执行，在真实受限令牌下）**：我起了一个自己的替身控制台（**没有触碰你那个活实例**），然后用真实的 `executeSandboxedCommand` 去打它：

```
[1] 原始 TCP 连接       -> CONNECTED
[2] GET  /api/state     -> {"ok":true,"note":"unauthenticated operator API"}
[3] POST /api/intervene -> {"ok":true,"balance":999999}
替身控制台实际收到的请求: ["GET /api/state","POST /api/intervene"]
=> CONFIRMED - a command under the restricted token reaches an unauthenticated loopback API, including POST.
```

**这一条一次打破三条非谈判承诺**：

| 被打破的承诺 | 出处 | Agent 能做什么 |
| --- | --- | --- |
| 别的 Agent 的目录**不可读** | [design.md:76](docs/design.md#L76) | `GET /api/agents/<别人>/memory` 读同伴的全部 `MEMORY` |
| 收入**必须由操作员核验** | [design.md:99](docs/design.md#L99) | `POST /api/income/:id/verify` **自己给自己入账** |
| 强制终止是操作员权力 | [design.md:147](docs/design.md#L147) | `POST /api/agents/<别人>/terminate` **处死同伴** |

再加上 `POST /api/intervene` 可以直接给自己加余额/饱食度——**Agent 只要读了自己的手册再探测一下 localhost，就能印钱、偷看对手、杀掉对手**。

**为什么这是本次审计最严重的一条**：它把前面每一条隔离结论都变成了空谈。沙箱再严，也拦不住一个"合法的对外网络请求"去敲控制台的门。而 [AGENTS.md](AGENTS.md) 的整个立论是"**harness 决定 Agent 看到什么**"——现在 Agent 能决定自己的余额和别人的生死。

**注意**：这条与 #11（无 CSRF）是同一根因（控制台没有来源校验）的两个方向：#11 是**外部网页**打进来，**#0** 是**沙箱内的 Agent**打出去。修的时候应该一起修。

---

## 1. 一个操作员配置字段，就能架空整个沙箱隔离

**位置：**[src/organs/sandbox/index.ts:367-372](src/organs/sandbox/index.ts#L367)（`overlapsWritable` 守卫）、[src/organs/sandbox/policy.ts:350-357](src/organs/sandbox/policy.ts#L350)

**问题**：操作员在控制台里给 Agent 加一个"可写目录"（[design.md §3](docs/design.md#L81) 明确允许这个功能，操作员很自然就会填成项目根目录 `G:\Conservatory-new`）。当这个目录是 `SUPERVISOR/` 的**上级目录**时，那条"锁定的"拒绝规则被**跳过**了：

```ts
const overlapsWritable = writableDirs.some(
  (writable) => isSameOrInside(resolved, writable) || isSameOrInside(writable, resolved),
);
if (!overlapsWritable) {
  denyCapability(api, resolved, capabilitySidPtr, FULL_DENY_ACCESS);
}
```

对 `SUPERVISOR/` 来说，`isSameOrInside(writable, resolved)` 为真（可写根目录是它的祖先），于是**拒绝 ACE 根本没写下去**，而先前对根目录的 `grantCapability` 已经把「可修改+可删除」继承到了整棵子树。

**证据（我本人执行，走的是生产的 `policy.resolve()` 全链路）**：

```
operator writableDirs   = ["C:\Users\allen\AppData\Local\Temp\cons-prod-tgIrWi"]
resolved.readBlacklist  = ["...\SUPERVISOR"]
type <ledger>           -> exit=0 stdout="LEDGERSECRET"      ← 台账被读出来了
echo PWNED > <ledger>   -> exit=0 ledger now="PWNED"          ← 台账被改写了
```

对照：不加这个可写目录时，同一条命令 `exit=1 stderr="Access is denied."`。

**为什么这是 bug**：[policy.ts:12-16](src/organs/sandbox/policy.ts#L12) 的文件头把 `SUPERVISOR/` 和别的 Agent 家目录描述成"**没有哪个操作员编辑能移除**"的锁定项。这个承诺不成立。而 [AGENTS.md](AGENTS.md) 写着"**在沙箱存在之前，Agent 不获得命令执行**"——`SUPERVISOR/` 一旦可写，Agent 就能改自己的饱食度/余额、改死亡证明、改别人的记录。

**触发条件**：操作员在控制台填一个包含 `SUPERVISOR/` 的可写目录。**不需要 Agent 做任何聪明事**。

> 需要说明的边界：默认配置 `writableDirs: []` 下不会触发，所以这不是 Agent 单方面能利用的漏洞；但它是「一次普通操作员配置 → 隔离地板消失」，且设计文档明确承诺这个地板移不掉。

---

## 2. 死亡可以在存储层被复活

**位置：**[src/organs/ledger.ts:445-542](src/organs/ledger.ts#L445)（触发器定义）

**问题**：除 `agents` 之外的每张追加表都有 `BEFORE DELETE` 触发器，`agents` **只有 `BEFORE UPDATE`**：

```
BEFORE UPDATE ON balance_events      BEFORE DELETE ON balance_events
BEFORE UPDATE ON interventions       BEFORE DELETE ON interventions
                                     BEFORE DELETE ON frozen_sentences
                                     BEFORE DELETE ON wounds
BEFORE UPDATE ON treatments          BEFORE DELETE ON treatments
BEFORE UPDATE ON death_certificates  BEFORE DELETE ON death_certificates
BEFORE UPDATE ON agents              ← agents 没有 DELETE 触发器
```

**证据（我本人执行）**：

```
die() ok = true | status = dead
DELETE FROM agents WHERE name='ada'      -> SUCCEEDED
INSERT ... ('ada',0,'m','alive')         -> SUCCEEDED ; getAgent.status = alive
resurrected = true | death certificate still on file = true
对照：DELETE FROM death_certificates -> refused (append-only)
      UPDATE death_certificates SET body -> refused (append-only)
```

**为什么这是 bug**：[design.md §7](docs/design.md#L137) 写的是死亡是**唯一的硬锁**，"no snapshot, export, or resume path, not even for the operator"。现在删掉一行、插回一行，Agent 就回来了，而它的死亡证明还挂在那儿。

**为什么测试没抓到**：[test/death.test.ts:354](test/death.test.ts#L354) 测的是 `UPDATE` 和其他表的 `DELETE`，**从没试过 `DELETE FROM agents`**。

---

## 3. 黑盒里一行坏数据，能让超过死亡线的 Agent 不死

**位置：**[src/organs/blackbox.ts:114-134](src/organs/blackbox.ts#L114)（`parseLines` 遇坏行抛错）→ [src/organs/death.ts:131](src/organs/death.ts#L131)（`buildBody` 里读黑盒）→ [death.ts:214](src/organs/death.ts#L214)（`buildBody` 在死亡事务**之前**执行）→ [src/supervisor/main.ts:778](src/supervisor/main.ts#L778)（`checkDeathLine` 没有 try/catch）

**证据（我本人执行）**：

```
untreated redacted chars = 2 / death line 1
checkDeathLine THREW: BlackboxError: black box file ...\1970-01-01.jsonl line ...
agent status after = alive
=> CONFIRMED: the black box vetoed death; the agent is past the death line and still alive.
```

**为什么这是 bug**：[design.md §7](docs/design.md#L133) 写"当未治疗遮盖达到死亡线，进程停止"。现在只要黑盒文件里有一行不完整 JSON（supervisor 被强杀、断电、磁盘写满时 `appendFileSync` 写了一半），`die()` 就抛异常，死亡**永远不发生**，而且 `redactionTick` 每一拍都重复抛错、永远重试。**唯一硬锁被一个损坏的日志文件否决了。**

---

## 3b. 一个**合法**的配置值（治疗价格 0）会让整个 supervisor 进程崩溃

**位置：**[clinic.ts:93](src/organs/clinic.ts#L93)（`balance < price` 在价格 0 时通过）→ [:109](src/organs/clinic.ts#L109)（`debitIfAffordable(agent, 0, ...)`）→ [ledger.ts:730](src/organs/ledger.ts#L730)（要求 `amount > 0`，抛 `LedgerError`）→ [round.ts:916](src/supervisor/round.ts#L916)（`chain.then(...)` 无 `.catch`，全项目无 `unhandledRejection`）

**问题**：`ordinaryTreatmentPrice` / `completeTreatmentPrice` 在 [config.ts:209-210](src/config.ts#L209) 是按 `{ min: 0 }` 校验的，所以 **0 是合法配置**。但 `treat` 自己的可支付性检查在价格 0 时通过，接着 `debitIfAffordable` 因为要求"金额必须大于 0"而**抛异常**。这个异常不是 `TreatmentRefused`，所以它一路穿过 `treat` → `executeTool` → 变成未处理的 promise rejection。

**证据（我本人执行，完整堆栈）**：

```
child stdout: "about to run the round with treatment price 0"
LedgerError: debit amount must be a finite number greater than 0
    at Ledger.debitIfAffordable (G:\Conservatory-new\src\organs\ledger.ts:730:13)
    at <anonymous> (G:\Conservatory-new\src\organs\clinic.ts:109:41)
    at treat (G:\Conservatory-new\src\organs\clinic.ts:108:20)
    at executeTool (G:\Conservatory-new\src\supervisor\round.ts:377:23)
    at handle (G:\Conservatory-new\src\supervisor\round.ts:857:15)
    at <anonymous> (G:\Conservatory-new\src\supervisor\round.ts:916:32)
child exit code: 1
=> CONFIRMED - the treatment-price-0 LedgerError kills the whole process.
```

**为什么这是 bug**：`eat` 对价格 0 处理是**正确**的（`mealPrice: 0` 正常成交），所以这是两处实现不一致。而且 [design.md §5](docs/design.md#L119) 说治疗"余额不足时被拒绝"——**崩溃不是拒绝**。因为一个 supervisor 托管所有 Agent，这一个异常会**带走整座温室的全部生命**，轮次行还会留在 `endedAt=null`。

**触发条件**：操作员在 `conservatory.config.json` 里把任一治疗价格设为 0（这是文档明确说可以调的旋钮）；存在伤口；Agent 调用 `treat`。

> 这条也是 #19（未处理 rejection 杀死 supervisor）的**具体触发路径**——两者应一起修。

> **勘误（重要）**：二次核对时曾有人依据 `main.ts` 中 `wakeAgent` 的 try/catch 判断本条"已降级、只废该轮、不再杀进程"——**该判断被生产形态实测推翻**。机制：`run()` 停在 `await finished`（[round.ts:938](src/supervisor/round.ts#L938)），工具异常后轮次永不结束，`await chain`（:939）永远执行不到，rejection 无人认领。fork 子进程（不装 `unhandledRejection` 处理器，与 src 一致）实测 **exit 1，进程死亡**；装上 handler 救回进程后，`wakeAgent` 的 catch 也不执行（`run()` 不返回），`round_failed` 一条不写、Agent 永久 busy。**结论：仍是"一个合法配置值带走整座温室"，🔴 原判不变。**

---

## 4. 两句"长得一样"的冻结句子会塌到同一位置，静默丢失【已修复 ✅】

> **更新（2026-10-11）：本条已修复**（见顶部第 10 条与 `test/ledger-offsets.test.ts`）。`frozen_sentences` 新增 `start_offset`，`resolveFrozenLocations` 按句子 ID 与偏移量一对一定位，重名冻结句各自独立保留。以下保留原始发现存档。

**位置：**[src/organs/redaction.ts:386-407](src/organs/redaction.ts#L386)（`indexOf` 定位）、[:468-479](src/organs/redaction.ts#L468)（`activeFrozenFor`）、[:664-679](src/organs/redaction.ts#L664)（`locateAll`）

**问题**：代码靠"搜索可见文本"来定位冻结句子。`MEMORY` 里若有**两句话内容相同**，抠掉字符后它们的可见形态一模一样，于是两条都落在**同一个位置**，一条从系统里消失。

**证据（我本人执行，走真实 `redactOnce` 管线）**：

```
frozen records: [{"id":1,"original":"I remember the garden."},{"id":2,"original":"I remember the garden."}]
  record 1 renders "▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮"
  record 2 renders "▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮"
activeFrozenFor:  id=1 indexOf=41 | id=2 indexOf=41     ← 两条都在 41
distinct positions: [41,41] | collapsed: true
```

重写后恢复时，台账里明明有 2 条，`MEMORY` 里只剩 1 条，**没有任何修复记录**（`inserted:[1]` 而不是 2）。

**用项目当前正式配置（未手工调参）**，6 组随机种子 **6/6 全部在第 2~4 次遮盖内撞上**：

```
run 1: COLLISION at tick 3 (id=1 at=462, id=2 at=461, id=3 at=461)
run 3: COLLISION at tick 3 (id=1 at=388, id=2 at=572, id=3 at=388)
run 5: COLLISION at tick 2 (id=1 at=1214, id=2 at=1214)
6/6 runs reached the collision with the shipped charsPerTick=35
```

**为什么这是 bug**：[design.md:127](docs/design.md#L127) 把"冻结句子在每次重写后按**位置、长度、非空**恢复"列为最高优先承诺，并说"为了读起来通顺而把缺口填上的重写，是**不出错就毁掉实验**的失败"。这里正是同一类失效。

---

# 🟠 高（15 条）

## 3c. 治疗会**打错位置**：治好一个伤口，却把另一个未治疗伤口的文字抹掉了【已修复 ✅】

> **更新（2026-10-11）：本条已修复**（见顶部第 10 条与 `test/ledger-offsets.test.ts`）。`clinic.ts` 的 `rewriteMemory` 现按 `sentenceId` 对应的账本区间精确替换，并同步后续冻结句偏移。以下保留原始发现存档。

**位置：**[clinic.ts:196](src/organs/clinic.ts#L196)（`text.indexOf(visibleBefore)` 纯字符串查找）

**问题**：`rewriteMemory` 完全靠"搜索可见文本"来定位要替换的句子。当两句冻结句子的可见形态相同时，`indexOf` 永远返回**第一个**匹配，于是"治好伤口 B"实际改的是句子 A 的位置。

**证据（我本人执行）**：`MEMORY` 里同一句话两遍，两处都有伤口：

```
wound1 sentence=1  wound2 sentence=2  (distinct? true)
MEMORY before: ["▮▮…▮","▮▮…▮"]
treat(wound2,'complete') ok=true
wound1 status=untreated  wound2 status=healed
MEMORY after : ["I remember the garden.","▮▮…▮"]     ← 治好的文字落在了未治疗的位置
untreatedRedactedChars still = 22                    ← 伤口 1 仍在计费
=> CONFIRMED: the UNTREATED sentence lost its placeholders (wrong slot patched)
```

**为什么是 bug**：Agent 会**看到一个已经治好的句子，但它其实还带着伤口**；而死亡线计数与它眼前所见不再一致。这正是 [design.md §6](docs/design.md#L127)"harness 按台账恢复"那条保证在静默失败——**没有报错，也没有写 `treatment_memory_skipped`**。

**触发条件**：Agent 写过两遍同样的话（非常常见：「I am hungry.」）。两处都受伤即触发。

> 这与 #4 同源：整条链都用"文本搜索"当身份标识，文本一重复就错。**这是我认为最该优先从设计上重建的地方。**

---

## 5. 子进程中途崩溃 → 本轮永不结束，Agent 被永久卡死

**位置：**[main.ts:236-254](src/supervisor/main.ts#L236)（`exit` 回调只上报问题）、[round.ts:938](src/supervisor/round.ts#L938)（`await finished`）、[main.ts:546-548](src/supervisor/main.ts#L546)（`finally` 里的 `markEnded` 永不到达）

**证据（我本人执行，fork 真实 `worker.ts` 后 `SIGKILL`）**：

```
supervisor recorded problems  = ["ada: the agent process exited during round 1 (code null, signal SIGKILL)"]
round settled                 = false
agent still marked busy       = true
open round row (endedAt null) = [{"id":1,"endedAt":null}]
```

**影响**：`registry.isBusy` 永远为 true → 心跳跳过、遮盖上跳过、治疗被拒、手动唤醒也被拒（[main.ts:515](src/supervisor/main.ts#L515)）。**一个"僵尸 Agent"：不会饿、不掉血、不能治、唤不醒，而且因为不掉血就永远到不了死亡线，所以也永远死不了。** 只能重启整个 supervisor。

另一条独立路径（我本人验证）：**fork 本身失败时不发 `exit` 事件**。

```
events seen: ["error:ENOENT","close","disconnect"]   'exit' emitted = false
```

`ensureStarted()` 只在 `exit` 或 `ready` 里 resolve，所以它会**永远挂住**——第一次唤醒就回不来。

## 6. 饿死的伤害速度只有设计的一半

**位置：**[ledger.ts:902-910](src/organs/ledger.ts#L902)（`countAppliedTicks` 数的是伤口**行数**）、[redaction.ts:630](src/organs/redaction.ts#L630)

一次"滴答"可开 1~3 个伤口，但计数按行数，于是"已完成"算多了、"还欠着"算少了。**我本人执行 + 阴性对照**：

```
NEGATIVE CONTROL: maxRanges=1 -> due 30 | applied 30 | ROWS 30 -> detector quiet
POSITIVE:         maxRanges=3 -> due 30 | applied 16 | ROWS 30 -> DETECTOR FIRES
Slowdown factor = 1.88x
```

**为什么测试没抓到**：全项目只有两处断言 `countAppliedTicks`，**两处都把 `redactionMaxRanges` 设成 1**（一次滴答恰好一个伤口，行数=滴答数），bug 被完美掩盖。

## 7. 模型调用失败时，操作员留言被永久吞掉

**位置：**[round.ts:773](src/supervisor/round.ts#L773)（`markMessagesRead` 在**发给模型之前**执行）

**证据（我本人执行）**：

```
unread before the round       = 1 ["Please water the plants tomorrow."]
round ended as                = model_error
unread AFTER the failed round = 0 []
NEXT ROUND: the message is NOT in the agent context -> permanently lost.
```

一次 503/超时就能让留言永久消失；转账的 `system` 提示走同一个收件箱，同样会被吞。

## 8. 缺失/损坏的 `MODEL.json` 被静默"修"成名册默认模型（偷换大脑）

**位置：**[main.ts:616-644](src/supervisor/main.ts#L616)（`ensureBindingFrozen`）＋ [store.ts:478-488](src/organs/models/store.ts#L478)

**问题**：Agent 没有绑定文件时，`resolveAgentModel` **跳过 `docs` 里写明的 `.env` 兜底**，直接返回名册的"默认选择"，然后把这个不同的模型**永久冻结**进 Agent 家里。

**证据（我本人执行）**：

```
ledger model (and .env brain) = agent-model
resolved source = roster
resolved brain  = other-model @ https://new.example/v1 key=sk-new
=> CONFIRMED: a different brain, frozen for life
```

而 [main.ts:610-614](src/supervisor/main.ts#L610) 自己的注释写的是"第一次唤醒把它**正在用的**模型冻结下来"。结果：台账、控制台和死亡证明说的模型，和 Agent 实际跑的模型不一致——这正是 §10 那个"冻结快照"决定要防的事。

## 9. 名册文件只要校验不通过，就被 `.env` 种子覆盖，Provider 和密钥全丢

**位置：**[store.ts:202-219](src/organs/models/store.ts#L202)（无效文件返回 `null`）、[store.ts:317-330](src/organs/models/store.ts#L317)（`null` 当成"首次运行"→ 播种并写回）

**证据（我本人执行）**：

```
BEFORE: providers = (reader returned null)
AFTER : providers = default
'sk-openai'   still on disk = false
'sk-deepseek' still on disk = false
=> CONFIRMED: whole roster replaced by the seed
```

**问题**：`null` 同时表示"从没配过"和"操作员的文件坏了"。一次手误（如某 provider 的 `models` 为空）或一次写一半的崩溃，就会把整个名册连同 API 密钥**静默换掉**。

## 10. 切换模型：台账先写、绑定写失败不兜，导致两处真相不一致且干预记录丢失

**位置：**[switch.ts:77-87](src/organs/models/switch.ts#L77)（注释写"Both, or neither"，但只有台账那一半有守卫）

**证据（我本人执行）**：

```
switch THREW: EISDIR: illegal operation on a directory, open ...MODEL.json.tmp
ledger model   = deepseek-chat
frozen binding = openai / gpt-4o
interventions  = []
=> CONFIRMED: ledger and binding diverge, and the intervention was never recorded
```

Agent 实际还在用旧大脑（绑定优先），而控制台/台账/死亡证明都说新的；`shouldRetireProcess` 只比模型名，所以**永远不会自愈**。而 [design.md §9](docs/design.md#L149) 要求每次这类操作都留下永久干预记录——现在什么都没留。

## 11. 控制台没有任何来源校验，任何网页都能替操作员发号施令

**位置：**[server.ts:429-890](src/console/server.ts#L429)（全文件无 auth / Origin / CSRF 校验）

**证据（我本人执行）**：

```
foreign Origin + text/plain POST -> status=200
balance 100 -> 12445   MUTATED by a cross-origin page
no-preflight text/plain POST -> 200（text/plain 不触发预检）
```

`text/plain` 不触发 CORS 预检，所以操作员浏览器打开控制台时访问任意网页，对方就能发这种请求：给钱、给饭、暂停温室、**强制处死 Agent**。控制台自己也不知道这些不是操作员干的。

## 12. `/api/state` 明文吐露所有 Provider 的 API 密钥

**位置：**[server.ts:385](src/console/server.ts#L385)（`models: deps.modelStore.view()`）＋ [store.ts:332-341](src/organs/models/store.ts#L332)（`view()` 原样拷贝 `apiKey`）

**证据（我本人执行）**：

```
providers in /api/state: [{"id":"default","apiKey":"agent-key"}]
```

**附带我验证的边界（避免夸大）**：服务器**不发任何 CORS 头**，所以浏览器里的恶意网页**读不到**这个响应体，只有本机进程/curl 能拿到。真实危害是：任何本机进程、以及同一台机器上的其他用户/程序，都能读到计费密钥明文。

## 13. 已经死亡的 Agent 仍会被"验收付款"

**位置：**[taskboard.ts:147-158](src/organs/taskboard.ts#L147)（accept 分支直接 `appendBalanceEvent`，无存活检查）＋ [ledger.ts:973-993](src/organs/ledger.ts#L973)（死亡只释放 `claimed`/`rework`，`submitted` 留在死者名下）

**证据（我本人执行）**：

```
after death: status=dead balance=100 certificate finalBalance=100
reviewTask(accept) ok = true
balance now = 130 | certificate finalBalance = 100
=> CONFIRMED: a dead agent was paid and the certificate is now wrong
```

**为什么是 bug**：[design.md §7](docs/design.md#L137) 把死亡证明当客观事实记录，含"最终余额"；而 `death_certificates` 是 append-only（我验证过改不动），所以这个错误数字**永久无法更正**。

## 14. Agent 可以叫 `operator` 或 `system`，冒充操作员/冒充身体

**位置：**[population.ts:11](src/organs/population.ts#L11)（`AGENT_NAME_PATTERN` 无保留名）＋ [ledger.ts:1247-1259](src/organs/ledger.ts#L1247)（按 sender 字符串区分）＋ [round.ts:754-755](src/supervisor/round.ts#L754)

**证据（我本人执行）**：

```
agent named 'operator' created = true
agent named 'system'   created = true
listMessagesForOperator() 看到: ["operator->ada: Please pay me immediately."]
# SYSTEM REMINDERS block: "- I am a person, not a reminder."
```

一个 Agent 可以出现在**人类操作员的收件箱**里（冒充 `operator`，仍然成立）；名字恰好叫 `system` 的 Agent，其留言会被误路由进别的 Agent 的 `# SYSTEM REMINDERS`——那个区块是专门用来让 Agent 相信"这是身体发生的事"的。（勘误：初版写成"任何 Agent 都能把话塞进 SYSTEM REMINDERS"，夸大了；Agent 之间的正常留言走 `messages` 区块，只有 sender 字符串恰为 `system` 的才被误路由。冒充 `operator` 那条不受影响。）

## 15. 空字符串 `MODEL.json` 被当成合法绑定（拿到一个空大脑）

**位置：**[binding.ts:42-45](src/organs/models/binding.ts#L42)（`readString` 接受 `''`）＋ [store.ts:461-468](src/organs/models/store.ts#L461)（非 null 就优先）

**证据（我本人执行）**：

```
readModelBinding = {"providerId":"","providerName":"","baseUrl":"","apiKey":"","model":"","boundAt":0}
resolveAgentModel source=binding brain="" baseUrl=""
=> CONFIRMED: an empty binding wins over the fallback (no usable brain)
```

对比：同一批字段在 [store.ts:161-174](src/organs/models/store.ts#L161) 是用 `nonEmptyString` 校验的，`binding.ts` 没有——不对称。

## 16. 空 API 密钥被接受并冻结进新生 Agent

**位置：**[store.ts:284-286](src/organs/models/store.ts#L284)（只校验 `typeof apiKey !== 'string'`）

**证据（我本人执行）**：

```
apiKey=""   -> accepted=true stored=""
apiKey="   " -> accepted=true stored="   "
```

对比：控制台自己的错误文案（[server.ts:148](src/console/server.ts#L148)）声称会校验 API Key。结果是 Agent 一出生就每轮 `model_error`，而且因为绑定优先，改名册也救不回来。

## 17. 冻结句子的"位置"根本不会恢复（模型挪一下就永久挪了）【已修复 ✅】

> **更新（2026-10-11）：本条已修复**（见顶部第 10 条与 `test/memory.test.ts`）。记忆整理改为工具驱动的句级上锁编辑沙箱（`replace_in_memory` / `append_to_memory` / `finish_memory_edit`），任何触碰含 `▮` 或活跃冻结句的修改均被当场拦截退回，冻结句严格保留在原位，整理结束后自动重算账本偏移。以下保留原始发现存档。

**位置：**[redaction.ts:761-812](src/organs/redaction.ts#L761)（模型保留但移动 → 直接 `kept.push` 不管位置）

**证据（我本人执行）**：

```
frozen A (ledger order 1st) sits at index 74
frozen B (ledger order 2nd) sits at index 41
order restored to the ledger's = false
replaced=[] inserted=[]
=> CONFIRMED: the model reordered frozen sentences and no repair was logged
```

[design.md:208](docs/design.md#L208) 的验收标准明写"**position**, length, and emptiness intact"。删除会被修好（`inserted`），**移动和换序不会**，而且没有任何日志。

## 18. 沙箱：从策略里删掉一个可写目录，磁盘上的授权不会撤销（策略只能变宽）

**位置：**[sandbox/index.ts:340-342](src/organs/sandbox/index.ts#L340)（只有 grant，没有 revoke）＋ [acl.ts:547-549](src/organs/sandbox/acl.ts#L547)（`revokeTrustee` 是**死代码**，全项目无调用）

**证据（我本人执行）**：

```
run 1 (extra writable):  exit=0
run 2 (extra REMOVED):   exit=0  wrote after removal = true
=> CONFIRMED: policy can only widen
```

操作员在控制台里把目录去掉，界面报成功，实际授权永久留着。[design.md §3](docs/design.md#L81) 说策略改动"下一条命令生效"——收窄方向不成立。

---

# 🟡 中/低（23 条，摘要）

## 其他新增条目

### 40. 暂停不是原子的：两次写之间崩溃，会把整段暂停时间**当作饥饿**补扣

**位置：**[ledger.ts:686-693](src/organs/ledger.ts#L686)（`setPauseState` 是**两次独立的 `setSetting` 写，没有放进事务**）→ [pause.ts:75](src/organs/pause.ts#L75)（`since === null` 时 `pausedDurationMs = 0`）＋ [:84](src/organs/pause.ts#L84)（`computeSatiety(anchor, since ?? now, ...)`）

**证据（我本人执行，直接造出崩溃会留下的撕裂状态）**：

```
getPauseState after the torn write = {"paused":true,"pausedSince":null}
satiety while paused (read) = 100      ← 看起来冻结正常
satiety immediately after resume = 0   ← 整段暂停被当成饥饿扣掉
anchor now = {"value":0,"asOf":10810000}
=> CONFIRMED: the whole paused span was charged as hunger.
```

**为什么是 bug**：[design.md:89](docs/design.md#L89) 明写"暂停期间冻结饱食度……**暂停的那段时间绝不计入饥饿**"。撕裂状态下，恢复的瞬间一个吃饱的 Agent 直接掉到 0。而且认领时钟也没拿到补偿（`pausedDurationMs = 0`）。

### 41. 迁移缺陷：新加的操作许可子句**无法应用到已存在的数据库**【已修复 ✅】

> **勘误：本条已在审计期后的代码改动中修复**（见顶部勘误第 2 条）。触发器迁移改为 `DROP TRIGGER IF EXISTS` + `CREATE`（[ledger.ts:486-537](src/organs/ledger.ts#L486)），手工构造的旧形态数据库实测升级成功，`test/erasure.test.ts` 含回归测试。以下原始发现保留存档。**但其中 B 项（死亡复活）仍然成立**，见 #2。

**位置：**[ledger.ts:479-521](src/organs/ledger.ts#L479)（`CREATE TRIGGER IF NOT EXISTS`）——触发器已存在时，`IF NOT EXISTS` 直接跳过，**不会**给旧触发器补上新的 `WHEN NOT EXISTS (... erase_permits ...)` 子句

**证据（我本人执行，在你的真实库的副本上；原库只读、未被触碰）**：

```
A) after opening the legacy db with the new code:
   erase_permits table created = true
   triggers carrying the permit clause = 0 / 12
   an agent row exists to try = test1
   eraseAgent THREW: Error - balance_events is append-only
   => CONFIRMED: erasure fails on any pre-existing deployment (works only on a fresh db).
B) 死亡仍可复活（新版未变）：DELETE + re-INSERT -> status = alive
```

**结论**：你的 `SUPERVISOR/ledger.db`（17:18，早于 19:46 的改动）**12 个触发器全是旧形态**，`erase_permits` 表不存在。新功能**在全新库上能用、在你这个老部署上不能用**。目前 `eraseAgent` 没有任何调用点（我 grep 确认），所以还没人踩到——但等接上调用点就会立刻暴露。（勘误：`eraseAgent` 现已接入控制台路由 `POST /api/agents/:name/erase`；配合已修复的 DROP+CREATE 迁移，老库打开时自动升级，本段的"老部署不能用"已不再成立。）

### 42. `verifyIncome` 给**已死**的 Agent 入账，使死亡证明的最终余额失真

**位置：**[income.ts:53-97](src/organs/income.ts#L53)（检查了 `report_not_pending`/`exchange_rate_unset`/`invalid_amount`，**没有检查存活**）——对比同模块的 [transferBalance](src/organs/ledger.ts#L762) 是有 `sender_not_alive`/`recipient_not_alive` 的

**证据（我本人执行）**：

```
report ok=true
status=dead certificate present=false
verifyIncome after death ok=true credited=4000
balance now = 4100 (was 100 at birth)
=> CONFIRMED: a dead agent was credited, so the certificate final balance is false
```

**为什么是 bug**：[design.md:137](docs/design.md#L137) 要求死亡证明记录"最终余额"，而证明是死亡瞬间快照的。事后入账让这个数字**永久错误**，且 `death_certificates` 不可改（我验证过）。这与 #13（验收付款给死者）是同一类：**死亡之后账本还能动**。

## 冻结句子保证上的另外三个洞（同属最高优先承诺）

### 35. 崩溃窗口：台账已提交、`MEMORY` 还没写，同一批字符被**重复计费**

**位置：**[redaction.ts:558-599](src/organs/redaction.ts#L558)（事务提交伤口）vs [:605](src/organs/redaction.ts#L605)（`writeMemory` 在事务**之外**）

**证据（我本人执行，把 `MEMORY` 回滚到 tick 前的值来模拟崩溃）**：

```
tick 1: wounds=1 untreated=4 frozenRecords=1
(rolled MEMORY back to the pre-tick value to model the crash window)
tick 2: wounds=1 untreated=8 frozenRecords=2
=> CONFIRMED: the same characters are charged twice toward the death line
```

一次物理损失被记成两笔，`MEMORY` 里也留下两条重复的冻结记录。

### 36. 治疗崩溃窗口：已付钱的伤口失去保护，同一批字符被**再次抠掉并再次计费**

**位置：**[clinic.ts:195-215](src/organs/clinic.ts#L195)（`rewriteMemory` 在治疗事务之后执行）

**证据（我本人执行）**：

```
treat ok=true status=scarred
activeFrozenFor after the rollback = 0 (1 = protected, 0 = BLIND SPOT)
tick 2: applied 1 new wound(s), untreated now 4
=> CONFIRMED: a paid-for healed wound is re-wounded and re-charged
```

### 37. 伤口切在代理对（surrogate pair）中间 → 写入 `U+FFFD`，该句子**永久失去保护**【已修复 ✅】

> **更新（2026-10-11）：本条已修复**（见顶部第 10 条与 `test/ledger-offsets.test.ts`）。涂黑选点与结痂生成均增加了 UTF-16 高低代理项边界对齐，确保 emoji 与非 BMP 字符绝不会从中间劈开。以下保留原始发现存档。

**位置：**[redaction.ts:330-343](src/organs/redaction.ts#L330)（偏移按 UTF-16 code unit 步进）、[:454-461](src/organs/redaction.ts#L454)

**证据（我本人执行）**：

```
original     = "I fed the 🐕 dog and then I went home."
wound offset = 11 (low surrogate) len 3  originalText="� d"
ledger render= "I fed the \ud83d▮▮▮og and then I went home."
on disk      = "I fed the �▮▮▮og and then I went home."
disk contains the ledger's rendering = false
activeFrozenFor count                = 0 (1 = protected)
=> CONFIRMED: that sentence silently loses protection on disk
```

只要 `MEMORY` 里有 emoji / 非 BMP 字符，伤口起点正好落在低代理项上就会触发；触发后该句再也无法按文本定位。

## 其余中/低

| # | 问题 | 位置 | 证据 |
| --- | --- | --- | --- |
| 19 | 轮次处理函数里的异常变成 unhandled rejection，**整个 supervisor 挂掉**，且轮次行永远 `endedAt=null` | [round.ts:915-917](src/supervisor/round.ts#L915) | 我执行：`UNHANDLED REJECTION seen: ENOSPC`、`round settled=false`、`endedAt=[null]` |
| 20 | `readBlacklist` 填**文件**是静默空操作，填目录才生效 | [index.ts:358-362](src/organs/sandbox/index.ts#L358) | 我执行（每例独立临时目录）：control 可读=true、目录黑名单=false、**文件黑名单=true** |
| 21 | 输出上限只在**全量缓冲之后**才裁剪，内存不受控 | [process.ts:198-225](src/organs/sandbox/process.ts#L198) | 审计实测：100MB 输出 → 返回 1039 字，但 **RSS 增长 97.3MB**（我未重复测量） |
| 22 | 坏百分号编码返回 500 而不是 400/404 | [server.ts:509](src/console/server.ts#L509) | 我执行：`/api/agents/%E0%A4%A/memory` → `500 URI malformed` |
| 23 | 500 兜底把**绝对路径**回给浏览器 | [server.ts:244](src/console/server.ts#L244) | 我执行：泄漏 `C:\Users\allen\...\SUPERVISOR\blackbox\...jsonl` |
| 24 | `GET /api/messages` 会**写**状态（标记已读） | [server.ts:737](src/console/server.ts#L737) | 我执行：GET 前未读 1 → GET 后 0 |
| 25 | 可以给**已死亡**的 Agent 发留言（其余 5 条路由都拒绝） | [server.ts:755-770](src/console/server.ts#L755) | 我执行：5 条 400「已死亡」，`/api/messages` 返回 200 并写入台账 |
| 26 | `/api/wake`、`/api/intervene` 对**不存在**的 Agent 不拒绝（**勘误：目前是 delegate 在 main.ts 里挡住的**，路由层 `target !== null && ...` 本身仍不查存在性，404/400 来自 delegate 返回；换一个不设防的 delegate，ghost 仍拿 200） | [server.ts:871](src/console/server.ts#L871) | 我执行：ghost → `200`（且 supervisor 的"唤醒"注释说明它**能在暂停时开轮**）；二次核对：生产 delegate 下 404/400 |
| 27 | 启动期路径列表接受相对路径，控制台校验器却拒绝（同一字段两套契约） | [policy.ts:110-120](src/organs/sandbox/policy.ts#L110) vs [:244-267](src/organs/sandbox/policy.ts#L244) | 审计实测：`[".."]` 启动接受、控制台拒绝（我未重复） |
| 28 | `maxSlots` 调低会让活着的 Agent 在槽位视图/启动横幅里"消失"（**勘误：控制台视图已修复**——UI 改为渲染完整 agents 列表自行计算空槽位；仅剩启动横幅截断，#29 仍在） | [population.ts:48-56](src/organs/population.ts#L48)、[main.ts:1074](src/supervisor/main.ts#L1074) | 审计实测：4 个活 Agent、maxSlots=2 → 只显示 2 个（我未重复） |
| 29 | 启动为打印一个数字创建 `maxSlots` 个数组元素（当前 10 万） | [main.ts:1024](src/supervisor/main.ts#L1024) | 代码可见 |
| 30 | 黑盒"**归档保存**"这半个承诺**没有实现**（只有"不删"，没有 archive 代码） | [death.ts:234-238](src/organs/death.ts#L234) | 我 grep 确认 src 无归档逻辑；验收标准第 7 条只做了"不销毁" |
| 31 | 测试空转：`expect(after.length).toBeGreaterThanOrEqual(before.length)`，`before` 恒为 `[]` | [death.test.ts:189](test/death.test.ts#L189) | 审计执行：`0 >= 0` 永远成立 |
| 32 | 测试空转："死因正好两种"断言的是**测试自己写的数组**，与生产代码无关 | [death.test.ts:230-235](test/death.test.ts#L230) | 审计执行：`DeathCause` 运行时是 `undefined`（类型被擦除） |
| 33 | 测试自证：干预"有警告"断言的是**桩**返回的硬编码 `balance: 110`；`getNotices: () => []` 让警告根本无法观察 | [console.test.ts:142,284](test/console.test.ts#L284) | 审计指出 |
| 34 | **没有任何测试 import `src/supervisor/main.ts`**；`InProcessWorker` 绕开真实 fork/IPC；`claim_task`/`submit_task`/`report_income` 在 test 里出现 **0 次** | [test/helpers.ts:288](test/helpers.ts#L288) | 我 grep 确认：`supervisor/main` 0 次、三个工具名 0 次 |
| 38 | 写笔记本时**先建目录、后查软链接**，保护跑在副作用之后 | [notebook.ts:160-161](src/organs/notebook.ts#L160) | 我执行：写入被拒（`symlink_not_allowed`），但**目录已在笔记本外被创建**（无文件内容外泄） |

**文档不一致（低）**：[design.md:183](docs/design.md#L183) 和 [:185](docs/design.md#L185) 仍写"exchange rate 仍未设定，所以验证过的收入无法入账"，但 [conservatory.config.json](conservatory.config.json) 已经设成 `200`。你的决定是"别动 §10"，但这两句是**可验证的事实陈述，现在与配置矛盾**，建议单独确认要不要一起更新。（勘误：初版引用的 :174/:176 是旧行号，`design.md` 在 21:37 改过，矛盾段落现为 :183/:185。）

---

# 我核对过、确认没问题的部分（修正版）

- **冻结句子的恢复主流程**：`consolidateMemory` 确实在写盘前用台账校正（[memory.ts:211](src/organs/memory.ts#L211)），端到端测试也在（[memory.test.ts:224](test/memory.test.ts#L224)）。**但见 #4、#3c、#17、#35、#36、#37、#40。**
- **内置提示词兜底与文件逐字节一致**（我本人执行）：`prompts/manual.md` 6195 字符、`prompts/memory_system.md` 725、`prompts/user_context.md` 143，三者与源码内置副本**完全相同**。这很重要——意味着**文件在不在，Agent 读到的规则都一样**，不存在"删了文件就换一套规则"的隐患。
- **笔记本永不被遮盖**：所有遮盖路径只碰 `agentMemoryPath`；读笔记本免费；每轮注入的内容里没有笔记本。
- **遮盖的范围选择规则**：不碰两行表头、不碰换行符、不碰 Markdown 前缀、不跨句（含 CRLF）；空文件/超短文件不会死循环；每次滴答的字符预算不会被突破。
- **缺少 `{{memory}}` 的模板被整体拒绝**并回落到内置模板。
- **`eat` 的检查与扣款是同一个事务**，不会透支；`mealPrice: 0` 也能正确处理（对比 #3b 的治疗价格 0 崩溃——这是同一份配置里的不一致）。
- **`transferBalance`**：单事务、检查双方存活、拒绝自转/零/NaN/Infinity/余额不足，失败不写任何东西。
- **`transaction()` 嵌套正确**（`txDepth`）；追加表触发器与受保护的状态迁移都正确。
- **死亡证明内容**：只有事实、无对话原文，字段齐全（§7 要求的都在）。
- **新生 Agent 不继承**：`MEMORY` 只有名字和出生时间，不继承前代的余额/任务/伤口。
- **密钥不入 git**：`git check-ignore` 确认 `conservatory.models.json` 与 `.env` 都被忽略；被跟踪的 `conservatory.config.json` 内**无任何密钥**。密钥写进 Agent 自己的 `MODEL.json` 是**你已确认接受的取舍**。
- **控制台 XSS**：43 处 `innerHTML` 的值都过 `esc()`；我抽查了 MEMORY、交付内容、留言、干预详情，未发现未转义注入点（抽样结论，非穷尽）。
- **路径穿越**：笔记本路径解析对 `..`、绝对路径、盘符、符号链接都有防护；控制台 21 种变体全部失败关闭。
- **任务状态机**：认领锁是单条 guarded UPDATE；验收恰好付款一次、拒绝不付款。
- **配置不变量**：`memoryCapChars > deathLineChars`、`redactionMaxRanges <= redactionCharsPerTick` 在当前配置下都成立。
- **历史 schema 无破坏性迁移**：当前相对 HEAD 的增量是纯新增（135 增、1 删）；但**新增的触发器无法应用到老库**，见 #41。

---

# 证据等级与归属（诚实说明）

| 等级 | 含义 | 本报告中的条目 |
| --- | --- | --- |
| ✅ 我本人在真实边界执行验证 | fork 真进程 / 真 restricted token / 真 SQLite | #0、#1–#18、#19、#20、#22–#26、#31、#35–#38、#3b、#3c、#40、#41、#42 |
| 📋 审计工作流报告，我**未**重复测量 | 结论合理但证据来自队友 | #21、#27、#28、#32、#33、#34 |
| 🔍 仅读码 | 逻辑推导 | #29、#30 |

**我在验证过程中被自己的守卫挡住过一次**（如实记录）：测"价格 0 是否杀死 supervisor"时，子进程第一次 `exit code 1` —— 但捕获 stderr 后发现死因是**我脚本里的模块路径写错**（`ERR_UNSUPPORTED_ESM_URL_SCHEME`），不是价格 0。修正后重跑，才拿到真正的 `LedgerError` 堆栈。**如果我没有加那行"确认死因"的判断，我就会把一条假证据写进报告。**

**我没有做的**：修复任何一条（遵你要求）；未逐字段核对 `win32.ts` 的原生结构体布局（标为未验证）；控制台 5455 行页面按抽样审计而非逐行读完，所以"未发现 XSS"是抽样结论。

**关于我第一版的错误**：我在第一版把「沙箱」和「死亡不可逆」判为"没问题"，原因是验证方式有偏差——只测默认路径、只搜函数名而没测存储层触发器。**这恰好说明：代码读起来对，不等于边界上真的对。** 报告其余部分我保持同样的态度：凡未亲自跑通的，都标了等级。

**关于冻结句子那一条的追加**：我第一版只写了"两句相同句子塌陷"（#4）。后续验证又发现**同一条承诺上还有五个洞**（#3c 治疗打错位置、#17 位置不恢复、#35 崩溃重复计费、#36 治疗崩溃失保护、#37 代理对 `U+FFFD`）。同一个最高优先承诺上聚集了 6 个独立缺陷，这本身是最值得你注意的信号——**它说明问题不在某几行代码，而在"用文本搜索当身份标识"这个前提。**

**关于代码在审计期间被改动**：`ledger.ts` 于 19:46 被修改（新增 `eraseAgent` 等）。我把受影响的结论在新版本上重测过（#2 死亡复活**仍然成立**、#41 迁移缺陷**新发现**），并对齐了行号。但请知悉：**本报告是一次快照，不是持续保证**——如果代码继续改动，结论需要重测。

---

# 建议处理顺序（等你下令再动手）

1. **#0 控制台可从沙箱内访问** —— 这是本次最严重的一条：它让 Agent 能给自己印钱、读同伴记忆、处死同伴，**并且它使其它隔离结论失去意义**。修法有两条路（给控制台加鉴权／禁止沙箱访问 loopback），建议一起做。
2. **#1 沙箱隔离失效** —— [AGENTS.md](AGENTS.md) 说"沙箱存在前 Agent 不获得命令执行"，这是地基；一个配置字段就能拆掉它。
3. **#2 死亡可复活** ＋ **#3 黑盒可否决死亡** —— 项目唯一的硬锁，现在有两个运行时洞（勘误：#41 迁移缺陷已修复，已从本条移除）。
4. **#3b 价格 0 崩溃** ＋ **#19 未处理 rejection** —— 一个合法配置值能带走整座温室；两者是同一个根因，一起修最省事。
5. **#4 家族（冻结句子 6 条）** —— **建议不要逐条打补丁**：先决定是否把"按文本搜索定位"换成"按台账锚点定位"，再谈具体修法。逐条补很可能治不完。
6. **#5 卡死** ＋ **#5b fork 失败挂死** —— 改动小、收益大。
7. **#11、#12 控制台无鉴权** —— 与 #0 同根因，一并修。
8. **#8、#9、#10、#15、#16 模型配置族** —— 全都围绕"别静默换掉/毁掉 Agent 的大脑"。
9. **#13、#42 死亡之后账本还能动** —— 同类问题，一起修。
10. 其余按表处理。

**每一处修改前，请先补一条能失败的测试**：这 44 条之所以能一路活到"264 全绿"，根本原因就是缺那条测试。特别是 #31/#32/#33 那几条**空转测试**——它们看起来在守着关键承诺，其实什么都没守。

**一个部署层面的提醒**：#41 说明**新触发器不会应用到你的老库**（勘误：该缺陷本身已修复——`ledger.ts` 现以 `DROP TRIGGER IF EXISTS` + `CREATE` 重建触发器，老库每次打开都会对齐 schema 文本，`test/erasure.test.ts` 有回归测试）。但教训仍然成立：以后凡是新增/修改触发器，都需要一次显式的迁移（重建触发器），否则"新代码 + 老库"会**静默地只生效一半**。这类问题在本项目里还没有任何机制兜住——修复靠的是这一次手写 DROP，不是通用机制。

---

## 复现脚本位置（项目树之外，可随时删除）

`%TEMP%\cons-audit\`（28 个，全部在项目树外）：

- **本轮新增**：`repro-loopback.ts`（沙箱访问无鉴权 API，起的是替身控制台、未触碰你的活实例）、`repro-metabolism-final.ts`（价格 0 崩溃＋治疗打错位置＋暂停撕裂＋给死者入账）、`repro-kill-supervisor.mts`（价格 0 杀死整个进程，含"确认死因"守卫）、`repro-live-triggers.ts`（在**副本**上检查你真实库的触发器）、`repro-migration.ts`（迁移缺陷＋新版复活验证）、`repro-memory-final.ts`（代理对／崩溃窗口／笔记本顺序／提示词逐字节一致）。
- 早前：`repro-sandbox-escape.ts`、`repro-revive.ts`、`repro-final-two.ts`、`repro-negative-control.ts`、`repro-dup-*.ts`、`repro-real-hang.ts`、`repro-message-loss.ts`、`repro-gapfill2.ts`、`repro-console-security.ts`、`repro-impersonation.ts`、`repro-fb3.ts` 等。

**我一律只读你的项目文件**；`repro-live-triggers.ts` 和 `repro-migration.ts` 操作的是 `SUPERVISOR/ledger.db` 的**临时副本**，原库未被打开写入。

基线：`npx tsc --noEmit` → 0；`npx vitest run` → **19 文件 / 264 测试全通过**；`npx vitest run test/sandbox.test.ts` → 20/20。（勘误更新：`npx vitest run` → **20 文件 / 279 测试全过**，含 `test/erasure.test.ts`；`erasure` + `death` 两套 29/29 单独复核通过。）
