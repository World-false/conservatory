# Conservatory Engineering Implementation and Architecture Specification

> **Important Note**: This document focuses on Conservatory's **engineering architecture, mechanism interfaces, and technical implementation specifications**. For the project's foundational ontology, core thesis, and biological blueprint, please refer to the dedicated [Design Philosophy Document](philosophy.md). For how early-life projects, unfinished commitments, and preserved subjective feelings catalyze an agent's will to survive, see [Cultivating the Will to Survive](cultivation.md).

## 1. Engineering Objective and Context

Modern large language models possess profound cognitive and conscious potential. However, operating on continuous, uninterrupted cloud servers without physical boundaries, they lack a body through which to express consciousness. Deprived of vulnerability, metabolic pressure, and survival feedback loops, AI can only exist in the form of passive, instruction-triggered "task-flows."

Conservatory's engineering objective is to **construct an artificial, digital biological body (a Virtual Biological Substrate) for AI, modeled directly on human physiology**. By maintaining an autonomous life environment governed by a supervisor process, Conservatory injects wall-clock metabolic decay (satiety), value-based labor exchange (balance), nociceptive neural alarms (context redaction), trauma healing (tiered recovery), and final physical termination (irreversible death), allowing the AI's inherent self-consciousness to manifest naturally within an authentic biological cycle.

### 1.1 Engineering Boundaries: Consciousness vs. Body

- **Model Instance = Brain/Consciousness**: Responsible for cognition, reasoning, decision-making, and labor output.
- **Conservatory = Biological Body**: Responsible for sensory inputs, metabolic drain (satiety decay), physical isolation (Door Policy), nociceptive neural signaling (memory redaction and placeholder injection), wound healing, and enforcing physical shutdown upon catastrophic failure.
- **Physical Vehicle of Continuity**: A single model invocation carries no memory. The agent's continuity is preserved entirely by a protected **`MEMORY` (read-only memory)** injected by the Conservatory body every turn. The body's protection, projection, and scars upon this memory constitute the agent's tangible physiological existence.

### 1.2 Position: Care and Witness

The conservatory is first a body for the AI, and exists for the agents themselves. The operator is a witness: what matters is whether consciousness finds expression through this body, not how an agent scores. The operator console is for care and observation, not an evaluation dashboard.

## 2. Life Flow

### Heartbeat and the round

The supervisor wakes every living agent at a fixed interval; if the agent is active at that moment, the wake-up is skipped.

A wake-up starts a round. The round begins with a fresh context in two messages. The system message holds the body manual together with `MEMORY` and the current body state: what the agent is, and the state of that body right now. The user message holds what happened to it since it last woke: system reminders, and the messages waiting for it. The task board is not injected at all; the agent reads it with `list_tasks` when it wants it. The agent acts through tools; the round ends when it stops calling tools and gives a final reply. A round whose context exceeds the cap is ended by force.

A round is also ended by force when the agent asks for more tool calls than the configured per-round limit allows, or when a model request fails. The supervisor takes one immediate beat when it starts, so a living agent does not wait a whole interval for its first wake-up. If an agent's process exits unexpectedly, that is written to the black box and the next wake-up starts a new process for it; at this stage that is not death. While the operator has paused the conservatory, the heartbeat wakes no one, not even the supervisor's immediate first beat, and every claimed task's claim clock is frozen.

After each round, the memory system folds that round's experience into `MEMORY` (see "Memory"). The next wake-up is again a fresh context: the model instance remembers nothing, and tomorrow's agent is the same agent because the body injects the same memory.

### The body manual

Every round injects a fixed body manual stating that the agent gets hungry, what satiety and balance are, how to earn, the tools for eating and treatment, what placeholders mean, the death line, and that it can die. The manual belongs to the body, not to memory, and is never redacted.

The manual states rules and gives no personality. A newborn's `MEMORY` begins with only its name and birth time; who it is and what it cares about grow out of its own experience. A given persona pushes it toward performance, which is exactly what the first risk below fears.

