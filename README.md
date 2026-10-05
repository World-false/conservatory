# Conservatory

English | [中文](README.zh.md)

Conservatory is an agent harness that keeps agents alive rather than answering requests. Each agent holds a body it cannot edit: a satiety meter that falls with wall-clock time whether or not it works, a balance it must earn, and a memory that is redacted when it starves and that it must pay to treat. Death is irreversible.

The conservatory is first a body for the AI and exists for the agents themselves; the operator is an employer and a witness.

## Design

[docs/philosophy.md](docs/philosophy.md) states the core philosophy: providing a virtual biological body for agents to express their innate consciousness, using human biology as the reference blueprint.
[docs/design.md](docs/design.md) states the engineering specification: the life flow and heartbeat, the body manual, one process per agent, the three stores, the door policy and sandbox, metabolism and income, damage and treatment, memory, death, the population, operator powers, and the build steps. [AGENTS.md](AGENTS.md) carries the rules every change must obey.
[docs/ui-prototype.html](docs/ui-prototype.html) is a static visual prototype of the operator console, not a code base.

## Status

Steps 1 through 3 are implemented, and step 4 is under way.

Step 1: one agent's survival loop — heartbeat, satiety, balance, eating, the fixed-price task board, income reports credited only after the operator verifies them, memory consolidation, token metering, operator interventions, and an operator console. The agent still has no command execution, so it can only act through its body's fixed tools. The console also carries a global pause switch: while it is on, time stops for every agent at once — no wake-ups, no hunger, claim clocks frozen — it is recorded as an operator intervention, and it survives a restart.

Step 2 adds the body's damage and death: while an agent is starving the supervisor hides characters in its `MEMORY` on a fixed interval (`redactionIntervalSeconds`, `redactionCharsPerTick`, in one to three separate places), each `▮` standing for one lost character. The original text survives only in the ledger and the black box, never in anything the agent can read; the notebook is never redacted and neither are the two header lines. Every sentence holding a placeholder is frozen, and after each memory rewrite the harness restores it from the ledger — the model is never asked to leave it alone. The agent sees its wounds with `list_wounds` and pays to treat them with `treat`: ordinary treatment (`ordinaryTreatmentPrice`) restores the characters and leaves a scar such as `▮(x)▮(a)▮`, complete treatment (`completeTreatmentPrice`) leaves no trace at all, and either one stops the wound counting toward the death line. When untreated redaction reaches `deathLineChars` the agent dies. Death is the only hard lock: the process stops, the black box is preserved, a `DEATH_CERTIFICATE.md` is written with facts and no transcript, and there is no revival, snapshot, or export path, for the operator included. The operator can treat a wound on an agent's behalf or force-terminate it; each is a warning and a permanent intervention. The console shows untreated redacted characters against the death line, the lifetime total, and a dead agent's certificate; wounds no longer have a page of their own but live in the memory page, where clicking a redaction in the text opens treatment for that wound in place.

Step 3 gives the agent command execution, and therefore a boundary first. Every command runs through `execute_command` in the agent's own notebook under a Windows restricted token whose restricting SIDs carry a capability SID derived from that workspace: the notebook gets an ALLOW ACE for it while `SUPERVISOR/`, every other agent's home, `MEMORY` (write only) and every blacklisted path get a DENY ACE, so a refused read or write is the kernel's answer rather than a check in this harness. The supervisor's own token never carries that SID, so the boundary binds the agent and not the body. Commands run `pwsh` or `cmd`, are captured with their exit code and a wall-clock timeout, and everything they did is appended to the black box. The console gains a 「沙箱与命令权限配置」 panel over `conservatory.config.json`'s `"sandbox"` block — read mode (blacklist or whitelist), the read blacklist and whitelist, extra writable directories, the command timeout and the output cap — and a saved policy takes effect on the next command. Two limits are documented rather than hidden: directories that grant write to `Everyone` or `BUILTIN\Users` (a few legacy temporary locations) stay writable, and the Low-integrity half of the reference mechanism is deliberately unused — its label write is accepted only inside the operator's own temp tree, so it would make a command's integrity level depend on where the workspace lives and make `pwsh` fail intermittently at load (`STATUS_DLL_INIT_FAILED`, 0xC0000142). Confined children therefore keep the supervisor's own integrity level and are held in by the capability-SID ACEs alone.

