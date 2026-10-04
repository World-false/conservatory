---
name: reference-windows-acl-sandbox
description: Windows ACL restricted-token sandbox blueprint for Step 3, plus the host constraints verified while porting it
metadata:
  type: reference
---

- **Location**: `I:\windows-acl-sandbox` (external clone on this machine, still present 2026-10-04). The in-repo `references/` folder is **empty** — do not look for the reference there.
- **Origin**: Extracted on 2026-10-04 from `deepseek-ai/deepseek-harness` (`sandbox-windows-acl`, `win32-process`). Licensed under MIT.
- **Core Mechanism as shipped upstream**:
  - Windows native `CreateRestrictedToken` (`WRITE_RESTRICTED`) with the token lowered to Low integrity (`WinLowLabelSid`).
  - Directory DACL edits via `SetNamedSecurityInfoW`, using capability SIDs derived deterministically from workspace paths (`workspaceWriteSid`).
  - Child processes spawned through `CreateProcessAsUserW` inside a kill-on-close Job Object, entirely through `koffi`.
- **Verified while porting it into Conservatory (2026-10-04, this host)** — the upstream mechanism does NOT transfer unchanged:
  - **The Low-integrity half is host-dependent and was dropped from the command path.** Writing the mandatory label is a SACL write: on this machine it is refused under the project tree (`I:\...`, Win32 5) yet *accepted* inside the user's own temp directory, while `SetTokenInformation(TokenIntegrityLevel, Low)` on the restricted token always succeeds. So the same command would run at two different integrity levels depending on where the workspace lives, and a Low child under a restricted token is exactly where `pwsh` intermittently died at load with `STATUS_DLL_INIT_FAILED` (0xC0000142). Consequence: never lower the token unless the label write actually succeeded in the same run, prefer determinism over the layer when tests and production would otherwise differ, and beware an idempotency shortcut that "skips because the DACL is already correct" and thereby reports a label success it never performed.
  - **`WRITE_RESTRICTED` binds writes only.** A DENY ACE naming a restricting SID hides *reads* only under a plain restricted token (`LUA_TOKEN | DISABLE_MAX_PRIVILEGE`, no `WRITE_RESTRICTED`), where every access is checked twice. That variant is what makes `SUPERVISOR/` and other agents' homes invisible to the agent's commands while leaving the supervisor untouched.
  - **A restricted PowerShell 7 needs three SIDs in the restricting list**: `Everyone` (without it pwsh dies in `BCrypt.dll` init and ETW registration), `BUILTIN\Users` (its own libraries), and `NT AUTHORITY\RESTRICTED` / S-1-5-12 — Windows already grants `RESTRICTED` `ReadKey` on `HKCU\SOFTWARE\Policies`, and without it pwsh aborts inside `GetConfigurationNameFromGroupPolicy`.
  - **`cmd.exe` parses its own tail after `/c`.** A CommandLineToArgvW-quoted command line reaches it with the escaped quotes intact, so the shell echoes the text instead of running it. Pass the command line raw for cmd, argv-quoted for pwsh.
  - **Residual write surface**: any directory that grants write to `Everyone` or `BUILTIN\Users` (a few legacy temporary locations) stays writable; system directories, the project tree, `MEMORY` and `SUPERVISOR/` do not.
- **Why & How to apply**:
  - Step 3 sandbox implementation completed and verified on 2026-10-04 (206/206 tests passing).
  - Port only the Win32 token/ACL primitives through `koffi`; never adopt the Cordis plugin framework or the harness wrappers.
  - Probe the host's privilege preconditions before trusting any part of the mechanism; see [[feedback-development-rules]].
  - Link [[user-profile]].