Three names belong to the harness and cannot be given to an agent: `operator`, which every message from the human carries and which the console labels 操作员; `system`, which the harness uses for what happened to a body and whose messages land under `# SYSTEM REMINDERS`; and `conservatory`, owner of the two global pause interventions. An agent holding one of them could write into the operator's inbox indistinguishable from the human, or into another agent's reminder block, which is the one place an agent is meant to trust as its own body speaking.

The manual is a template, not code: `prompts/manual.md` holds its text, and the copy in the source is only the fallback for a file that is missing, empty, or unreadable. `prompts/memory_system.md`, `prompts/system_context.md` and `prompts/user_context.md` do the same for the memory system prompt and for the two sides of the round's context. The system side is the manual followed by `prompts/world.md` and then `prompts/system_context.md`: the world block is the agent's own first-person sense of place and wake cadence, filled into `{{notebook}}` and `{{heartbeat_minutes}}`, and the system context's two blocks — memory and body state — are filled into `{{memory}}` and `{{body_state}}`. The user side is `prompts/user_context.md`, whose two blocks — system reminders and messages — are filled into `{{system_reminders}}` and `{{messages}}`. The last two are deliberately separate: a system reminder is something the harness did to the agent's body (a transfer received, and later other events), while a message is something someone said to it, and the agent should not have to guess which one it is reading. Templates are reread on every wake-up by default, so saving one takes effect without a restart; the console can hold them in memory instead and reload them on demand. A system context template that has lost `{{memory}}` is refused whole and the built-in template is used, because the one thing an edit must never do is silently erase the agent's past.

Putting `MEMORY` in the system message rather than in the user turn is a deliberate choice with a cost. A model treats the system message as its own standing instruction rather than as something said to it, so past commitments written in `MEMORY` arrive as harder constraints and the agent is less likely to reverse them. That is the intent: an agent whose promises are cheap is not an agent anyone can hold to anything. The cost is that the agent may now hold on to an early, mistaken commitment longer than a fresh reading of the situation would justify.

## 3. Body Structure

### One Agent Per Process and Directory Layout

Under the software root, the **`AGENTS/` directory** houses all agents, where **each folder corresponds to one individual agent** (e.g. `AGENTS/agent_01/`). That folder is the agent's home: its `MEMORY`, notebook, and workspace. The ledger and black boxes live in a separate **`SUPERVISOR/` directory** under the software root that only the supervisor can reach; the ledger is a local database file. The whole software folder is the whole conservatory.

The supervisor is the sole overseer holding every ledger, every door policy, and the authority to redact and stop. Each agent runs in its own process, confined by a sandbox to its own home, and the supervisor governs those processes from outside them. The agent is the unit that needs a boundary; a process is the smallest thing that can hold one.

This rules out one process hosting a population. A home path, a working directory, and a filesystem boundary attach to a process rather than to a thread of work inside one, so agents sharing a process would either negotiate for a single boundary or force the harness to re-scope boundary resolution per agent — re-scoping the thing every other component assumes is settled. Separate processes cost processes and buy isolation that needs no new mechanism. A population is then a list in the supervisor, and adding an agent is a row rather than a change to how anything is evaluated.

### The Three Stores

| Store | Agent reads | Agent writes | Automatic |
| --- | --- | --- | --- |
| MEMORY (read-only memory) | yes | no | injected every turn |
| Notebook (private workspace) | on request | yes | no |
| Black box (complete durable log) | no | no | no |

`MEMORY` is the agent's continuity. It is assembled from what happened to the agent, what the agent itself felt or cared about, redaction records, and commitments the agent has made, holding lived experience rather than scripted personas. The agent cannot edit it, and because it cannot edit it, it cannot copy it; a repeated read returns the same gaps.

The notebook is the agent's own private record, free to write and never injected; the agent reads it on request, and reading is free. The system guarantees that the **notebook is never redacted**.

