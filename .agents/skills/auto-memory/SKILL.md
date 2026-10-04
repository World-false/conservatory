---
name: auto-memory
description: >-
  Use this skill automatically whenever the user expresses personal preferences, workflow habits,
  tooling constraints, gives direct behavioral critique/feedback, or validates an unconventional approach.
  Captures durable user profile and feedback rules into .agents/memory/ and updates the # memory index
  at the top of AGENTS.md immediately.
---

# Auto Memory (Lightweight Real-time Preference Capture)

Use this skill automatically during conversations when the user states durable preferences, work habits, corrects interaction behavior, or explicitly confirms that an unusual strategy was the right call.

## Trigger Scenarios (Autonomous Model Decision)
- User specifies local environment or tool constraints (e.g., hardware capabilities, forbidden APIs, shell preferences).
- User provides behavioral feedback or collaboration rules (e.g., ask instead of guessing, restrained verification, communicate before editing).
- User validates a non-obvious approach ("yes exactly", "that refactor structure was the right call") — record successes so you do not drift into excessive caution.
- User expresses long-term workflow preferences for how tasks should be executed.

## Execution Procedure

1. **Classify the Memory Item**:
   - `user`: Information about user's role, environment, knowledge, hardware, or personal preferences.
   - `feedback`: Reusable guidance about how to collaborate. Record from both failure AND success:
     - Negative corrections: What to avoid and why.
     - Positive validations: Non-obvious approaches that worked.
     - Always structure with the rule, **Why:**, and **How to apply:**.
     - Use `[[slug-name]]` to link to related memory topics.

2. **Locate Target Memory File**:
   - For user profile / environment: update `.agents/memory/user-profile.md`.
   - For feedback / behavioral rules: update or append to `.agents/memory/feedback-development-rules.md`, or create a focused `.agents/memory/feedback-<topic>.md` if it represents a major distinct domain.

3. **Format Standards & In-Place Synthesis**:
   - **Synthesize and update in-place**: When new feedback or preferences overlap with existing entries, enrich and refine the existing bullet point instead of appending duplicate or semantically redundant lines.
   - File frontmatter must specify `name`, `description`, and `metadata.type` (`user` or `feedback`).
   - Keep topic files strictly under 100 lines.
   - Do NOT save ephemeral task details, current bug traces, or one-off code facts.

4. **Update `# memory index` at the Top of `AGENTS.md`**:
   - Locate the project root `AGENTS.md`.
   - If a new memory file was created or an existing file's hook needs updating, update the `# memory index` section located at the **very top of `AGENTS.md`**.
   - Each index entry must be strictly one line:
     `- [Title](.agents/memory/<file>.md) — <one-line hook under 150 chars>`
   - Never write full memory content into `AGENTS.md`; only write the link and one-line hook.
   - Preserve all existing content under the rest of `AGENTS.md`.
