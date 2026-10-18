---
name: steam-market-listing
description: Safely inventory, price-preview, list, reprice, and reconcile marketable Steam Community Market items through the user's signed-in Chrome session. Use for user-directed market listings, including cards and game inventory items; not credentials, trades, purchases, speculation, or unattended automation.
---

# Steam Community Market Listing

Use the user's signed-in Chrome session. Preserve the visible account, exact item identity, approved scope, and durable transaction state. This skill covers marketable Steam items; its bundled scripts support trading cards only.

Read [references/live-workflow.md](references/live-workflow.md) before live work. For approved card repricing through reusable browser code, also read [references/native-card-reprice.md](references/native-card-reprice.md). Read [references/see-multisell.md](references/see-multisell.md) only when SEE is requested or its relevant control is visible.

## Pricing

- Default to a patient sale at the current lowest active listing without undercutting. Follow the user's chosen balanced, premium, or quick-sale strategy.
- For a requested premium, compare current listings with recent trading range/median/volume; explain the longer wait without promising a sale time.
- No active listing or a failed quote requires available evidence and a specific user price choice. Do not invent a price.
- Group quotes by `appid` + `contextid` + complete `market_hash_name`, including any numeric game prefix. Quote once per group; retain one ledger row per exact `assetid`.
- Discuss all-at-once versus tranches for large stacks when volume matters. Preserve the full eligible quantity when the user chooses all.
- Show buyer pays, seller receives, and fees separately. Calibrate each distinct item/price pair with Steam's native sell UI; never substitute a fixed fee percentage. Reuse only within that homogeneous group at the approved price.
- Lock prices, quantity, and both totals. Auto-filled prices or a refresh cannot change the approved plan silently.

## Execution and authorization

- Start read-only: verify account, complete inventory, exact listings, pending locks, quote, native fees, and a concrete dry-run.
- Obtain approval for the complete plan before its first live action, including any repricing cancellation. Show account, exact assets/listings, count, locked prices, and both totals. Explicit approval covers every unchanged group across turns; do not ask again per group. New items, changed prices/quantities, orphaned confirmations, or another account need new specific approval. Script maintenance does not authorize market transactions.
- Keep one execution agent, one runner, and the same owned market/inventory/sell tabs for the job. Do not hand live execution between agents or create a second owner after a tool timeout. Independent read-only tabs can be queried in parallel by that owner.
- For an unchanged approved plan, resume its ledger and locked prices; do not repeat price discovery, historical-sale auditing, or native fee calibration without a changed price, missing evidence, or a mismatch. Recheck the actual native form before submission.
- Before the first cancellation, preflight the native multisell route with quantity zero, checking account, row identity, page structure, and required controls. This does not approve final quantities, fees, totals, or legal terms; verify those on the real form before submission and leave unaccepted terms to the user. With authorized consolidated staging and exact cohort/fee proof for every homogeneous row, use one native multi-row form for the approved groups. Otherwise submit groups serially. SEE is an orchestration surface, not a fee or outcome authority.
- Preserve `appid`, original `submission_contextid`, and `assetid` separately from the exact observed market/cancel-link identity. Market context `16` is observational; use original context `6` for the supported card submission route. Cancel only the exact observed link, never a context-rewritten link. If cancellation changes IDs, establish the exact returned cohort with fresh complete inventory; see the workflow reference.
- Persist before cancellation and submission. Result dialogs are provisional: reconcile exact market rows and fresh inventory even after modal timeout. Never replay an outcome-unknown request; lock affected assets and stop the whole queue.
- Pending assets remain locked. Default to pausing for mobile confirmation. If the user explicitly asks to stage the approved plan first, continue other disjoint approved groups after acceptance is proved, then request one consolidated phone confirmation. Retain that preference for this job; systemic limits/errors and ambiguity still stop the queue.
- Reconcile after phone confirmation. Distinguish pending, confirmed market hold, active listing, and sold. Missing inventory or a vanished pending row alone proves neither active listing nor sale.

## Scripts and efficient output

`scripts/steam-card-bulk-lister.user.js` is the canonical read-only card inventory/quote helper (0.4.0, audit schema 2). Its `#scbl-agent-summary` is the machine contract for scan account/app/context identity, generation, completeness, and per-asset `state`, `locked`, and `lockReason`. Read this data rather than translated logs or table text. Missing/incompatible fields, unknown states, incomplete scans, and corrupt ledgers stop execution. Native fee previews are not submission approval; the helper cannot submit or establish listing completion.

The helper's local ledger is scoped by account/app/context. Preserve historical safety locks during legacy migration; changing a namespace, resetting storage, or dropping an unknown state must never unlock an asset. It remains separate from the runner's durable job ledger, and a fresh scan does not erase either ledger's locks. Read-only request timeouts cover the complete response body as well as headers.

`scripts/steam-market-reprice-runner.cjs` orchestrates approved native card repricing through existing cua Tab handles. Import starts no job. Use `runStep()` for short stages; `batchGroups: true` shares a native form only with authorized consolidated staging. It checkpoints the whole cohort before cancellation, after all returns, and after submission; market/inventory readers run in parallel. The adapter supports Chinese/CNY, app `753`, original context `6`, and helper 0.4.0/schema 2. Other items/pages use a separately verified native workflow. `scripts/steam-card-native-preview-fix.user.js` is optional for a shortcut losing the numeric game prefix; it opens quantity-zero previews only.

Read skills/references once per session and reuse unless changed. Run reusable code instead of regenerating orchestration. Save full asset details to the job ledger; return compact counts, totals, current group, and errors, expanding on mismatch/request. Keep fresh UI observations and tool-required locator evidence. A character-count comparison is not a measured overall token saving.

Combine same-page fields into one read-only DOM observation. Use native locator actions for clicks/fills and explicit immutable identities; avoid cross-cell mutable "current row" helpers. Await short stages. `jobKey` is an in-process overlap guard, not a cross-process lease. An outer timeout may leave a stage running: retain its owner and inspect the existing runner and durable state without reset, write replay, or unawaited background work. Keep routine execution deterministic and reserve deeper analysis for discrepancies; do not silently change the user's model settings.

Helper installation is separate from updating local skill files. When needed, verify source, serve `scripts/` over loopback, and open the `.user.js` URL in Chrome. Let the user operate extension-owned Install/Update controls when automation cannot. Never inspect credentials, Steam cookies, authenticator data, extension storage, or unrelated local storage.

## Completion

Report planned, submitted, pending, confirmed-held (with dates), active, sold, unresolved, and remaining separately as applicable. Identify excluded/retryable/quarantined/non-marketable items when present. Claim only outcomes supported by exact market and complete inventory evidence. New discoveries require a new plan.