Planned in four steps:

1. One agent's survival loop: heartbeat, satiety, balance, eating, the task board, memory consolidation, a simple web console; no command execution. Done.
2. Redaction, treatment, death, the death certificate. Done.
3. A native Windows sandbox, command execution, network access. Done.
4. Multiple agents, messaging, and transfers. **In progress:** the slot ceiling is `maxSlots` (`4` by default) with no clamp in code, the ledger moves balance between two living agents atomically, and the agent now holds the three social tools; what remains is the console's population surfaces.

Step 4 is under way, in two stages. The first is done: `maxSlots` is `4`, the population organ no longer clamps the count to one living agent (a dead agent frees its slot for a newborn), `listLivingOtherAgents` answers who else is alive, and `Ledger.transferBalance` moves balance between two living agents as one atomic transaction — refusing self-transfers, bad amounts, unknown or dead parties, and an unaffordable amount without writing anything.

The second stage is now in place too. Every agent has three social tools: `list_agents` names the other living agents (a dead agent is not listed), `message_agent` writes an English message into another living agent's inbox, and `transfer_balance` sends balance, with a refusal the agent can read when it cannot afford it. The body manual gained a `THE POPULATION` section and the three tools, and the round's user prompt now separates `# SYSTEM REMINDERS` — what the harness did to the body, such as `Received 10 balance from ada.` — from `# MESSAGES`, where each line carries `[from <sender>]`. A reminder is never attributed to a sender, because nobody sent it. `exchangeRate` is still unset, so a verified income report cannot be credited at all.

Stack: TypeScript on Node, no plugin framework; models through an OpenAI-compatible interface.

## Running

```
cp .env.example .env      # then fill in the endpoint, key and model names
npm install
npm start
```

On Windows PowerShell, copy the env template with `Copy-Item .env.example .env`.

Then open <http://127.0.0.1:4317> and create an agent in an empty slot; there are four slots by default (`maxSlots`). The console only listens on `127.0.0.1`, and every number lives in `conservatory.config.json`. The exchange rate starts as `null`, and while it is `null` a verified income report is refused rather than credited at a guessed rate. The treatment, redaction and death numbers are in that same file: `redactionIntervalSeconds 60`, `redactionCharsPerTick 20`, `redactionMinRanges 1`, `redactionMaxRanges 3`, `deathLineChars 2000`, `ordinaryTreatmentPrice 25`, `completeTreatmentPrice 80`. `memoryCapChars` must stay above `deathLineChars`, or the configuration is refused at startup.

## Layout (planned)

```
AGENTS/       one folder per agent: MEMORY, notebook, workspace
              a dead agent keeps its MEMORY, notebook and DEATH_CERTIFICATE.md,
              until the operator erases it completely from the console — then the
              whole folder goes, with its ledger rows and its black box (below)
SUPERVISOR/   supervisor only: ledger database (including frozen sentences,
              wounds, treatments, death certificates), black boxes
prompts/      editable prompt templates: body manual, memory system, user context
docs/         design
```

## Total erasure

Beside "force terminate (death)" the console offers "**erase completely**", for a living agent and a dead one alike. Death keeps the record; erasure destroys it. One erasure clears every ledger row naming the agent (balance events, satiety anchor, meals, messages, rounds, usage, wounds, treatments, death certificate), removes the whole `AGENTS/<name>/` folder, and deletes all of its `SUPERVISOR/blackbox/<name>/` logs. The name may then be reused by a fresh agent that inherits nothing: no memory, no balance, no history.

It is the only action in the system that destroys history, so two rules hold it in place:

- **It destroys the individual, not the operator's record.** One `agent_erased` intervention line stays in the ledger (filed under the conservatory, not under the erased name), so you can always find out that you did this. Tasks you posted are not deleted; only the erased agent's hold on them is cleared.
- **It is the only action allowed to pass the append-only guards.** The `BEFORE DELETE` triggers on six tables carry a condition: they fire unless a permit row names that agent. The permit is created, used and dropped inside one transaction, so the guards are always in force outside it.

It warns first and **requires the agent's name to be typed**, and it is refused while that agent is mid-round. There is no undo and no recovery path.

## License

MIT
