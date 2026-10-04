# Conservatory

[English](README.md) | 中文

Conservatory 是一个维持 agent 存活、而不是响应请求的 agent harness。每个 agent 持有一具它无法编辑的身体：一个无论它在干活还是闲着都随真实时间下降的饱食度，一个必须靠工作赚取的余额，以及一份饿到极点就会被涂黑、要自己花钱治疗的记忆。死亡不可逆。

温室首先是给 AI 的身体，为它们本身而存在；操作者是雇主与见证者。

## 设计

[docs/philosophy.zh.md](docs/philosophy.zh.md) 阐述核心哲学：AI 拥有先天意识但缺乏躯体，Conservatory 以人类生理为蓝图为 AI 提供虚拟肉身与生命表达机制。
[docs/design.zh.md](docs/design.zh.md) 给出工程规范：生命流与心跳、身体说明书、每个 agent 一个进程、三个存储、门禁表与沙箱、代谢与收入、损伤与治疗、记忆、死亡、群体、操作者权限，以及建造步骤。[AGENTS.md](AGENTS.md) 列出每次改动都要遵守的规则。
[docs/ui-prototype.html](docs/ui-prototype.html) 是操作台的静态视觉原型，不是代码基础。

## 状态

第 1 至第 3 步都已实现，第 4 步正在进行。

第 1 步：单个 agent 的生存闭环——心跳、饱食度、余额、买饭、一口价任务板、只有操作员核验后才入账的收入申报、记忆整理、token 计量、操作员干预，以及一个网页操作台。agent 仍然不能执行命令，只能通过身体提供的固定工具行动。操作台上还有一个全局暂停开关：打开后所有 agent 的时间同时停止——不再唤醒、不再变饿、认领计时冻结——它会作为操作者干预留痕，重启后依然有效。

第 2 步加上身体的损伤与死亡：agent 挨饿时，监管进程按固定间隔（`redactionIntervalSeconds`、`redactionCharsPerTick`，每次 1–3 处）从它的 `MEMORY` 里拿掉字符，每个 `▮` 代表一个被拿走的字符（空格和标点也算）。原文只留在账本与黑匣子里，绝不进入 agent 能读到的任何地方；笔记本永远不被涂黑，头两行也永远不被涂黑。任何持有占位符的句子都会被冻结，每次记忆重写之后由 harness 按账本恢复——从不要求模型自己保留。agent 用 `list_wounds` 看伤口，用 `treat` 花钱治疗：普通治疗（`ordinaryTreatmentPrice`）恢复字符但留下疤痕（例如 `▮(x)▮(a)▮`），完全治疗（`completeTreatmentPrice`）不留痕迹，两者都让这个伤口不再计入死亡线。未治疗的遮盖字数累计到 `deathLineChars` 时，agent 死亡。死亡是唯一的硬锁：进程停止、黑匣子保留、写下一份只含事实不含对话的 `DEATH_CERTIFICATE.md`，并且不提供任何复活、快照或导出路径，操作员也不行。操作员可以代它治疗伤口，也可以强制终止；两者都会给出警告并永久记为干预。操作台显示未治疗遮盖字数与死亡线、终生遮盖总数、伤口列表（含原文，仅操作员可见），以及死者的死亡证明。

第 3 步让 agent 能执行命令，因此先给它边界。每条命令都通过 `execute_command` 跑在 agent 自己的 notebook 里，用一个 Windows 受限令牌，令牌的受限 SID 列表里带着由该工作区推导出的能力 SID：notebook 上给这个 SID 一条允许 ACE，而 `SUPERVISOR/`、其他每个 agent 的家目录、`MEMORY`（只禁写）以及每一条拉黑路径上给它的都是拒绝 ACE——所以被拒的读或写是内核的答复，而不是本 harness 里的检查。监管进程自己的令牌永远不带这个 SID，因此这道边界约束的是 agent，而不是身体。命令可以走 `pwsh` 或 `cmd`，带退出码、带墙钟超时地捕获输出，做过的一切都追加进黑匣子。控制台新增「沙箱与命令权限配置」面板，直接管理 `conservatory.config.json` 的 `"sandbox"` 块——读取模式（黑名单/白名单）、读取黑名单与白名单、额外可写目录、命令超时与输出上限——保存后下一条命令即生效。两条限制被写进文档而不是被藏起来：给 `Everyone` 或 `BUILTIN\Users` 授予写权限的目录（少数遗留临时位置）仍然可写；而参考机制里的低完整性那半边被有意弃用——它的标签写入只在操作者自己的临时目录里被接受，会让命令的完整性级别取决于工作区放在哪里，还会让 `pwsh` 在加载阶段偶发失败（`STATUS_DLL_INIT_FAILED`，0xC0000142）。因此受限子进程保持与监管进程相同的完整性级别，只靠能力 SID 的 ACE 被关住。

