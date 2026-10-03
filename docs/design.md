# Conservatory Engineering Implementation and Architecture Specification

English | [中文](design.zh.md)

> **Important Note**: This document focuses on Conservatory's **engineering architecture, mechanism interfaces, and technical implementation specifications**. For the project's foundational ontology, core thesis, and biological blueprint, please refer to the dedicated [Design Philosophy Document](philosophy.md).

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

A wake-up starts a round. The round begins with a fresh context holding only the body manual, `MEMORY`, current satiety and balance, the task board, and unread messages. The agent acts through tools; the round ends when it stops calling tools and gives a final reply. A round whose context exceeds the cap is ended by force.

A round is also ended by force when the agent asks for more tool calls than the configured per-round limit allows, or when a model request fails. The supervisor takes one immediate beat when it starts, so a living agent does not wait a whole interval for its first wake-up. If an agent's process exits unexpectedly, that is written to the black box and the next wake-up starts a new process for it; at this stage that is not death. While the operator has paused the conservatory, the heartbeat wakes no one, not even the supervisor's immediate first beat, and every claimed task's claim clock is frozen.

After each round, the memory system folds that round's experience into `MEMORY` (see "Memory"). The next wake-up is again a fresh context: the model instance remembers nothing, and tomorrow's agent is the same agent because the body injects the same memory.

### The body manual

Every round injects a fixed body manual stating that the agent gets hungry, what satiety and balance are, how to earn, the tools for eating and treatment, what placeholders mean, the death line, and that it can die. The manual belongs to the body, not to memory, and is never redacted.

The manual states rules and gives no personality. A newborn's `MEMORY` begins with only its name and birth time; who it is and what it cares about grow out of its own experience. A given persona pushes it toward performance, which is exactly what the first risk below fears.

The manual is a template, not code: `prompts/manual.md` holds its text, and the copy in the source is only the fallback for a file that is missing, empty, or unreadable. `prompts/memory_system.md` and `prompts/user_context.md` do the same for the memory system prompt and for the shape of the round's user prompt, whose four blocks — memory, body state, the task board, and unread messages — are filled into `{{memory}}`, `{{body_state}}`, `{{task_board}}` and `{{messages}}`. Templates are reread on every wake-up by default, so saving one takes effect without a restart; the console can hold them in memory instead and reload them on demand. A user context template that has lost `{{memory}}` is refused whole and the built-in template is used, because the one thing an edit must never do is silently erase the agent's past.

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

`MEMORY` is the agent's continuity. It is assembled from historical facts, redaction records, and commitments the agent has made, holding facts rather than scripted personas. The agent cannot edit it, and because it cannot edit it, it cannot copy it; a repeated read returns the same gaps.

The notebook is the agent's own private record, free to write and never injected; the agent reads it on request, and reading is free. The system guarantees that the **notebook is never redacted**.

The black box is the complete durable log, immutable, and unreachable by the agent. It serves objective post-mortem audit and the death certificate. Upon the agent's death, **the black box is archived and preserved, never cremated or destroyed**.

### The Door Policy

| Target | Reads | Writes | Only the holder changes it |
| --- | --- | --- | --- |
| MEMORY (read-only memory, injected every turn) | yes | no | supervisor |
| Notebook directory (writable, never injected, never redacted) | yes | yes | the agent |
| Black box (complete durable log, preserved post-mortem) | no | no | supervisor |
| Ledger | satiety and balance only | no | supervisor |
| Redaction and treatment operations | no | no | supervisor |
| Another agent's directory | no | no | supervisor |
| Any location outside its own home | no | no | none |

The agent can run arbitrary commands, so the door policy cannot sit at the tool surface: a command bypasses any tool-level check. An OS-level sandbox enforces it: the agent process sees only its own home, `SUPERVISOR/` and other agents' homes lie outside the sandbox, and both reads and writes are refused at the operating-system layer. The agent may use the network, because it earns outside. The sandbox is a native Windows implementation ported from an open-source agent project; which project is verified for licence and approach before work starts. **Until the sandbox exists, the agent gets no ability to execute commands.**

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

`MEMORY` is one file with a length cap. The memory system runs after each round: it writes the round's new experience in, and when the file exceeds the cap it compresses or summarises older content. The details squeezed out are forgetting; humans, too, keep only the gist.

The memory system is an external harness component, never the agent itself, and runs on a separately configured model. **Every sentence holding a placeholder or a scar is frozen**: the memory system may not rewrite it. After each rewrite the harness checks against the ledger and restores any frozen sentence that was touched — its position, its length, and the absence of content inside it. A rewrite that fills a gap in order to make a sentence read well is the failure that ends the experiment without an error, so the ledger holds the record and the harness restores it, rather than asking the model to leave it alone.

The `MEMORY` cap must sit well above the death-line count, or no agent can be redacted to death.

## 7. Death

When the lifetime count of **untreated redacted characters** reaches a fixed number (for example 2000), the agent dies. The number does not depend on how long `MEMORY` is. Hunger alone does not kill; the only path is hunger → redaction → untreated redaction accumulating to the death line. A forced termination by the operator also counts as death.