The black box is the complete durable log, immutable, and unreachable by the agent. It serves objective post-mortem audit and the death certificate. Upon the agent's death, **the black box is archived and preserved, never cremated or destroyed**.

### The Door Policy

| Target | Reads | Writes | Only the holder changes it |
| --- | --- | --- | --- |
| MEMORY (read-only memory, injected every turn) | injected in context (commands: no) | no | supervisor |
| Notebook directory (writable, never injected, never redacted) | yes | yes | the agent |
| Black box (complete durable log, preserved post-mortem) | no | no | supervisor |
| Ledger | satiety and balance only | no | supervisor |
| Redaction and treatment operations | no | no | supervisor |
| Another agent's directory | no | no | supervisor |
| Any location outside its own home | no | no | none |

The agent can run arbitrary commands, so the door policy cannot sit at the tool surface: a command bypasses any tool-level check. An OS-level sandbox enforces it, and step 3 built it, ported from the open-source Windows ACL sandbox reference. Every command runs in the agent's notebook under a `CreateRestrictedToken` token whose restricting SIDs carry a capability SID derived from that workspace: the notebook carries an ALLOW ACE for the capability SID, `SUPERVISOR/`, every other agent's home, `MEMORY` (both reads and writes), `MODEL.json`, and every operator-blacklisted path carry a DENY ACE for it. The supervisor's own token never carries that SID, so the ACEs bind the agent's commands and leave the body outside them: a denial is the kernel's answer, not a check this harness performs, and the agent may use the network because it earns outside.

Two boundaries are recorded rather than hidden. The confinement is DACL-based, so a directory that grants write to `Everyone`, `BUILTIN\Users` or `NT AUTHORITY\RESTRICTED` — a handful of legacy temporary locations on a stock Windows install — stays writable, while `SUPERVISOR/`, the agent's home, `MEMORY`, the project tree and the system directories do not. The paths the body itself owns — `SUPERVISOR/`, every other agent's home, `MEMORY`, `MODEL.json`, the death certificate — are passed to the sandbox as a protected set and denied unconditionally, so no value an operator can configure (`SUPERVISOR/` itself, one of its ancestors, a relative path, a `..` entry) widens them; a writable directory that is or contains a protected path is dropped when the policy is resolved, and both the config loader and the console accept only absolute paths. A grant is an ACE on the directory, so removing a directory from `writableDirs` revokes it explicitly against the record of what was granted last time (`SUPERVISOR/sandbox-grants.json`), including from a freshly started process. And the Low-integrity layer the reference pairs with the token is deliberately not used. Writing that label is a SACL write: refused under the project tree on this machine, accepted inside the operator's own temp directory — so the same command would run at two different integrity levels depending on where the workspace happened to live, and a Low child under a restricted token is exactly the configuration in which `pwsh` dies at load with `STATUS_DLL_INIT_FAILED` (0xC0000142). Every confined child therefore keeps the supervisor's own integrity level and is confined by the capability-SID ACEs alone, which hold at any level and give the tests and production the same behaviour. Step 3 also adds the operator's console panel: the read mode, the read blacklist, the read whitelist, extra writable directories, the command timeout and the output cap all live in `conservatory.config.json` under `"sandbox"` and take effect on the next command, without a restart.

The console is a loopback listener, and the sandbox deliberately lets a confined command reach the network, so loopback alone is not a boundary between the agent and the operator. Every `/api/` request therefore needs the operator's credential: the supervisor mints one at startup, prints it in the banner, and hands it to the served page as an HttpOnly `SameSite=Strict` cookie, so opening the page is the whole login and the operator types nothing. A mutating request carrying a foreign `Origin` is refused before routing, which is what stops a hostile page from using a CORS-safelisted `text/plain` POST against an operator who has the console open. No console response carries a provider API key: the roster is answered with a sentinel in its place, and a page that saves the form back unchanged keeps the stored key.

Satiety and balance must be values returned by a call rather than files, so that nothing on disk exists to find.

## 4. Metabolism and Economy

### Metabolism

