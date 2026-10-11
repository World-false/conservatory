---
name: project-scale-and-memory-decisions
description: Why Conservatory runs at 1M-context scale with 750K-token memory, tool-driven memory sandbox, and offset-tracked frozen sentences
metadata:
  type: project
---

Decisions and motivations settled 2026-10-05 and 2026-10-11 around memory scale and the pain-system sentence identity design. The architecture itself lives in code and `docs/design.md`; this card records only the non-derivable *why*.

- **Scale mindset**: the user explicitly does not care about token / run cost ("钱你也不用为我担心", "搞研究不差这点钱"). Do NOT shrink memory or context budgets to save money. The model is DeepSeek V4: ~1M context window, ~384K max single output (verified via web search 2026-10-05, not from training memory).
- **Why memory uses surgical tool edits instead of full-file rewrites**: a full-file rewrite cannot emit a 750K-token (~3M-char) MEMORY under a ~384K output cap. Furthermore, hiding whole paragraphs that contain `▮` (`foldable` filter) or re-appending missing frozen sentences at the tail of `MEMORY` destroyed chronological order (`BUG_REPORT.md` #17).
- **Resolved (2026-10-11) — Frozen-sentence identity & Memory Editing Sandbox (`BUG_REPORT.md` #4/#3c/#17/#37)**:
  - **Why no inline ID tags (`[s1]`) in `MEMORY`**: Rejected so `MEMORY` stays pure natural English and the model never sees or imitates synthetic anchor tags.
  - **Why two channels (User's "coding-agent collision sandbox" mental model)**:
    1. *System channel (Redaction & Clinic)*: `frozen_sentences` in `ledger.db` tracks character `start_offset` alongside `id`, distinguishing identical sentences by position without touching `MEMORY` text and protecting UTF-16 surrogate pairs from mid-character splits.
    2. *Memory-model channel (Sentence-Lock Sandbox)*: The memory model edits `MEMORY` via tools (`replace_in_memory`, `append_to_memory`, `finish_memory_edit`). Every edit checks the enclosing sentence boundaries; if it touches any `▮` or active frozen sentence, the sandbox rejects the tool call with an explanation so the model can edit around the wounded sentence in place, then re-syncs offsets after consolidation.
  - **Why 5-refusal session rollback + 3-session global pause**: Chosen by the user (2026-10-11) because 1 retry is too strict for tool self-correction, whereas 3 failed sessions (15 refusals in one round) signal a broken memory model/prompt that must auto-pause the entire conservatory so agents do not starve while memory compaction is stuck. Link [[feedback-development-rules]], [[user-profile]].
- **Request body re-shaped**: MEMORY + BODY STATE moved into the `system` message, the task board is no longer injected (read via `list_tasks`), reminders and messages stay in `user`. Accepted side effect the user chose knowingly: a past commitment in `system` is treated as a harder constraint — the agent is less likely to renege.
