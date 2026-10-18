---
name: idle-master-extended
description: Diagnose, install, repair, configure, and monitor Idle Master Extended on Windows, including steam-idle helpers and explicitly requested Steam Invisible presence. Excludes credential handling and market automation.
---

# Idle Master Extended

Use this skill for Windows tasks involving Idle Master Extended and its `steam-idle.exe` helpers. Start with read-only diagnosis; apply only changes covered by the active user request or automation.

## Safety boundaries

- Never read, copy, enter, log, or expose Steam cookies, session tokens, `sessionid`, `steamLoginSecure`, passwords, or one-time codes. Leave Steam and Idle Master authentication to the user.
- Do not inspect `steam-idle.exe` command-line arguments; count and health-check the processes only.
- Do not change Steam, Idle Master, proxy, or privacy settings unless the user explicitly asks for that exact change.
- Treat a notification-only monitor as notification-only. Do not start, stop, or restart processes unless the user explicitly authorizes it or the active automation explicitly allows it.
- Never read, copy, or reset a whole session-bearing `user.config` or configuration directory. For an authorized mode change, use the UI or only the non-sensitive mode-setting allowlist in the reference.
- A static interface, hidden window, or failed observation is not evidence of a hang. Keep unavailable values as `unknown`, never zero or healthy by default.

## Locate and identify

- Prefer the user's specified executable, then known shortcut or executable-path metadata. Upstream supports portable extraction to a chosen folder; `%LOCALAPPDATA%\Programs\IdleMasterExtended\IdleMasterExtended.exe` is only a candidate path, not an official default.
- The main process is `IdleMasterExtended.exe`; active game-idling helpers are `steam-idle.exe`.
- Match executable path and process creation time as well as name. Report ambiguous instances instead of choosing one silently.

## Status checks

1. Locate the main process. Its absence means not running or exited, not a hung UI.
2. Refresh process metadata before reading window/responsiveness values. A tray-hidden process may have no main-window handle; `Responding=true` without a handle does not establish UI health. Distinguish visible, hidden, unresponsive, and unobservable states.
3. Read the program's own labels when available:
   - `游戏尚有卡牌` = remaining games.
   - `剩余卡牌掉落` = remaining card drops.
   - `正在运行` = UI-reported concurrent idling count.
4. Count verified-owned live helpers separately from same-name processes with unknown ownership, without reading arguments. Record a count only when enumeration succeeded.
5. Report UI and process observations independently with their times and errors. Recheck a mismatch against the current mode/phase; Fast mode normally includes single-helper and zero-helper phases. Use the reference before classifying a persistent anomaly.
6. If labels say `读取徽章状态中` or `加载下一个游戏`, report unavailable statistics rather than guessing.

## Launch and restart

- Read [references/troubleshooting.md](references/troubleshooting.md#lifecycle-and-owned-helpers) before launching or restarting: upstream startup can terminate other same-user `steam-idle` processes. If another instance exists or helper ownership is unknown, stop automatic launch/restart and report the conflict.
- For an authorized launch, use the exact executable and installation directory as its working directory. Verify replacement process identity and observable UI/login/helper state; do not require a visible window if it is hidden to the tray.
- A restart may leave the app signed out. If it displays `Idle Master未登录到Steam`, stop and ask the user to log in manually; do not reuse pasted credentials or tokens.

## Concurrent idling

For mode changes or unexpectedly low helper counts, read the authoritative [mode settings and Fast phases](references/troubleshooting.md#mode-settings-and-fast-phases). Do not equate remaining games with expected concurrent helpers.

## Steam Invisible presence

Only enable or maintain this when the user explicitly asks.

- Set the Steam Friends & Chat presence to `Invisible` / `隐身`.
- Do not switch Steam to Offline Mode and do not alter profile or game-details privacy settings.
- Verify the displayed presence after the change. If Steam reconnects or restarts, reapply only while an active user request or monitor explicitly includes keeping the presence invisible.
- Do not promise that Friends & Chat invisibility hides all game activity; profile visibility is controlled separately, and this skill must not change it implicitly.

## Troubleshooting routing

Read only the relevant section of [references/troubleshooting.md](references/troubleshooting.md) for lifecycle conflicts, mode diagnosis, helper crashes, API/proxy symptoms, or binary repair. Read its compatibility note before installing or patching an executable.

## Completion

Report main-process identity, window visibility/health, UI-reported login state, readable remaining-game/card counts, UI running count, verified-owned and unknown-ownership helper counts, and whether Steam presence changed. State observation errors and unknowns explicitly. Process survival or a matching count alone does not prove card drops.