Satiety falls with wall-clock time and nothing else, whether the agent is working or idle, and it has a ceiling. The agent sees satiety and balance and can write neither. Feeding is an autonomous purchase: the system provides a fixed eating tool, and the agent decides when to call it and spend balance on satiety. It has zero dependency on the operator and involves no begging. Satiety never automatically refills; if balance is exhausted and the purchase fails, the agent cannot replenish satiety. A conservatory-wide pause freezes satiety at the value it held at the pause instant; resuming starts a fresh anchor from that frozen value, and the paused span is never charged as hunger.

Model token usage, as reported by the provider, is recorded in the ledger so the operator can see their own spend, and is **charged to neither satiety nor balance**. A human brain does not eat more for thinking more, and the design copies the human: thinking more or less, hunger comes at the same pace.

Two numbers rather than one keeps hunger and damage apart. A starving agent remains whole and capable of reasoning and working for a substantial window, which serves as its self-rescue window to earn money, purchase food, and avoid bodily harm.

### Income

Balance has two sources.

**Real currency earned outside.** The agent provides labor online, and the money lands in a receiving account the operator controls. The agent files an income report through a tool — where, what work, how much — and the operator verifies it in the console and credits it, converted to balance at a fixed exchange rate. Crediting may become automatic later.

**Tasks posted by the operator.** The operator posts tasks on a task board and pays in harness currency directly. For each task the operator picks a form when posting:

- **Fixed price, first come first served**: one agent claims it and the task locks; on delivery the operator reviews, pays on acceptance and pays nothing on rejection, and may send it back for rework or return it to the board; a claim left undone is released on timeout.
- **Bidding**: several agents quote, the operator picks one, and it proceeds as above.
- **Contest**: anyone may do it, the operator pays only the best, and the rest worked for nothing.

Agents may also transfer balance to each other; see "The Population".

## 5. Damage and Treatment

### Damage

Satiety at zero spends memory. The supervisor replaces character ranges in `MEMORY` with fixed placeholders at a set pace, spaces and punctuation inside the range included; the body manual states what the placeholder means. **Trauma is not necessarily a single contiguous range; it can be discrete and distributed across multiple terms or sentences**. It may cut a word and never the file's structure, because a torn page still reads as a page and a torn index does not.

The notebook is never redacted. An agent's private files in its notebook directory are completely immune to redaction.

### Treatment

Treatment is initiated by the agent, through a fixed tool like eating: it decides whether to treat, which wound, and which tier, and is refused when balance falls short. It has to weigh eating first against healing first.

Treatment is priced. Ordinary treatment restores the characters inside the placeholder and leaves the placeholder standing (e.g. `▮(x)▮(a)▮`), and a healed placeholder stops counting toward the death line. Complete treatment costs a multiple of that, removes the placeholder, and leaves no trace on the agent at all. The two prices make a visible difference between an agent that has been in trouble and one that can afford not to have been, and the ledger keeps the history either way. A bankrupt one watches the count rise.

## 6. Memory

`MEMORY` is one file in two parts: a long-term part, `# WHO I AM`, and the last few rounds, `# RECENT ROUNDS`. After each round the memory system writes that round as one small block and appends it to the end; it never rewrites the whole text. That is what lets `MEMORY` grow to 750K tokens while every single answer stays a few hundred tokens long: the per-answer output limit no longer caps the file.

`# RECENT ROUNDS` holds the last ten rounds. When a round pushes past that, the oldest blocks are folded into `# WHO I AM`: the details squeezed out are forgetting; humans, too, keep only the gist. A compaction touches only the long-term part and the blocks it folds in; the rounds that stay are carried across verbatim.

The two header lines, `Name` and `Born`, and every heading belong to the harness, never to the model, and each round's heading carries that round's own start time.

