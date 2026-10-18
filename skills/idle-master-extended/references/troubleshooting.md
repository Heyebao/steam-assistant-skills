# Idle Master Extended troubleshooting

Read only the section relevant to the task. These are diagnostic and repair instructions, not a collector or an automatic recovery implementation.

## Compatibility and source baseline

Checked 2026-10-18: the [canonical repository](https://github.com/jonas-med-ett-s/idle_master_extended#readme) is archived (2026-05-13); its last release is [v1.10.0, 2023-03-06](https://github.com/jonas-med-ett-s/idle_master_extended/releases/tag/v1.10.0). The source links below refer to `develop`, not proof of an installed binary's behavior. Match source commit, build and executable provenance before applying a patch; preserve the project's [GPL v2 license](https://github.com/jonas-med-ett-s/idle_master_extended/blob/develop/LICENSE) and change provenance in any distributed patch package.

Upstream's [installation guide](https://github.com/jonas-med-ett-s/idle_master_extended/wiki/Get-started) uses a ZIP extracted to a chosen directory. Do not assume an installer location or run from inside the ZIP. Avoid launching as administrator to work around an unidentified connection problem.

## Lifecycle and owned helpers

[Upstream `StartIdle`](https://github.com/jonas-med-ett-s/idle_master_extended/blob/develop/Source/IdleMasterExtended/frmMain.cs) terminates same-name helpers owned by the current Windows user, including ones outside the current instance. Its normal per-game shutdown tracks a `Process` object in [Badge.cs](https://github.com/jonas-med-ett-s/idle_master_extended/blob/develop/Source/IdleMasterExtended/Badge.cs). External process scoping cannot remove the executable's broader startup behavior.

- Before automatic launch/restart, stop if there is another main instance, unrelated same-user helper, or unknown helper ownership. Report the conflict; do not promise isolation without verified executable behavior.
- Prove a helper's ownership using creation-time identity, executable path and a captured parent/launch relationship. Name alone, current-user ownership, or a current parent PID alone is insufficient. Never inspect helper arguments.
- Exclude proven other-user helpers from this instance's counts and never stop them. They are outside the upstream current-user cleanup scope; unknown ownership must not be treated as proven other-user ownership.
- For an authorized restart, request normal close of the exact main instance and wait for it and tracked helpers to exit. Use forced termination only within the authorization and only for identities still matching the captured PID, creation time and path. Do not kill by wildcard or image name.
- Follow explicit recovery limits. If unspecified, attempt at most one authorized restart for an incident, verify the new state, and notify on failure instead of looping. Unknown state, signed-out state or repeated failure must stop automatic recovery.

## Mode settings and Fast phases

This is the single mode-setting allowlist: `OnlyOneGameIdle`, `OneThenMany`, `fastMode`, `IdlingModeWhitelist`. Read, snapshot or change only these non-sensitive values for an authorized mode task; never dump or copy the full configuration. Prefer the settings UI. If values cannot be safely observed, report them as unknown.

| Mode | OnlyOneGameIdle | OneThenMany | fastMode | IdlingModeWhitelist |
| --- | --- | --- | --- | --- |
| Single game | true | false | false | false |
| Many then one | false | false | false | false |
| One then many | false | true | false | false |
| Fast | false | false | true | false |
| Whitelist | false | false | false | true |

Legacy combinations may conflict: the [settings form](https://github.com/jonas-med-ett-s/idle_master_extended/blob/develop/Source/IdleMasterExtended/frmSettings.cs) displays Fast before the other flags, while startup checks single-game and One-then-many first. A displayed Fast selection therefore does not prove an effective Fast configuration. With authorization, select Fast and save once: upstream clears all four flags before setting the chosen one. Verify the resulting phase and helper state; preserve unrelated settings. Do not reset the configuration directory.

[Fast mode](https://github.com/jonas-med-ett-s/idle_master_extended/blob/develop/Source/IdleMasterExtended/frmMain.cs) alternates between simultaneous idling for about five minutes, a stopped wait of about five seconds, and eligible games idled individually for about five seconds each. Refresh/network work may add time. A single eligible game can also legitimately use one helper. Zero or one helper is not by itself a mode failure; observe the phase before comparing counts.

## Observation failure versus persistent anomaly

Record observation time, visibility, response result, mode/phase, UI counts, verified-owned helper count and observation errors. Do not infer zero from a failed enumeration or infer a valid statistic from a hidden/loading label.

- Tray hiding is normal: upstream uses `Hide()` when minimized to the tray. [MainWindowHandle](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.mainwindowhandle) can then be zero. Refresh cached process metadata; [Responding](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.responding) returns true if there is no main-window handle, so it cannot establish health in that case.
- `读取徽章状态中`, `加载下一个游戏`, a phase transition and a brief count mismatch require another observation. A failed UI/window read means observation unavailable, not a hang.
- Require at least two fresh observations separated by a delay appropriate to the known phase before reporting a persistent UI/helper anomaly. If phase or its expected completion cannot be established, report uncertainty and do not automatically restart.
- Outside a normal transition, remaining games plus `无游戏运行`, a running-game label plus zero helpers after successful enumeration with ownership resolved, or repeated helper exits may establish an anomaly. Keep a paused, completed or signed-out state distinct; check only the UI for authentication state.
- A refreshed `Responding=false` result establishes an unresponsive UI observation, not failed card drops. Recheck before escalation. A missing main process means not running/exited, not hung.

Follow the active authorization: notify only, or perform the scoped recovery above. An unchanged screen is never sufficient evidence.

## Helper exits when an app header image is unavailable

Current `develop` uses [`steam-idle Source/steam-idle/FormSteamIdle.cs`](https://github.com/jonas-med-ett-s/idle_master_extended/blob/develop/steam-idle%20Source/steam-idle/FormSteamIdle.cs), with a synchronous image load in its constructor:

```csharp
picApp.Load($"https://cdn.akamai.steamstatic.com/steam/apps/{appid}/header_292x136.jpg");
```

Match the actual source version; do not apply a historical `frmMain.cs`/HTTP snippet's file path to current `develop`. An unavailable cosmetic image can throw before the helper enters its normal application loop; establish the exception class before attributing an exit to this cause.

Preferred repair:

- Remove the cosmetic remote load, or bound it and handle its failures without terminating idling. Leave the image blank on failure.
- Do not treat image availability as a prerequisite for idling.
- Test offline with fake image-loader success, 404, timeout and corrupt-image failures; do not depend on an app ID remaining unavailable. A 15-second survival check tests only immediate exits, not successful Steam initialization or card drops.
- Apply the binary repair procedure below before replacing anything.

## Binary repair, backup and rollback

For an authorized repair, build from a pinned source commit in a separate staging directory. Record a small manifest: source/patch identity, build configuration, target architecture/framework, and version/hash for each affected executable and dependency. [Upstream project files](https://github.com/jonas-med-ett-s/idle_master_extended/blob/develop/steam-idle%20Source/steam-idle/steam-idle.csproj) include `Steamworks.NET.dll` and native `steam_api*.dll`; retain a matching dependency set, not just a same-named managed DLL.

Before replacement, identify exact target paths and expected old hashes, back up affected binary files, and keep user settings intact. Do not include session-bearing configuration in a backup or manifest. Stop the scoped application only when authorized and ownership is established; replace only the intended files after verifying the old identities still match.

Validate package hashes, architecture and dependencies offline. After an authorized launch, verify process/UI/helper behavior and manual-login requirements; report card-drop evidence separately. If validation fails, restore the exact backed-up binary set, verify its hashes and report the failure. Do not silently retry with different builds, clear configuration, or change proxy/security settings.

## API, CDN, and proxy symptoms

- A Steam API or badge-page refresh failure may prevent reliable remaining-game/card statistics without stopping an already-running helper.
- A CDN image 404 can crash an unpatched helper but is not itself proof that Steam idling failed.
- Inspect only non-sensitive destination/error-class fields from relevant logs; do not dump raw proxy logs or exception text containing session material. Avoid reproducing IP addresses, tokens, cookies or full sensitive log lines.
- Do not restart merely because the interface text has not changed.

## Signed-out state after restart

If the program shows `Idle Master未登录到Steam`, helpers will normally remain absent. Ask the user to log in manually. Never restore the session from a pasted cookie or token.

## Steam Invisible presence

`Invisible` in Friends & Chat is a presence choice, not Offline Mode. It may make the account appear offline to friends while keeping online features available, but it does not authorize changing profile privacy and should not be described as hiding every form of game activity.

When explicitly requested:

1. Read the current Friends & Chat presence.
2. Select `Invisible` / `隐身`.
3. Verify the presence indicator.
4. If monitoring includes presence, report when Steam reconnects in another state; reapply only if the automation explicitly authorizes it.
