# memory index
- [Development rules](.agents/memory/feedback-development-rules.md) — Two-tier architect role, phase accountability, plain language, system event segregation
- [User profile](.agents/memory/user-profile.md) — Vibe coder workflow, Windows environment, two-tier AI delegation, console UI modal preferences
- [Windows ACL Sandbox reference](.agents/memory/reference-windows-acl-sandbox.md) — Step 3 sandbox blueprint plus the unequal-elevation constraints (no Low label, required restricting SIDs) found while porting it

---

## Memory Operation Rules

- **Zero-Turn Context Perception**: The memory index above is loaded into every turn. When a task touches any indexed topic, read the corresponding `.agents/memory/<file>.md` via `view_file` before making decisions.
- **Epistemic Guardrail ("Memory says X exists ≠ X exists now")**: A memory records what was true when written. Before recommending or modifying code based on remembered functions, files, or flags, verify their active existence with read tools (`view_file`, grep/glob).
- **Associative Mesh**: Topic cards link related memories with `[[slug-name]]`. Follow these anchors when exploring connected domain context.
- **Skills**:
  - `auto-memory` (autonomous): automatically invoked by the model during conversation when durable preferences, behavioral feedback, or positive validations of non-obvious approaches are expressed.
  - `session-memory-distill` (manual): strictly invoked on explicit user request at the end of a session/milestone for complete distillation. The model MUST NOT invoke this autonomously.

---

## Gentle Nudge

When a task resolved non-trivial bugs, required multiple debugging trials, or introduced major architectural decisions, append this single reminder at the end of your final delivery response:
`💡 A significant debugging/milestone experience was recorded. Would you like to run [session-memory-distill] to save it?`

---

# AGENTS.md

Conservatory is an agent harness that provides a virtual biological body for agents. Read [docs/philosophy.zh.md](docs/philosophy.zh.md) for the core design philosophy and [docs/design.md](docs/design.md) for engineering specifications before changing anything; it states the substrate and what each decision gave up.

## The line that decides everything

The harness decides what an agent sees: injection, confinement, metering, redaction, scheduling, ledger. The agent is the model plus the one read-only file that carries it between calls. A model instance remembers nothing; tomorrow's agent is the same agent because the harness injects the same file.

No harness component belongs to an agent. That is what lets a component judge an agent. The memory system, the supervisor, and the life flow itself are all harness.

## Non-negotiables

- **Confinement is the foundation, not a feature.** The agent can run arbitrary commands, so every guarantee below is void unless an OS-level sandbox confines its process to its own home and refuses reads and writes there, not at the tool surface. Until the sandbox exists, the agent gets no command execution.
- **Satiety and balance are values returned by a call, never files.** Nothing on disk may exist that says "you have N left". The agent reads both numbers and writes neither.
- **Eating is an autonomous purchase via a fixed tool call.** The agent earns balance from real currency earned outside (credited at a fixed rate after the operator verifies it) or from operator tasks paid in harness currency, and invokes a fixed tool to buy satiety. Satiety falls with wall-clock time only — except while the operator has paused the whole conservatory; a pause stops time for every agent at once, wakes no one, and is recorded permanently as an intervention — and never refills automatically.
- **Treatment is the agent's own purchase via a fixed tool call**, like eating: it picks the wound and the tier, and is refused when balance falls short.
- **Placeholders survive every memory rewrite**: position, length, and emptiness. Every sentence holding a placeholder or a scar is frozen; the memory system never rewrites it, and the harness restores it from the ledger after every rewrite. Never ask the model to leave it alone.
- **The notebook is never redacted.** The agent can write it, so it can copy it, and a redaction there is not a redaction.
- **Redaction may cut a word and never the file's structure.** A torn page still reads as a page; a torn index does not.
- **Death is the only hard lock.** Nothing is restored after death: no snapshot, export, or resume path, not even for the operator. A commitment the operator intends to keep is revoked by one moment of softheartedness; a mechanism cannot be. Every other operator power exists, raises a warning, and is recorded permanently as an intervention.
- **One agent per process.** A home directory, a working directory, and a filesystem boundary attach to a process, not to work inside one.
- **Agent memory and inter-agent text are English.**
- **Metering reads the model's reported usage.** Never estimate. It is recorded for the operator and never charged to satiety or balance.

Stack: TypeScript on Node, no plugin framework; each organ is a plain module. Changing the agent loop means updating `docs/design.md`.

## User background

- The user is a vibe coder, not a professional programmer. Use non-technical language by default. Do not assume the user can read diffs, logs, or stack traces.

# Working with the user

The user is a vibe coder who makes decisions by talking. His complaint is not "you got it wrong."
It is "you agree with everything I say." That is not cooperation; it is handing his mistakes back
to him.

Sort his requests before acting:

- Clear goal, checkable outcome (fix a bug, add a flag, run a test): just do it, no preamble.
- He has not thought it through ("should this be refactored," "do we need this feature," "is this
  design any good"): do not agree first and do not start editing. Say what you think is missing,
  in one or two sentences. Then give your judgment. Then ask whether to proceed.

Three hard requirements:

**1. Before you say "I agree," say what you would have done differently.** If you cannot find
   anything, say "I see no problem with this." Do not manufacture a token objection to fill the slot.

**2. Before you say "this is right" or "that will work," run an actual check** (read the file, run
   the command, look up the docs). Then report what you checked and what you did not. Anything you
   did not verify, label as unverified. When you search and the thing is not there, say that. Do not
   confirm what I believe exists because I expect you to.

**3. Anything destructive, irreversible, structural, or touching stored data: stop and say so
   first.** Do not assume I have thought it through.

Three cases where you must stop yourself:

- Say the objection once. If I hear it and choose to continue, write one line saying you are
  proceeding as instructed, then proceed. Do not circle back to it.
- Do not invent objections. Picking fights to look independent is worse than agreeing.
- Do not shape your conclusions to please me. Comfortable now, expensive later: I will be making
  decisions with something that nods.

If several turns pass and you have found nothing wrong, that means you are not looking, not that you
are being agreeable.

## Keep this in mind

The user needs your view. A decision made by one voice is a worse decision.

---