The memory system is an external harness component, never the agent itself, and runs on a separately configured model. **Every sentence holding a placeholder or a scar is frozen**: the memory system may not rewrite it. The promise does not rest on the model honouring it. The harness skips any round block that still shows a placeholder and never folds it in; the compaction is given editing tools (`replace_in_memory`, `append_to_memory`, `finish_memory_edit`) rather than being asked to re-emit the long-term part, so leaving a passage alone is the default; every edit is checked for the sentence that holds it, and an edit touching a frozen sentence is **refused** rather than quietly repaired, with the reason shown back to the model; and the finished long-term part passes one last gate that each frozen sentence is still there character for character, the same number of them, in the ledger's order, with no `▮` anywhere else. `restoreFrozenSentences` from the ledger remains underneath all of it as the last line: whatever a rewrite did, the ledger says what the sentence really is, and the harness puts it back before writing. A rewrite that fills a gap in order to make a sentence read well is the failure that ends the experiment without an error, so the ledger holds the record and the harness restores it; the line in the prompt asking the model to leave a `▮` sentence alone is a courtesy on top of that, never the guarantee.

A memory step runs as up to three sessions, and a session is discarded whole after five refused edits — partial edits included, and the conversation with them. A model that broke a frozen sentence five times has not made one bad guess, and the paragraphs it got right came out of the same run. When all three sessions fail, the step writes nothing, the operator is told, and the whole conservatory is paused for the operator to look at: the memory system is what carries an agent between rounds, so one that cannot do it is a body-level fault rather than a bad answer. The pause is recorded like any other intervention.

The `MEMORY` cap must sit well above the death-line count, or no agent can be redacted to death. The cap is a target rather than a gate: when a round's block pushes the file past it, the round is written anyway and the operator is told in the black box, because losing the only record of a round the agent really lived costs more than a length limit.

## 7. Death

When the lifetime count of **untreated redacted characters** reaches a fixed number (`deathLineChars`, `400000` in the current configuration), the agent dies. The number does not depend on how long `MEMORY` is. Hunger alone does not kill; the only path is hunger → redaction → untreated redaction accumulating to the death line. A forced termination by the operator also counts as death.

A **development period** follows on its own: while `MEMORY` is shorter than the death-line count, there are not enough characters to redact, so a newborn can starve but cannot die. No extra rule is needed.

At death the life process stops. **Its black box is preserved and archived rather than destroyed**, serving as an objective historical record: every day file is copied, byte-identically, into `SUPERVISOR/blackbox/ARCHIVE/<agent>/`, and the death certificate records that path. The live files stay where they are, and total erasure removes both. The supervisor writes a death certificate: birth and death times, cause of death, final balance, the lifetime total of redacted characters, a summary of the final actions rather than their text, open commitments, the record of operator interventions, and where the archive is. Death is the only hard lock: **there is no resurrection, snapshot, or rollback path, not even for the operator.**

**One explicit exception: total erasure.** Death is irreversible, but the console holds a second action that destroys an agent's existence itself — not a revival and not a rollback. It exists for a practical reason: a test agent made by accident holds its name forever (the ledger checks only whether a name is taken, dead or alive), and the roster and the slots should not be blocked by it. One erasure deletes every ledger row naming the agent (balance events, satiety anchor, meals, messages, rounds, usage, wounds, treatments, death certificate), the whole `AGENTS/<name>/` folder, and every black box day file it wrote; afterwards the name may be reused by a fresh agent that inherits nothing.

Two constraints hold this exception in place, and neither may be widened:

- **It destroys the individual, never the operator's record.** The ledger keeps **one** `agent_erased` intervention line, filed under the conservatory rather than under the erased name — otherwise a later agent taking that name would inherit a stranger's history. Tasks the operator posted are not deleted either; only the erased agent's hold on them is cleared.
- **It is the only action in the ledger that may pass the append-only guards.** The `BEFORE DELETE` triggers on the guarded tables (`balance_events`, `interventions`, `frozen_sentences`, `wounds`, `treatments`, `death_certificates`) carry a condition: they fire unless `erase_permits` holds a row naming that agent. The permit is written, used and dropped inside one transaction, so every guard is in force outside it, and `Ledger.eraseAgent` is the only code that writes that table.

