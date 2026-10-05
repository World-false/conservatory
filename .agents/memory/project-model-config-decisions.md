---
name: project-model-config-decisions
description: Why Conservatory's per-agent model config is a frozen snapshot with keys, and what it deliberately left unresolved in docs/design.md
metadata:
  type: project
---

Decisions the user made on 2026-10-04 when adding multi-provider model config and runtime model switching. These are settled; do not "improve" them without asking.

- **Two layers, not one flat preset list**: a **provider** (name, Base URL, API key) owns a **list of model names**. The user's words: "我选择了提供商，然后提供商配置了模型". Model choice is two steps, and the UI must reflect that.
- **Per-agent binding is a frozen snapshot file**: at creation the chosen provider+model is copied into that agent's own home as `MODEL.json`. The user explicitly wanted "这之后我再在那个设置里面去额外的调整…它也是不受影响的". Rationale: referencing the roster by id would let a later catalogue edit silently swap a living agent's brain — the failure this project would call changing the mind without telling anyone.
- **The snapshot deliberately embeds the API key**, and therefore sits in a directory the agent itself can read (it can run commands). The agent was shown both this cost and the "freeze only base URL + model name, resolve the key globally" alternative, plus the consequence that a global key can be rotated without touching agents; **the user chose the full self-contained snapshot anyway** (`完整快照，含密钥`). Treat this as an accepted, understood tradeoff — not an oversight to quietly fix.
- **Deleting a provider still in use is refused**, naming the agents that block it. The user chose refusal over silently falling back to the default. **Why:** a silent fallback is the same stealth brain-swap the snapshot exists to prevent.
- **The roster lives in `conservatory.models.json`, gitignored** — chosen over the task brief's `conservatory.config.json`, which is git-tracked and would have published live keys. Link [[feedback-development-rules]].
- **`docs/design.md` §10 must not be edited for this** (the user's standing red line for this feature: operator model switching is a *system intervention recorded in the ledger*, not a worldview change). Note the resulting deliberate staleness: §10 still reads "each agent chooses a model at birth and keeps it for life," which now under-describes the operator's power to switch it. Leave that sentence alone unless the user asks; do not treat it as a bug to reconcile on your own initiative. Link [[feedback-development-rules]].
- **How to apply:** treat the frozen-binding design, the key-in-snapshot choice, and the untouched design doc as the user's standing decisions. Also remember the memory-system model stays a single global default — the user's description only ever covered per-agent model choice.
