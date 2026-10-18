# Steam Assistant Skills

Human-supervised Steam card inventory/quote and native repricing workflows, plus Windows Idle Master Extended diagnostic instructions. [Full Chinese guide](../README.md).

Copy the two folders under `skills/` into your Codex skills directory. Install the read-only userscript separately using a trusted userscript manager. A browser-capable host and verified signed-in tabs are required for native execution; this is not a standalone bot.

Run `node scripts/test-offline.cjs` on Node 22/24. No dependencies, keys, Steam connection or live trades are required. Offline success does not establish live page compatibility. The bundled runner currently targets Chinese/CNY, app 753, submission context 6 and observed market context 16.

Require concrete human approval of exact account, assets, quantities, prices, fees and totals before cancellation/submission. Users handle authentication, unaccepted terms and phone confirmation. Unknown outcomes remain locked and must never be replayed. Keep private ledgers outside this repository.

Use latest main. The first commits import retained snapshots at publication time; they do not recreate original Git dates/authors. The baseline is historical reference only. See the license and third-party notices before redistributing.