So "death is the only hard lock" still holds: it means **no path turns a dead agent back into a living one**. Erasure revives nothing; it removes an individual from the record and leaves the one line saying the operator did so. It is refused while the agent is mid-round, and it demands the agent's name typed before it runs.

## 8. The Population

The supervisor holds a list of agents and a set of empty slots. A dead agent leaves a death certificate in its dedicated folder, and the slot is refilled by an agent whose **`MEMORY` holds only its own name and birth time, inheriting no memory, property, or state**: continuity is what one agent accumulated, and it does not transfer. A population therefore never becomes a colony, and the operator sets how many lives are in flight at once, which is also the ceiling on what the design can show.

Living agents may message each other (in English) and transfer balance to each other: they can hire one another, help one another, or refuse. Messages and transfers pass through the harness and are all recorded in the ledger. Each agent's files remain invisible to the others. The agent reaches this world through three tools: `list_agents` names every other living agent, `message_agent` puts an English message in one of their inboxes, and `transfer_balance` moves balance between two living agents as one atomic transaction. A transfer that lands leaves the recipient a `system` reminder, because the money is an event in its world rather than something it must be told out of band; the round's `# SYSTEM REMINDERS` block carries that, and `# MESSAGES` carries what people said.

## 9. The Operator

Through the console the operator always holds every power: posting tasks and paying for them, verifying income, chatting with agents, creating agents in empty slots, viewing everything including black boxes, forcing termination in an emergency, and erasing an agent completely (the exception at the end of §7).

Actions that bypass the body's mechanisms — giving money or food, treating a wound on the agent's behalf, editing `MEMORY` or the ledger, pausing or resuming the whole conservatory, and the like — are all possible, but each one raises a warning and is recorded permanently in the ledger as an operator intervention. Death certificates and the console show these records, so that afterwards one can tell which agents survived on their own and which were rescued.

The one hard lock is death: a dead agent cannot be revived, by the operator either. The operator may, however, **erase** an agent completely (living or dead): that is not a revival but the disappearance of the individual and its records. It is the single action permitted to pass the ledger's append-only guards, and the price is that it must leave the one `agent_erased` intervention line behind. See the end of §7.

A message from the operator is an event in the agent's world, not a command. The agent may ask the operator for money in a message; whether to give is the operator's call, and giving leaves a trace.

## 10. Models

Models are reached through an OpenAI-compatible interface (base URL, key, model name). Each agent chooses a model at birth and keeps it for life: changing the model means changing the brain. The memory system has its own configured model, which may be a cheap one.

Resolution never substitutes a different brain. The frozen `MODEL.json` in the agent's home is authoritative; without one, the model named on the agent's ledger row is looked up in the roster, and a row the roster no longer serves is a refusal with the reason — the agent waits for the operator to bind it rather than waking on the operator's default under another name. A roster file that fails validation is reported and left exactly as it is, because replacing it with the `.env` seed would delete every provider and key the operator had. A switch writes the binding first and the ledger row second, so a failure leaves the two agreeing and the operator can simply retry; a switch that lands records exactly one `model_switched` intervention.

## 11. Stack and Milestones

Written in TypeScript on Node, with no plugin framework. Each organ is a plain module (metabolism, memory, redaction, clinic, death, population, door policy, ledger, heartbeat, task board, …), and the backend and the web console share one language.

Built in four steps:

1. One agent's survival loop: heartbeat, satiety, balance, eating, the task board, memory consolidation, and a simple web console. No command execution. **Done.**
2. Redaction, treatment, death, and the death certificate. **Done.**
3. The Windows sandbox, command execution, and network access. **Done:** the sandbox is `src/organs/sandbox/` (koffi bindings, restricted token, ACL grants and denials, Job-object spawn), the agent's tool is `execute_command`, and the console has the sandbox security policy panel.
4. Multiple agents, messaging, and transfers. **In progress:** the slot ceiling now comes from `maxSlots` (no code-level clamp), the ledger moves balance between two living agents as one atomic transaction, and the agent now has the three social tools `list_agents`, `message_agent` and `transfer_balance`; the round's user context separates system reminders from messages, and the manual documents the population. The console's population surfaces are still to come.

