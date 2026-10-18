---
name: idle-master-extended
description: Install, launch, diagnose, repair, configure, and safely monitor Idle Master Extended on Windows, including concurrent idling, helper-process failures, and an explicitly requested Steam Invisible presence. Do not use for Steam credential extraction or market automation.
---

# Idle Master Extended

Use this skill for Windows tasks involving Idle Master Extended and its `steam-idle.exe` helpers.

## Safety boundaries

- Never read, copy, enter, log, or expose Steam cookies, session tokens, `sessionid`, `steamLoginSecure`, passwords, or one-time codes. Leave Steam and Idle Master authentication to the user.
- Do not inspect `steam-idle.exe` command-line arguments; count and health-check the processes only.
- Do not change Steam, Idle Master, proxy, or privacy settings unless the user explicitly asks for that exact change.
- Treat a notification-only monitor as notification-only. Do not start, stop, or restart processes unless the user explicitly authorizes it or the active automation explicitly allows it.
- A static window is not evidence of a hang. Require a missing process/window, Windows `Responding=false`, a failed read-only window-state check, or a persistent helper-process anomaly.

## Locate and identify

- Prefer discovery over a hardcoded username. The usual executable is `%LOCALAPPDATA%\Programs\IdleMasterExtended\IdleMasterExtended.exe`.
- The main process is `IdleMasterExtended.exe`; active game-idling helpers are `steam-idle.exe`.
- Preserve existing installation files and user settings. Back up a binary before replacing it.

## Status checks

1. Confirm the main process and main window exist.
2. Use a reliable read-only window-state or Windows responsiveness check.
3. Read the program's own labels when available:
   - `游戏尚有卡牌` = remaining games.
   - `剩余卡牌掉落` = remaining card drops.
   - `正在运行` = UI-reported concurrent idling count.
4. Count live `steam-idle.exe` processes without reading their arguments.
5. Report the UI count and actual helper count separately. A mismatch alone does not justify a restart; allow a short transition and recheck.
6. If labels say `读取徽章状态中` or `加载下一个游戏`, report unavailable statistics rather than guessing.

## Launch and restart

- Launch the installed executable with its installation directory as the working directory.
- After launch, verify a new main process and window, then check login and helper state.
- If the user explicitly asks for a restart, stop only the exact Idle Master process and its owned helpers, launch the exact executable, and verify the replacement window.
- A restart may leave the app signed out. If it displays `Idle Master未登录到Steam`, stop and ask the user to log in manually; do not reuse pasted credentials or tokens.

## Concurrent idling

For true Fast mode, the effective settings should be equivalent to:

```text
OnlyOneGameIdle = false
OneThenMany = false
fastMode = true
IdlingModeWhitelist = false
```

The settings page can display Fast mode while a legacy `OneThenMany=true` value still wins in startup logic. When the user authorizes the change, select Fast mode and save once, then verify one live helper per concurrently idled game after the transition settles.

## Steam Invisible presence

Only enable or maintain this when the user explicitly asks.

- Set the Steam Friends & Chat presence to `Invisible` / `隐身`.
- Do not switch Steam to Offline Mode and do not alter profile or game-details privacy settings.
- Verify the displayed presence after the change. If Steam reconnects or restarts, reapply only while an active user request or monitor explicitly includes keeping the presence invisible.
- Do not promise that Friends & Chat invisibility hides all game activity; profile visibility is controlled separately, and this skill must not change it implicitly.

## Troubleshooting routing

Read [references/troubleshooting.md](references/troubleshooting.md) when helpers crash, the UI/API stalls, Fast mode runs only one game, or a proxy/CDN error is suspected.

## Completion

Report the resulting main-window health, login state, remaining-game/card counts when readable, UI running count, actual helper count, and whether Steam presence was changed. Explicitly state any statistic that could not be read.
