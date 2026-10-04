---
name: user-profile
description: User environment, vibe coding workflow, and communication preferences
metadata:
  type: user
---

- **Environment**: Windows OS, PowerShell environment.
- **Background**: The user is a vibe coder, not a professional programmer. Prefers plain, non-technical explanations by default; do not assume familiarity with raw diffs, deep logs, or stack traces.
- **Hardware & Models**: No local GPU model runtime assumed; all AI inference relies on the primary model inside the agent host.
- **Memory Workflow**: Dual-tier memory management:
  - `auto-memory` skill: auto-triggered during conversation when user states a personal preference, behavioral correction, or confirms an unconventional approach.
  - `session-memory-distill` skill: manually invoked by user at the end of a session/milestone for full incremental distillation.
- **Two-Tier AI Delegation Workflow**: User uses this primary agent as the Architect / Spec Writer to conserve quota and guard architectural boundaries, while delegating heavy/repetitive coding to an external fast Runner AI. Write direct, exhaustive, self-contained hand-off prompts with exact schemas, test requirements, and constraints instead of modifying code directly across many turns. Link [[feedback-development-rules]].
- **Console UI Preferences**: Strongly dislikes edge-to-edge full-viewport horizontal stretching (lines stretching across ultra-wide monitors). Prefers centered floating modals with bounded max widths (e.g. 1100px–1120px, `max-width: 92vw`), dark dimmed/blurred backdrops (`rgba(15,23,42,0.55)` + `blur(8px)`), dual-column layouts (left category nav + right scrollable pane), and non-destructive overlays over page replacements. Link [[feedback-development-rules]].
