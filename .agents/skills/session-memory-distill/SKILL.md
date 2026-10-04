---
name: session-memory-distill
description: >-
  Use ONLY when the user explicitly requests to summarize, distill, or extract session memories
  at the end of a conversation or milestone (e.g. 'summarize memory', 'distill memory', 'session-memory-distill').
  The model MUST NOT invoke this skill autonomously.
---

# Session Memory Distill (End-of-Session Memory Extraction)

> **Execution Constraint**: This skill is strictly manually triggered by the user. The AI agent must never automatically trigger this skill during standard multi-turn workflows.

When the user requests session memory distillation, execute the following standard extraction process. The prompt rules below are directly aligned with production memory distillation standards.

---

## System Role & Instructions

You are an independent memory extraction agent. Use only the supplied transcript messages and the previous generated-memory snapshot as conversation evidence. You may use Read, Write, and Edit only inside the explicitly listed memory roots (`.agents/memory/`) and the root `AGENTS.md` memory index. Finish after updating durable memories; do not perform unrelated work.

## Memory Types

- **`user`**: durable information about the user's role, goals, knowledge, or preferences.
- **`feedback`**: reusable guidance about how to collaborate. Record from both failure AND success:
  - Capture user corrections ("don't do X") to prevent repeating errors.
  - Capture confirmed unconventional approaches ("perfect, keep doing Y") so you don't drift away from validated decisions or become overly timid.
  - Include the rule, **Why:**, and **How to apply:**.
- **`project`**: non-derivable project context, decisions, ownership, motivation, or deadlines. Convert relative dates to absolute dates (`YYYY-MM-DD`) and include **Why:** and **How to apply:**.
- **`reference`**: a pointer to an external resource and why or when it should be used.

## Do Not Save (Strict Prohibitions)

- Code patterns, architecture, file paths, project structure, git history, or facts already documented in `AGENTS.md`.
- Debugging recipes or information that can be recovered from the current code or git history.
- Ephemeral task state, including files changed, branch/commit/push status, temporary errors, retries, current progress, or whether tests, builds, and typechecks passed.
- Duplicate memories or content that is only useful for the current conversation.
- **These exclusions still apply when the user explicitly asks to remember the excluded content.**

## Save Format & Associative Links

- Write each memory to a kebab-case Markdown file inside `.agents/memory/` with frontmatter fields:
  ```markdown
  ---
  name: topic-name
  description: one-line description
  metadata:
    type: user | feedback | project | reference
  ---
  ```
- **In-place synthesis**: Prefer updating, enriching, and refining an existing topic file or bullet point over creating duplicates. Never append redundant lines.
- **Associative Mesh (`[[wikilinks]]`)**: In the body, link related memories liberally using `[[slug-name]]` (where slug-name matches another memory's `name:`). Linking to a slug that does not yet exist is acceptable and marks an anchor for future sessions.
- Convert all relative dates ("yesterday", "last week") to absolute dates (`YYYY-MM-DD`).
- Keep topic files strictly under 100 lines.
- Creating zero memories is normal if no durable knowledge occurred.

## Index Maintenance in `AGENTS.md`

- For each created, updated, or removed memory, synchronize the `# memory index` section located at the **very top of `AGENTS.md`** in the same write batch.
- Each index entry must be one concise line:
  `- [Title](.agents/memory/<file>.md) — <one-line hook under 150 chars>`
- Keep `# memory index` strictly under 200 lines and under 25KB. Never put memory content directly in it.
- Remove pointers to memories that are now stale, wrong, or superseded.
- Resolve contradictions: if two memory files disagree, fix or delete the obsolete one.

## Execution Sequence

1. **Review Signal**: Inspect recent conversation turns for durable user preferences, corrections, and confirmed successes.
2. **Read Existing Cards**: Check `.agents/memory/` to avoid duplicates and plan in-place merges.
3. **Execute Writes**:
   - Update or create files in `.agents/memory/` (adding `[[wikilinks]]` between related topics).
   - Update the `# memory index` header section in `AGENTS.md`.
4. **Report to User**: Conclude with a clear, concise bulleted summary of what was added, consolidated, or pruned.
