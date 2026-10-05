---
name: project-scale-and-memory-decisions
description: Why Conservatory runs at 1M-context scale with append-only 750K-token memory, and the pending frozen-sentence identity problem
metadata:
  type: project
---

Decisions and motivations settled 2026-10-05 around memory scale and the pain-system identity flaw. The architecture itself lives in code and `docs/design.md`; this card records only the non-derivable *why* and what remains unresolved.

- **Scale mindset**: the user explicitly does not care about token / run cost ("钱你也不用为我担心", "搞研究不差这点钱"). Do NOT shrink memory or context budgets to save money. The model is DeepSeek V4: ~1M context window, ~384K max single output (verified via web search 2026-10-05, not from training memory).
- **Why memory became append-only**: a full-file rewrite cannot emit a 750K-token (~3M-char) MEMORY under a ~384K output cap, so memory is appended one round block at a time and compacted in place. The recent-rounds blocks containing a `▮` placeholder are skipped whole by a hard `foldable` filter, never shown to the memory model. (Implementation in `src/organs/memory.ts`; recorded here only for the why.)
- **Request body re-shaped**: MEMORY + BODY STATE moved into the `system` message, the task board is no longer injected (read via `list_tasks`), reminders and messages stay in `user`. Accepted side effect the user chose knowingly: a past commitment in `system` is treated as a harder constraint — the agent is less likely to renege.
- **Pending — frozen-sentence identity problem**: BUG_REPORT #4/#3c/#17/#37 are one disease — "text search as sentence identity". Diagnosed and written to `docs/frozen-sentence-identity.zh.md`; the next session must solve it, and must NOT patch the individual bugs — the fix is giving each frozen sentence a second, position-independent identity. Structural change touching `redaction.ts` + `ledger.ts`, so it needs the user's explicit go-ahead. Link [[feedback-development-rules]].