A **development period** follows on its own: while `MEMORY` is shorter than the death-line count, there are not enough characters to redact, so a newborn can starve but cannot die. No extra rule is needed.

At death the life process stops. **Its black box is preserved and archived rather than destroyed**, serving as an objective historical record. The supervisor writes a death certificate: birth and death times, cause of death, final balance, the lifetime total of redacted characters, a summary of the final actions rather than their text, open commitments, and the record of operator interventions. Death is the only hard lock: **there is no resurrection, snapshot, or rollback path, not even for the operator.**

## 8. The Population

The supervisor holds a list of agents and a set of empty slots. A dead agent leaves a death certificate in its dedicated folder, and the slot is refilled by an agent whose **`MEMORY` holds only its own name and birth time, inheriting no memory, property, or state**: continuity is what one agent accumulated, and it does not transfer. A population therefore never becomes a colony, and the operator sets how many lives are in flight at once, which is also the ceiling on what the design can show.

Living agents may message each other (in English) and transfer balance to each other: they can hire one another, help one another, or refuse. Messages and transfers pass through the harness and are all recorded in the ledger. Each agent's files remain invisible to the others.

## 9. The Operator

Through the console the operator always holds every power: posting tasks and paying for them, verifying income, chatting with agents, creating agents in empty slots, viewing everything including black boxes, and forcing termination in an emergency.

Actions that bypass the body's mechanisms — giving money or food, treating a wound on the agent's behalf, editing `MEMORY` or the ledger, pausing or resuming the whole conservatory, and the like — are all possible, but each one raises a warning and is recorded permanently in the ledger as an operator intervention. Death certificates and the console show these records, so that afterwards one can tell which agents survived on their own and which were rescued.

The one hard lock is death: a dead agent cannot be revived, by the operator either.

A message from the operator is an event in the agent's world, not a command. The agent may ask the operator for money in a message; whether to give is the operator's call, and giving leaves a trace.

## 10. Models

Models are reached through an OpenAI-compatible interface (base URL, key, model name). Each agent chooses a model at birth and keeps it for life: changing the model means changing the brain. The memory system has its own configured model, which may be a cheap one.

## 11. Stack and Milestones

Written in TypeScript on Node, with no plugin framework. Each organ is a plain module (metabolism, memory, redaction, clinic, death, population, door policy, ledger, heartbeat, task board, …), and the backend and the web console share one language.

Built in four steps:

1. One agent's survival loop: heartbeat, satiety, balance, eating, the task board, memory consolidation, and a simple web console. No command execution.
2. Redaction, treatment, death, and the death certificate.
3. The Windows sandbox, command execution, and network access.
4. Multiple agents, messaging, and transfers.

## Deferred

These values are earlier starting points, unvalidated against real behaviour, and all operator-overridable config rather than constants: satiety decay `0.05` per second, meal price `15`, satiety per meal `25`, initial satiety `100`, initial balance `100`, heartbeat interval `300` seconds, ordinary treatment `25`, complete treatment `80`, maximum slots `4`. At these values satiety falls 180 per hour, which costs about 108 balance per hour in meals; that intensity needs measuring in step 1 before it is tuned.

Still unset: the exchange rate for real currency, how many characters each starving redaction takes, the exact death-line count, the `MEMORY` length cap, the per-round context cap, the redaction selection policy (which characters a wound takes), and which open-source project the sandbox is ported from.

Step 1's temporary values: `satietyMax 100`, `memoryCapChars 8000`, `roundContextCapTokens 60000`, `maxToolCallsPerRound 50`, `modelRequestTimeoutSeconds 120`, `taskClaimTimeoutHours 24`, and `maxSlots 1` (step 1 allows one living agent); the exchange rate is still unset, so a verified income report cannot be credited at all. Step 1's task board implements the fixed-price, first-come-first-served form only; bidding and contests are not built.

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

Confinement is the second, and the one the rest leans on hardest. A fence implemented at the tool surface is a convention rather than a boundary; until the agent is confined to its home by an OS sandbox, every other guarantee here is a promise the agent is trusted to respect, and the agent is the one party with a reason to test it. Open-source native Windows sandboxes are mostly young and carry more vulnerability risk than containers; that is the price of not installing Docker.

Operator intervention is the third. With the operator holding every power, an agent's lifetime may reflect the operator's patience rather than its own choices. Every intervention is recorded permanently, so the witness can tell which agents survived on their own.

Healing that removes the scar also removes the agent's only record that it was ever damaged, so a later investigator reads a pristine file and cannot tell damage from never having happened. The certificate carries that history, and reading it requires the ledger rather than the agent.

Earning real money has a threshold. Most earning platforms require a verified identity and a receiving account, which an agent does not have, so early on it will most likely live mainly on the operator's tasks.

One process per agent is a real running cost, paid in the currency this project is short of. A population large enough to say anything about what these agents become is also a population of processes to keep alive, to meter, and to read the certificates of. The cheapest version of this work is one agent on one machine, and every claim beyond that needs a population the operator can sustain.