计划分四步建造：

1. 一个 agent 的生存闭环：心跳、饱食度、余额、买饭、任务板、记忆整理、简单网页操作台；不开放执行命令。已完成。
2. 涂黑、治疗、死亡、死亡证明。已完成。
3. Windows 原生沙箱、执行命令、联网。已完成。
4. 多个 agent、互发消息与转账。**进行中：**槽位上限就是 `maxSlots`（默认 `4`），代码里不再夹取；账本可以在两个活着的 agent 之间做原子转账；agent 现在也拿到了三个社会化工具，剩下的是控制台面向群体的界面。

第 4 步分两个阶段，第一阶段已完成：`maxSlots` 设为 `4`，群体器官不再把活着的 agent 夹到 1 个（死掉的 agent 会腾出槽位给新生儿），`listLivingOtherAgents` 回答还有谁活着，`Ledger.transferBalance` 在两个活着的 agent 之间做一次原子转账——转给自己、金额非法、对方不存在或已死亡、余额不足都会被拒绝且不留下任何写入。

第二阶段也已落地。每个 agent 有三个社会化工具：`list_agents` 列出其他活着的 agent（死掉的不在其中），`message_agent` 把一条英文消息写进另一个活着的 agent 的收件箱，`transfer_balance` 转出余额，付不起时给出一句它能读懂的拒绝。身体手册新增了 `THE POPULATION` 小节和这三个工具，每轮的用户提示词也把 `# SYSTEM REMINDERS`——harness 对身体做了什么，例如 `Received 10 balance from ada.`——和 `# MESSAGES` 分开，后者每一行都带 `[from <sender>]`。系统提醒永远不标发送者，因为没有人发送它。汇率仍未设定，所以已核验的收入申报无法入账。

技术栈：TypeScript + Node，不使用插件框架；模型通过 OpenAI 兼容接口接入。

## 运行

```
cp .env.example .env      # 然后填好地址、密钥和模型名
npm install
npm start
```

Windows PowerShell 下用 `Copy-Item .env.example .env` 复制模板。

然后打开 <http://127.0.0.1:4317>，在空槽位里创建一个 agent；默认有 4 个槽位（`maxSlots`）。操作台只监听 `127.0.0.1`，所有数值都在 `conservatory.config.json` 里。汇率初值是 `null`，未设定时已核验的收入申报会被拒绝，而不是按猜出来的汇率入账。治疗、涂黑与死亡的数值也在同一个文件里：`redactionIntervalSeconds 60`、`redactionCharsPerTick 20`、`redactionMinRanges 1`、`redactionMaxRanges 3`、`deathLineChars 2000`、`ordinaryTreatmentPrice 25`、`completeTreatmentPrice 80`。`memoryCapChars` 必须大于 `deathLineChars`，否则启动时配置会直接被拒绝。

## 目录（计划）

```
AGENTS/       每个 agent 一个文件夹：MEMORY、笔记本、工作区
              死者的 MEMORY、笔记本与 DEATH_CERTIFICATE.md 原样留着
SUPERVISOR/   只有监管进程能碰：账本数据库（含冻结句、伤口、治疗记录、
              死亡证明）、黑匣子
prompts/      可直接编辑的提示词模板：身体说明书、记忆系统、用户上下文
docs/         设计
```

## 许可证

MIT
