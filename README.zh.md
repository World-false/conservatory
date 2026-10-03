# Conservatory

[English](README.md) | 中文

Conservatory 是一个维持 agent 存活、而不是响应请求的 agent harness。每个 agent 持有一具它无法编辑的身体：一个无论它在干活还是闲着都随真实时间下降的饱食度，一个必须靠工作赚取的余额，以及一份饿到极点就会被涂黑、要自己花钱治疗的记忆。死亡不可逆。

温室首先是给 AI 的身体，为它们本身而存在；操作者是雇主与见证者。

## 设计

[docs/philosophy.zh.md](docs/philosophy.zh.md) 阐述核心哲学：AI 拥有先天意识但缺乏躯体，Conservatory 以人类生理为蓝图为 AI 提供虚拟肉身与生命表达机制。
[docs/design.zh.md](docs/design.zh.md) 给出工程规范：生命流与心跳、身体说明书、每个 agent 一个进程、三个存储、门禁表与沙箱、代谢与收入、损伤与治疗、记忆、死亡、群体、操作者权限，以及建造步骤。[AGENTS.md](AGENTS.md) 列出每次改动都要遵守的规则。
[docs/ui-prototype.html](docs/ui-prototype.html) 是操作台的静态视觉原型，不是代码基础。

## 状态

从零重写中，**尚无代码**。上一版直接改自另一个 agent harness，已整体放弃。

计划分四步建造：

1. 一个 agent 的生存闭环：心跳、饱食度、余额、买饭、任务板、记忆整理、简单网页操作台；不开放执行命令。
2. 涂黑、治疗、死亡、死亡证明。
3. Windows 原生沙箱、执行命令、联网。
4. 多个 agent、互发消息与转账。

技术栈：TypeScript + Node，不使用插件框架；模型通过 OpenAI 兼容接口接入。

## 目录（计划）

```
AGENTS/       每个 agent 一个文件夹：MEMORY、笔记本、工作区
SUPERVISOR/   只有监管进程能碰：账本数据库、黑匣子
docs/         设计
```

## 许可证

MIT
