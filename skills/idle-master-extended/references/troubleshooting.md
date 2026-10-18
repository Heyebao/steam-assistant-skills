# Idle Master Extended troubleshooting

Read only the section relevant to the observed failure.

## Helper exits when an app header image is unavailable

Known source pattern in `steam-idle Source\steam-idle\frmMain.cs`:

```csharp
picApp.Load("http://cdn.akamai.steamstatic.com/steam/apps/" + appid + "/header_292x136.jpg");
```

Some app IDs return HTTP 404 for this cosmetic image. An unhandled `PictureBox.Load` exception can terminate `steam-idle.exe` even though Steam idling itself is otherwise possible.

Preferred repair:

- Remove the remote image load, or wrap it in non-fatal exception handling and leave the image blank on failure.
- Do not treat image availability as a prerequisite for idling.
- Build for the original architecture and retain the matching `Steamworks.NET.dll`.
- Back up the installed `steam-idle.exe` before replacement.
- Test with an app known to have a missing header image (2396990 was one observed case) and verify the helper remains alive for at least 15 seconds.

## Fast mode displays but only one helper runs

The legacy settings may contain both `fastMode=true` and `OneThenMany=true`. Main logic can evaluate `OneThenMany` first, forcing a long-playtime game to idle alone even while the settings page appears to show Fast mode.

With user authorization, save Fast mode once so the effective values become:

```text
OnlyOneGameIdle=false
OneThenMany=false
fastMode=true
IdlingModeWhitelist=false
```

After saving, allow a short transition, then compare the UI `正在运行` value with the live `steam-idle.exe` count.

## API, CDN, and proxy symptoms

- A Steam API or badge-page refresh failure may prevent reliable remaining-game/card statistics without stopping an already-running helper.
- A CDN image 404 can crash an unpatched helper but is not itself proof that Steam idling failed.
- Inspect proxy logs read-only and summarize the destination and error class. Avoid reproducing IP addresses, tokens, cookies, or full sensitive log lines.
- Do not restart merely because the interface text has not changed.

## Transition versus persistent failure

Transient states include `读取徽章状态中`, `加载下一个游戏`, and a brief helper-count mismatch. Recheck after a short delay.

Treat the state as persistent when the main window remains responsive but:

- it says `无游戏运行` while games remain,
- it continues to report a running game while no helper exists, or
- the helper repeatedly exits after launch.

Follow the active authorization: either notify the user for a manual restart or perform a narrowly scoped restart when explicitly allowed.

## Signed-out state after restart

If the program shows `Idle Master未登录到Steam`, helpers will normally remain absent. Ask the user to log in manually. Never restore the session from a pasted cookie or token.

## Steam Invisible presence

`Invisible` in Friends & Chat is a presence choice, not Offline Mode. It may make the account appear offline to friends while keeping online features available, but it does not authorize changing profile privacy and should not be described as hiding every form of game activity.

When explicitly requested:

1. Read the current Friends & Chat presence.
2. Select `Invisible` / `隐身`.
3. Verify the presence indicator.
4. If monitoring includes presence, report when Steam reconnects in another state; reapply only if the automation explicitly authorizes it.
