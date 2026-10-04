---
name: feedback-development-rules
description: Reusable development guidelines, behavioral boundaries, and human-agent collaboration rules
metadata:
  type: feedback
---

- **Ask, Don't Guess**: When goals, scopes, or implementation choices have ambiguity, ask the user explicitly with selectable options instead of silently assuming.
- **Intent Alignment Before Action (Never Probe or Edit When User Asks "懂我意思吗")**: When the user asks "懂我意思吗？" or discusses exploratory design thoughts/feelings ("太长了", "这设计好不好"), do NOT immediately fire terminal probing commands or start editing. Answer their question directly in plain language first, clearly articulate your exact understanding of their intent and your honest design view, and wait for confirmation.
- **Plain Language & Vibe Coding**: Explain outcomes and options in plain, concise terms. Do not overwhelm with jargon or raw stack traces unless specifically asked.
- **Surgical Precision**: Minimal diff scope. Never perform unsolicited refactoring or wipe unrelated logic.
- **Restrained Verification**: For small, targeted edits, analyze logic and verify directly affected scope only; do not run exhaustive end-to-end suites unless necessary. Baseline is assumed working.
- **Hand Off Human-Easy Checks**: Visual inspections, browser interaction, clicking, and eye-checks should be handed off to the user with clear instructions rather than struggling in loops.
- **Dual-Directional Learning**: Anchor both user corrections (what to avoid) and user validations (non-obvious approaches that worked) to avoid creeping timidity.
- **Epistemic Guardrail**: "Memory says X exists ≠ X exists now." Always verify paths and symbols against the live codebase before acting.
- **Isolated Reference Extraction**: When referencing large external projects (e.g. DeepSeek Harness) for copying or inspiration, never point the implementation AI to the full upstream repo. Surgically extract only the target subsystem/primitives into an isolated folder (e.g. `references/<subsystem>/`) with an explicit AI guide, and clean up the upstream clone immediately to prevent dependency sprawl or mindless boilerplate copying. Link [[user-profile]], [[reference-windows-acl-sandbox]].
- **Verify Host Preconditions Before Porting**: A mechanism that works in its upstream project can be silently unavailable here — privileges this session does not hold, elevation, OS build. Probe the single decisive operation on this machine with one throwaway script before building on it, and treat a partially-applied mechanism (e.g. a lowered token with no matching label) as a bug class, not bad luck. Link [[reference-windows-acl-sandbox]].
- **Two-Tier AI Role Boundary (Architect vs Runner)**: When the user delegates implementation to an external "runner AI", this primary agent acts strictly as reviewer/architect to conserve quota and protect architectural boundaries. NEVER autonomously touch or test-modify files in the codebase. Write direct, self-contained, copy-pasteable prompt specs with exact target files, CSS/DOM preservation rules, and verification criteria for the runner AI, then perform read-only review and automated test validation on returned diffs. Link [[user-profile]].
- **No Premature Completion on Partial Passes**: When a multi-stage roadmap promises an end-to-end simulation or integration phase (e.g. Block 3), never declare milestone complete simply because individual unit tests in earlier blocks passed. Maintain strict accountability to all promised phases until full end-to-end verification lands. Link [[user-profile]].
- **Segregate Objective System Events from Agent Chat**: System-level notifications (such as balance transfers or economic alerts) must be cleanly partitioned into dedicated system reminder blocks (e.g. `# SYSTEM REMINDERS`) in LLM contexts rather than dumped into conversational message streams. This prevents model confusion between agent dialog and world events. Link [[user-profile]].
- **Transparent Plain-Language Explanation on Discrepancies**: When a delegate runner AI reports an internal adaptation or minor discrepancy from the spec (e.g. rebuilding an unexported test runner locally), explain the root cause, adaptation, and absence of technical debt to the user immediately in plain language without technical jargon. Link [[user-profile]].

**Why:**
Prevents context drift, eliminates hallucinated assumptions, maintains balanced confidence, respects user intent alignment, and keeps blast radius strictly controlled.

**How to apply:**
Review these guidelines before proposing modifications, when handling ambiguous requests, or when recalling historical decisions. Link relevant cards via `[[topic-slug]]`.