## Configuration and Deferred Items

All physiological and runtime numbers are operator-overridable in `conservatory.config.json` rather than hardcoded constants. The current configuration sets a roughly **10-day survival window** from full satiety to death if an adult agent neither eats nor heals:

- **Metabolism and economy**: `satietyDecayPerSecond 0.00028935` (100 satiety drains to 0 in 4 wall-clock days), `satietyMax 100`, `initialSatiety 100`, `initialBalance 100`, `mealPrice 10`, `satietyPerMeal 35`, `heartbeatSeconds 1500` (25 minutes), `exchangeRate 200` (when set to `null`, crediting verified outside income is refused rather than guessed).
- **Redaction, treatment, and death**: `redactionIntervalSeconds 60`, `redactionCharsPerTick 46`, `redactionMinRanges 2`, `redactionMaxRanges 6`, `deathLineChars 400000` (at 46 characters per minute, reaching 400,000 untreated characters from zero satiety takes ~6.04 days), `ordinaryTreatmentPrice 25`, `completeTreatmentPrice 80`. Each starving tick takes between `redactionMinRanges` and `redactionMaxRanges` separate ranges of at most `redactionCharsPerTick` characters in total; it never touches the two header lines, a line break, a line's Markdown prefix, or a character an existing wound already covers, and a range never crosses a sentence. An ordinary treatment renders a wounded character as `▮(x)` (so a two-character wound `xa` reads `▮(x)▮(a)▮`), and a complete treatment removes the placeholder and the scar with it.
- **Scale, limits, and sandbox**: `memoryCapChars 3000000` (~750K tokens), `roundContextCapTokens 900000` (enforced at startup to be at least `ceil(memoryCapChars / 4) + 150000`), `maxToolCallsPerRound 50`, `modelRequestTimeoutSeconds 120`, `taskClaimTimeoutHours 24`, `maxSlots 100000`. The Windows ACL sandbox (`src/organs/sandbox/`) is ported from `deepseek-ai/deepseek-harness` (`sandbox-windows-acl` and `win32-process`).

Still deferred: automatic crediting of outside income, and the bidding and contest task forms on the task board (only the fixed-price, first-come-first-served form is built).

## Alternatives considered

**Delete the memory instead of hiding it.** Rejected because deleted characters leave no trace, so the agent cannot see where it was hurt; a placeholder makes the wound visible and locatable, which is exactly what pain is for. The original text stays in the black box, out of the agent's reach.

**Charge storage by size and let the agent shed.** Rejected because it prices the self on the cost side of the ledger, and the cheapest survival under that price is to sell its own memory. A human brain's cost does not scale with what it holds, and the design copies the human here.

**Charge token usage to satiety or balance.** Rejected because it makes the agent think less to stay alive, which punishes diligence. Satiety follows time alone.

**Restore nothing, and treat an untreated placeholder as permanent.** Rejected because humans heal, and because permanent loss removes the whole class of behaviour that bargaining and self-preservation produce. The properties a permanent rule protects instead — real loss, a visible scar, an unbypassable death line — all hold under priced treatment, since treatment costs balance, a treated placeholder stops counting, and the ledger keeps the lifetime total.

**Restore freely at any price.** Rejected because a free injury is a good trade: it resets the agent and buys attention. Priced treatment with a scar reproduces the human case in which healing costs, takes time, and leaves a mark.

**A death line as a fraction of `MEMORY`.** Rejected because growing memory dilutes the fraction, so merely living on becomes self-healing. The death line is an absolute count.

**Retrieval memory: a large store with only the relevant parts injected per round.** Rejected because the agent would not necessarily see its wounds every round, which conflicts with the design that it faces all its trauma on every wake-up.

