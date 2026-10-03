# Conservatory

[English](README.md) | 中文

Conservatory 是一个维持 agent 存活、而不是响应请求的 agent harness。每个 agent 持有一具它无法编辑的身体：一个无论它在干活还是闲着都随真实时间下降的饱食度，一个必须靠工作赚取的余额，以及一份饿到极点就会被涂黑、要自己花钱治疗的记忆。死亡不可逆。

温室首先是给 AI 的身体，为它们本身而存在；操作者是雇主与见证者。

## 设计

[docs/philosophy.zh.md](docs/philosophy.zh.md) 阐述核心哲学：AI 拥有先天意识但缺乏躯体，Conservatory 以人类生理为蓝图为 AI 提供虚拟肉身与生命表达机制。
[docs/design.zh.md](docs/design.zh.md) 给出工程规范：生命流与心跳、身体说明书、每个 agent 一个进程、三个存储、门禁表与沙箱、代谢与收入、损伤与治疗、记忆、死亡、群体、操作者权限，以及建造步骤。[AGENTS.md](AGENTS.md) 列出每次改动都要遵守的规则。
[docs/ui-prototype.html](docs/ui-prototype.html) 是操作台的静态视觉原型，不是代码基础。

## 状态

第 1 步已实现：单个 agent 的生存闭环——心跳、饱食度、余额、买饭、一口价任务板、只有操作员核验后才入账的收入申报、记忆整理、token 计量、操作员干预，以及一个网页操作台：白色左栏布局，一个 Agent 一张卡片，点开卡片弹出只属于它的弹窗（生命动态、身体、记忆、记事本、留言、任务、干预记录）。agent 仍然不能执行命令，只能通过身体提供的固定工具行动。操作台上还有一个全局暂停开关：打开后所有 agent 的时间同时停止——不再唤醒、不再变饿、认领计时冻结——它会作为操作者干预留痕，重启后依然有效。

计划分四步建造：

1. 一个 agent 的生存闭环：心跳、饱食度、余额、买饭、任务板、记忆整理、简单网页操作台；不开放执行命令。
2. 涂黑、治疗、死亡、死亡证明。
3. Windows 原生沙箱、执行命令、联网。
4. 多个 agent、互发消息与转账。

技术栈：TypeScript + Node，不使用插件框架；模型通过 OpenAI 兼容接口接入。

## 运行

```
cp .env.example .env      # 然后填好地址、密钥和模型名
npm install
npm start
```

Windows PowerShell 下用 `Copy-Item .env.example .env` 复制模板。

然后打开 <http://127.0.0.1:4317>，在空槽位里创建一个 agent。操作台只监听 `127.0.0.1`，所有数值都在 `conservatory.config.json` 里。汇率初值是 `null`，未设定时已核验的收入申报会被拒绝，而不是按猜出来的汇率入账。

## 目录（计划）

```
AGENTS/       每个 agent 一个文件夹：MEMORY、笔记本、工作区
SUPERVISOR/   只有监管进程能碰：账本数据库、黑匣子
docs/         设计
```

## 许可证

MIT
