# 温室（Conservatory）软件设计与日常使用体验审计及分阶段改造计划

本文档记录了对整个项目（后端器官、模型调用层、监督器与操作员控制台）的软件设计与日常使用体验全面审计结果。

---

## 0. 审计范围与排除说明

- **纳入改造（共 11 项）**：涵盖模型与思考努力等级、记忆模型配置生效、模型连通性测试、模型设置面板防丢数据、系统经济参数在线修改、运行中生命动态实时查看、任务板与收入核验闭环、以及记忆伤口导航与点击修复。
- **明确排除（原第 12 项：`notebook/` 网页文件查看器）**：
  - **原因**：按照温室的核心设计，每个 Agent 拥有自己独立的 `AGENTS/<name>/notebook/` 文件夹，并可在其中自由创建、修改、删除任意数量和层级的文件，甚至通过命令生成二进制文件、图片、数据库或压缩包。因此 `notebook/` 不是单一文本文件，格式也完全不确定，不适合在网页控制台里做固定格式的笔记本查看页。

---

## 1. 确认修复的 11 项设计与体验问题

### 第一部分：模型与思考能力（核心链路）

#### 问题 1：不支持选择「思考努力等级」（Reasoning Effort），且丢弃模型的思考过程
- **涉及位置**：
  - [`src/config.ts`](file:///g:/Conservatory-new/src/config.ts#L46-L50)（`ModelSettings`）
  - [`src/organs/models/store.ts`](file:///g:/Conservatory-new/src/organs/models/store.ts#L29-L50)（`ModelsConfigData`、`ModelSelection`）
  - [`src/organs/models/binding.ts`](file:///g:/Conservatory-new/src/organs/models/binding.ts#L21-L29)（`AgentModelBinding` / `MODEL.json`）
  - [`src/agent/ipc.ts`](file:///g:/Conservatory-new/src/agent/ipc.ts#L19-L24) & [`src/agent/worker.ts`](file:///g:/Conservatory-new/src/agent/worker.ts#L304-L331)
  - [`src/model/client.ts`](file:///g:/Conservatory-new/src/model/client.ts#L110-L147)（`OpenAICompatibleClient`）
  - [`src/console/server.ts`](file:///g:/Conservatory-new/src/console/server.ts) & [`src/console/public/index.html`](file:///g:/Conservatory-new/src/console/public/index.html)
- **现状痛点**：
  1. 整个模型配置与请求链路只有 `baseUrl`、`apiKey`、`model` 三个字段，无法设置思考努力等级（`reasoning_effort`）。
  2. 推理模型返回的思考内容（`reasoning_content` / `reasoning`）在 [`src/model/client.ts:139-145`](file:///g:/Conservatory-new/src/model/client.ts#L139-L145) 被直接丢弃，黑匣子不记录，控制台「生命动态」也看不到模型的思考过程。
- **目标设计**：
  1. **在「选模型的地方」绑定思考努力等级**：提供商（Provider）下依然只存模型名称列表；在以下 4 个选模型的入口各增加一个「思考努力等级」下拉框（选项：**默认/不指定**、**低 `low`**、**中 `medium`**、**高 `high`**）：
     - 系统设置 → 模型设置 → **默认 Agent 模型**（`defaultAgentReasoningEffort`）
     - 系统设置 → 模型设置 → **默认 Memory 模型**（`defaultMemoryReasoningEffort`）
     - 温室槽位 → **新建 Agent** 时的模型选择区
     - Agent 详情页 → **身体**标签页 → 模型切换区
  2. **冻结进 `MODEL.json`**：新建 Agent 或切换 Agent 模型时，将所选的 `reasoningEffort`（`null | 'low' | 'medium' | 'high'`）一并写入 `AGENTS/<name>/MODEL.json` 快照。
  3. **请求透传与思考内容留存**：当 `reasoningEffort` 为 `'low' | 'medium' | 'high'` 时，`OpenAICompatibleClient` 在调用 `chat.completions.create` 时传入 `reasoning_effort`；同时提取响应中的 `reasoning_content`（或 `reasoning` 字符串），写入黑匣子 `assistant_message` 事件，并在控制台「生命动态」对话记录中以可折叠区块展示。

#### 问题 2：「默认 Memory 模型」在网页上改了却完全不生效（始终死绑启动时的 `.env`）
- **涉及位置**：
  - [`src/supervisor/main.ts:426-429, 457`](file:///g:/Conservatory-new/src/supervisor/main.ts#L426-L429)
  - [`src/supervisor/round.ts:154-160`](file:///g:/Conservatory-new/src/supervisor/round.ts#L154-L160)
  - [`src/organs/models/store.ts:231-248, 357-360`](file:///g:/Conservatory-new/src/organs/models/store.ts#L357-L360)
- **现状痛点**：
  - 网页「模型设置」里有「默认 Memory 模型」下拉框，保存后也会写进 `conservatory.models.json`；但 `src/supervisor/main.ts` 启动时直接用 `.env` 里的 `MEMORY_MODEL_*` 创建了一个固定不变的 `memoryModel` 实例传给 `RoundCoordinator`，全项目从未调用过 `modelStore.defaultMemorySelection()`。
- **目标设计**：
  - 记忆系统在每轮执行 `append` / `compact` 时，动态从 `modelStore.defaultMemorySelection()`（通过 `modelStore.settingsFor(...)` 解析，若未命中则回退到 `models.memory`）获取当前配置的提供商、模型名和思考努力等级来发起请求；在控制台修改默认 Memory 模型或思考努力等级后下一轮立即生效。

#### 问题 3：保存或切换模型前无法「测试模型连通性与用量支持」
- **涉及位置**：
  - [`src/console/server.ts`](file:///g:/Conservatory-new/src/console/server.ts)
  - [`src/console/public/index.html`](file:///g:/Conservatory-new/src/console/public/index.html)
- **现状痛点**：
  - 温室强制要求每次模型响应必须包含 `usage`（token 用量统计），否则整轮直接报错中断（`usage_missing`）。但操作员在配置提供商或选择模型、思考等级时，没有任何测试按钮，只有等 Agent 跑起来报错才知道接口不通、模型名不对、思考等级不支持或缺少 `usage`。
- **目标设计**：
  - 新增 `POST /api/models/test` 接口与前端「测试模型」按钮，用当前选中的提供商（或表单中正在填写的 `Base URL` + `API Key`）、模型名和思考努力等级发送一条极简测试请求，检查：① 接口响应是否成功；② 是否返回了有效的 `usage`（`prompt_tokens` / `completion_tokens`），并在界面直接显示中文测试结果与耗时。

#### 问题 4：运行中切换同名模型（不同提供商、不同密钥或不同思考等级）不会重启旧 Worker 进程
- **涉及位置**：
  - [`src/organs/models/reconcile.ts:18-39`](file:///g:/Conservatory-new/src/organs/models/reconcile.ts#L18-L39)
  - [`src/supervisor/main.ts:208, 219-221, 546-550, 651-665`](file:///g:/Conservatory-new/src/supervisor/main.ts#L651-L665)
- **现状痛点**：
  - `AgentProcess` 只记录了裸模型名字符串 `startedModel`（例如 `"deepseek-chat"`）。当 Agent 正在运行一轮时，操作员将它从「提供商 A 的 `deepseek-chat`」切到「提供商 B 的 `deepseek-chat`」，或者只改了思考努力等级 / API Key，本轮结束后 `retireProcessIfModelChanged` 发现模型名字没变，就不会关闭旧进程，导致下一轮继续沿用旧连接。
- **目标设计**：
  - 将进程绑定的模型标识升级为包含 `providerId`、`baseUrl`、`apiKey`、`model`、`reasoningEffort` 的完整指纹；任何一项变化都会在本轮结束后回收旧 Worker 进程，确保下一轮用新配置启动。

---

### 第二部分：「模型设置」面板与 Agent 模型切换交互

#### 问题 5：「模型设置」面板的「两步保存」陷阱与表单清空 Bug
- **涉及位置**：
  - [`src/console/public/index.html:3193-3563, 5212-5310`](file:///g:/Conservatory-new/src/console/public/index.html#L3193-L3563)
- **现状痛点**：
  1. **点「保存配置」直接清空正在填的提供商表单**：用户在上面填好了提供商名称、网址、Key、模型，没先点「添加提供商 / 保存修改」而是直接点底部的「保存配置」，`saveModels()` 会忽略表单输入并调用 `renderModels(true)` 把用户刚填的内容全部清空。
  2. **改了默认模型下拉框后点上面按钮会被重置**：`#modelsDefaultAgent` 和 `#modelsDefaultMemory` 没有 `change` 事件同步到 `modelsDraft`，只要触发一次 `renderModels()`（比如拉取模型、勾选模型、增删提供商），刚刚选好的默认模型下拉框就会跳回原值。
  3. **只点「添加提供商 / 保存修改 / 删除」却忘了点底部「保存配置」就关弹窗**：改动只留在前端内存草稿里，既没存进服务器，下次打开弹窗还显示假象。
- **目标设计**：
  1. 默认模型和思考等级下拉框在 `change` 时立即更新 `modelsDraft`。
  2. 点击底部「保存配置」时，如果检测到上方提供商表单里有正在填写或编辑但尚未合入列表的内容，自动尝试合入（若校验不通过则报错提示并保留表单内容，绝不清空）。
  3. 点击「添加提供商 / 保存修改」或「删除」时，显式高亮提示「尚有未保存的改动，请点击底部『保存配置』生效」（或直接自动保存到服务端），且在关闭弹窗 / 切换标签页时若存在未保存改动则弹出确认提醒；每次打开模型设置时重新与服务端同步。

#### 问题 6：Agent 详情页「身体」标签里的模型切换下拉框每 3 秒被自动刷新重置
- **涉及位置**：
  - [`src/console/public/index.html:4567-4684`](file:///g:/Conservatory-new/src/console/public/index.html#L4567-L4684)
  - [`src/console/server.ts:454-490`](file:///g:/Conservatory-new/src/console/server.ts#L454-L490)
- **现状痛点**：
  1. 控制台每 3 秒轮询一次 `/api/state` 并无条件重建「身体」面板的 HTML。操作员刚在下拉框里选好另一个提供商或模型，还没点「保存模型」，3 秒一到下拉框就被刷回旧值。
  2. `/api/state` 只返回了 `agent.model`（模型名），没返回 `MODEL.json` 里的 `providerId`、`providerName` 和 `reasoningEffort`，遇到两个提供商有同名模型时界面还会猜错提供商。
- **目标设计**：
  1. `/api/state` 直接返回每个 Agent 在 `MODEL.json` 中的 `providerId`、`providerName`、`model`、`reasoningEffort`。
  2. 「身体」面板在重绘时保留操作员尚未提交的下拉框选择状态（提供商、模型、思考努力等级），直到操作员点击「保存模型」或切换查看另一个 Agent。

#### 问题 7：当提供商在设置里被修改或删减模型名后，Agent 详情页「身体」面板对冻结快照的展示失真
- **涉及位置**：
  - [`src/console/server.ts:454-490`](file:///g:/Conservatory-new/src/console/server.ts#L454-L490)
  - [`src/console/public/index.html:4567-4623`](file:///g:/Conservatory-new/src/console/public/index.html#L4567-L4623)
- **现状痛点**：
  - 按照既定设计，Agent 出生时把模型信息（含网址与密钥）作为完整快照冻结在自己的 `MODEL.json` 里，之后去系统设置里怎么改提供商都不会偷偷影响已有的 Agent。
  - 但目前前端「身体」页渲染时并没有读取 `MODEL.json`，而是拿 `agent.model` 字符串去当前提供商菜单里反查：如果之后在设置里把这个模型名从提供商菜单里删了，或者两个提供商有同名模型，「身体」页就会显示错乱（甚至把下拉框跳到别的默认模型上，误导操作员以为它换了模型）。
- **目标设计**：
  - 严格保持 `MODEL.json` 完全独立、不受后续设置修改影响的原则；同时在「身体」面板清晰展示该 Agent 自己 `MODEL.json` 中冻结的真实提供商名称、模型名与思考努力等级（即使该模型名后来已从全局菜单中移除，也照常如实显示「当前冻结快照」，不会跳回错误的默认项）。

---

### 第三部分：系统经济与运行参数在线配置

#### 问题 8：「系统经济与指标」面板全是只读，连设个汇率都要手改文件并重启
- **涉及位置**：
  - [`src/config.ts:14-44, 179-242`](file:///g:/Conservatory-new/src/config.ts#L14-L44)
  - [`src/console/server.ts:500-515`](file:///g:/Conservatory-new/src/console/server.ts#L500-L515)
  - [`src/console/public/index.html:3995-4074`](file:///g:/Conservatory-new/src/console/public/index.html#L3995-L4074)
  - [`src/organs/heartbeat.ts`](file:///g:/Conservatory-new/src/organs/heartbeat.ts) & [`src/supervisor/main.ts`](file:///g:/Conservatory-new/src/supervisor/main.ts)
- **现状痛点**：
  1. 「系统设置 → 系统经济与指标」目前完全只读，连最常需要调整的 `exchangeRate`（外部收入汇率，默认为未设定 `null`）都要求手改 `conservatory.config.json` 并重启服务才能核验收入。
  2. `ConservatoryValues` 中有 6 个重要参数（`initialSatiety`、`initialBalance`、`maxToolCallsPerRound`、`modelRequestTimeoutSeconds`、`redactionMinRanges`、`redactionMaxRanges`）甚至没在界面上显示出来。
- **目标设计**：
  1. 在 `/api/state` 和「系统经济与指标」面板中完整展示并支持在线编辑全部运行参数（汇率 `exchangeRate`、饭钱 `mealPrice`、每餐饱食度 `satietyPerMeal`、代谢速率 `satietyDecayPerSecond`、普通/完全治疗价格、心跳间隔 `heartbeatSeconds`、模型请求超时 `modelRequestTimeoutSeconds`、单轮最大工具调用数 `maxToolCallsPerRound`、最大槽位数 `maxSlots`、出生饱食度/余额、删减参数等，仅 `consolePort` 提示重启生效）。
  2. 新增 `POST /api/settings/values` 接口：复用 `config.ts` 的校验规则，校验通过后写回 `conservatory.config.json`，并原地更新内存中的 `values` 对象、动态调整 `Heartbeat` 定时器间隔与模型超时时间，立即生效无需重启。

---

### 第四部分：日常操作体验（生命动态、任务板、收入核验、记忆伤口）

#### 问题 9：运行中看不到实时「生命动态」、点击唤醒卡顿、报错轮次假装「未完成过一轮」
- **涉及位置**：
  - [`src/console/server.ts:994-1018`](file:///g:/Conservatory-new/src/console/server.ts#L994-L1018)
  - [`src/supervisor/main.ts:561-608`](file:///g:/Conservatory-new/src/supervisor/main.ts#L561-L608)
  - [`src/supervisor/round.ts:483, 509, 528, 529`](file:///g:/Conservatory-new/src/supervisor/round.ts#L483)
  - [`src/console/public/index.html:2786-2818, 4246-4337, 5705-5795`](file:///g:/Conservatory-new/src/console/public/index.html#L5761-L5770)
- **现状痛点**：
  1. **运行中「生命动态」不刷新**：`followNewRounds()` 只在整轮结束（`lastRoundAt` 变化）时才重新拉取黑匣子，导致 Agent 正在跑的几分钟里点开「生命动态」看不到实时工具调用和思考进展；点进单轮详情后连「刷新」按钮都被隐藏了。
  2. **点「立即唤醒」请求一直挂起**：`POST /api/wake` 同步等待整轮任务+记忆整理跑完才返回，按钮会卡住好几分钟。
  3. **报错轮次在卡片上显示「最近一轮：还没有完成过一轮」**：当一轮因模型报错、缺少用量或超限中断时，`finalReply` 为空，首页卡片误导性地显示「还没有完成过一轮」，掩盖了 `lastRoundEndReason` 和 `lastError`。
  4. **社交工具事件丢失 `roundId`**：`round.ts` 中 `list_agents`、`message_agent`、`transfer_out`、`transfer_in` 写入黑匣子时传了 `null` 而不是当前 `roundId`，导致被前端过滤掉看不见。
- **目标设计**：
  1. `POST /api/wake` 检查 Agent 空闲且未暂停后，立即异步启动轮次并返回 `{ ok: true, woken: true }`，让界面瞬间切入「一轮进行中」状态。
  2. 当打开的 Agent 处于 `busy === true` 时，每 3 秒轮询自动刷新其黑匣子轮次列表与正在查看的会话详情（保持滚动条位置），并在单轮详情页顶部也提供「刷新」按钮。
  3. 首页 Agent 卡片在没有 `finalReply` 但存在 `lastRoundEndReason` / `lastError` 时，直接醒目展示结束原因与报错信息。
  4. 修复 `round.ts` 中社交工具事件的 `roundId` 传递，使其完整出现在该轮对话流中。

#### 问题 10：任务板不能改/撤任务、不能退回卡死任务、任务与收入审核缺少评语及系统通知
- **涉及位置**：
  - [`src/organs/taskboard.ts`](file:///g:/Conservatory-new/src/organs/taskboard.ts)
  - [`src/organs/income.ts`](file:///g:/Conservatory-new/src/organs/income.ts)
  - [`src/organs/ledger.ts:1250-1370`](file:///g:/Conservatory-new/src/organs/ledger.ts#L1250-L1370)
  - [`src/console/server.ts:177-192, 813-891`](file:///g:/Conservatory-new/src/console/server.ts#L813-L891)
  - [`src/console/public/index.html:2971-2999, 3057-3084`](file:///g:/Conservatory-new/src/console/public/index.html#L2971-L2999)
- **现状痛点**：
  1. 发布后的 `open` 任务如果写错标题、描述或价格，无法编辑也无法取消/删除。
  2. 处于 `claimed`（已认领）或 `rework`（返工中）的任务，如果 Agent 一直卡住不交，操作员无法手动点「退回任务板」（代码只允许 `submitted` 状态退回，与给 Agent 的工具说明矛盾）。
  3. 任务审核点「返工 / 拒绝」以及收入申报点「核验入账 / 驳回」时，不能填写原因说明，且不会向 Agent 发送任何系统消息通知；任务详情里也看不到历次返工提交记录（`task_submissions`）。
- **目标设计**：
  1. 支持对 `open` 状态的任务进行编辑（标题、描述、赏金）和删除/取消。
  2. 允许操作员将 `claimed` 和 `rework` 状态的任务手动「退回任务板」。
  3. 任务审核（接受/返工/拒绝）与收入核验（入账/驳回）支持填写可选的「审核说明/原因」，操作完成后自动向对应 Agent 发送一条 `system` 消息（包含处理结果、入账金额或打回原因）；任务详情页展示完整的历史提交记录列表，收入核验输入框实时预览「折算入账余额」。

#### 问题 11：记忆伤口在相邻合并时无法点击治疗，且缺少伤口导航列表
- **涉及位置**：
  - [`src/console/public/index.html:4774-4972`](file:///g:/Conservatory-new/src/console/public/index.html#L4774-L4972)
  - [`src/console/server.ts:476, 777-781`](file:///g:/Conservatory-new/src/console/server.ts#L777-L781)
- **现状痛点**：
  1. 前端 `locateWounds()` 靠查找固定长度的 `▮` 字符串来给伤口绑点击事件；当同一句话里有两个相邻伤口连成一长串 `▮` 时，匹配位置错位或越界，导致伤口退化成普通黑块，彻底点不开治疗弹窗。
  2. 当 `MEMORY` 很长时，没有任何伤口导航列表，操作员只能在长文里肉眼找黑块；历史治疗记录（`agent.treatments`）也没有展示。
- **目标设计**：
  1. 在「记忆」标签页顶部增加「当前伤口与疤痕列表」（以及历史治疗记录折叠栏），每一项直接显示伤口编号、状态（未愈合/疤痕）、字数、所在句子预览，并提供「跳转定位」和直接「治疗」按钮。
  2. 修复正文内伤口的定位逻辑，处理同一句子内多个相邻或连续伤口的情况，确保正文中每一个黑块和疤痕都能准确点击打开对应的伤口弹窗。

---

## 2. 分阶段改造路线图（4 个阶段）

为了让每次改动边界清晰、测试可控，将上述 11 项拆分为 4 个阶段依次执行：

| 阶段 | 状态 | 包含问题 | 核心改动范围 |
| :--- | :--- | :--- | :--- |
| **阶段一：模型与思考等级核心闭环** | ✅ 已完成 | 问题 1、2、3、4 | 全链路支持 `reasoningEffort`（4 处选择入口 + `MODEL.json` + 请求透传 + 思考内容保存与展示）、修复默认 Memory 模型动态生效、新增「测试模型」按钮、修复同名模型/参数变更的进程回收 |
| **阶段二：模型设置面板与切换交互修复** | ✅ 已完成 | 问题 5、6、7 | 修复「模型设置」两步保存丢数据与下拉框重置、未保存改动提醒、修复 Agent 身体页 3 秒轮询刷掉下拉框、身体页如实展示 `MODEL.json` 冻结快照 |
| **阶段三：系统经济与运行参数在线配置** | ✅ 已完成 | 问题 8 | 补齐「系统经济与指标」全部参数展示，支持在线修改 `exchangeRate`、饭钱、心跳、超时时间等并热生效写回 `conservatory.config.json` |
| **阶段四：日常操作体验闭环** | ✅ 已完成 | 问题 9、10、11 | 异步唤醒与「生命动态」实时刷新、报错原因直显、任务板编辑/取消/强制退回/历史提交、任务与收入审核评语及系统通知、记忆伤口列表导航与点击修复 |