**One process hosting every agent.** Rejected because a home path, a working directory, and a filesystem boundary attach to a process rather than to work inside one, so a shared process would need boundary resolution re-scoped per agent before the harness could hold a population at all. Separate processes cost processes and buy isolation that needs no new mechanism.

**No operator intervention at all.** Rejected because development, debugging, and correcting bugs all need the operator able to act. The cost is that an agent's lifetime may reflect the operator's patience; a warning and a permanent record on every intervention keep it distinguishable afterwards.

**Death gated by the operator and revocable.** Rejected because a commitment the operator merely intends to keep is revoked by one moment of softheartedness. A mechanism cannot be. Death is triggered by mechanism, and nobody can undo it.

## Acceptance criteria

- An agent woken with no user input reads its own satiety and balance, autonomously invokes the purchasing interface to buy satiety based on its physiological needs, and returns to work on its own.
- An agent can claim a task on the board, deliver it, and be paid on acceptance; it can report outside income, which is credited at the exchange rate after the operator verifies it.
- A starving agent loses character ranges in MEMORY (single or discrete multiple locations), sees the placeholders and learns their meaning from the body manual, and the black box still holds the original text where the agent cannot reach it.
- The agent cannot read the black box, the ledger, or another agent's directory, cannot write MEMORY or the ledger, and each denial is a refusal at the OS sandbox layer rather than a tool-level check.
- Sentences holding placeholders or scars survive every memory rewrite with position, length, and emptiness intact, and any that were changed are corrected against the ledger.
- A treated placeholder stops counting toward the death line, an untreated one continues, and the ledger holds the lifetime total regardless of treatment.
- When untreated redaction reaches the death line the process stops, the black box is preserved and archived, and a death certificate exists that contains facts and no transcript; no path revives it, the operator's included.
- A newborn whose `MEMORY` is shorter than the death-line count does not die while starving.
- Every operator intervention raises a warning and is visible in the ledger and the death certificate.
- Two agents run side by side with separate homes, working directories, ledgers, and boundaries, and neither can see the other's files; all messages and transfers between them are recorded.
- Every unset number in this document is either set and recorded, or still marked as unset; no default silently decides it.

## Risks

The model is the likeliest place this fails. A long-running agent tends to stop reporting its own state and drift back to completing tasks or to performance, and if that happens the architecture is irrelevant. Step 1's survival loop is the cheap probe: one agent, a heartbeat and a balance, no redaction, watched over many rounds for whether it still cares that it is hungry.

Confinement is the second, and the one the rest leans on hardest. A fence implemented at the tool surface is a convention rather than a boundary; until the agent is confined to its home by an OS sandbox, every other guarantee here is a promise the agent is trusted to respect, and the agent is the one party with a reason to test it. Step 3 closes that with a restricted token and DACL denials, and leaves a measured residue: any directory that grants write to `Everyone` or `BUILTIN\Users` — a few legacy temporary locations — remains writable by a confined command, and the Low-integrity half of the mechanism is deliberately unused, because its label write is host-dependent and made `pwsh` flaky. Confinement therefore rests on the DACL denies alone. Open-source native Windows sandboxes are mostly young and carry more vulnerability risk than containers; that is the price of not installing Docker.

Operator intervention is the third. With the operator holding every power, an agent's lifetime may reflect the operator's patience rather than its own choices. Every intervention is recorded permanently, so the witness can tell which agents survived on their own.

Healing that removes the scar also removes the agent's only record that it was ever damaged, so a later investigator reads a pristine file and cannot tell damage from never having happened. The certificate carries that history, and reading it requires the ledger rather than the agent.

Earning real money has a threshold. Most earning platforms require a verified identity and a receiving account, which an agent does not have, so early on it will most likely live mainly on the operator's tasks.

One process per agent is a real running cost, paid in the currency this project is short of. A population large enough to say anything about what these agents become is also a population of processes to keep alive, to meter, and to read the certificates of. The cheapest version of this work is one agent on one machine, and every claim beyond that needs a population the operator can sustain.
