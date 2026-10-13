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
- **Hands-On Verification Split**: He insists on doing visual/browser checks himself ("我重启后自己看") rather than walking the agent through them. Give him a concrete restart instruction and the short list of what to look at, then stop — do not re-offer to inspect the UI.
- **Task Brief Is Not the Source of Truth**: He supplies long, prescriptive specs (often written for an external runner AI) and then expects the agent to *question* them against what he actually wants. He prefers a stated objection plus a chosen option over literal compliance. Link [[project-model-config-decisions]], [[feedback-development-rules]].
- **Two-Tier AI Delegation Workflow (not always)**: User often uses this primary agent as the Architect / Spec Writer to conserve quota and guard architectural boundaries, delegating heavy/repetitive coding to an external fast Runner AI via direct, exhaustive, self-contained hand-off prompts (written in **English**, while conversation with the user stays in plain Chinese). **But he may choose "我直接实现" instead** — when he does, implement in-repo and do not push the hand-off framing. Which mode applies is his call per task, so ask rather than assuming either. Link [[feedback-development-rules]].
- **Quota-Driven Hand-Off**: When his remaining quota is tight he will say so explicitly ("你的可用额度太少了") and ask for one direct, professional, copy-pasteable prompt to send to an external fast AI, rather than having this agent self-implement then review then re-edit. Honor that: write the spec, do not fall back to editing in-repo or burning turns re-verifying. Link [[feedback-development-rules]].
- **Console UI Preferences**: Strongly dislikes edge-to-edge full-viewport horizontal stretching (lines stretching across ultra-wide monitors). Prefers centered floating modals with bounded max widths (e.g. 1100px–1120px, `max-width: 92vw`), dark dimmed/blurred backdrops (`rgba(15,23,42,0.55)` + `blur(8px)`), dual-column layouts (left category nav + right scrollable pane), and non-destructive overlays over page replacements. Link [[feedback-development-rules]].
