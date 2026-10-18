# Live workflow

Read before operating a live Steam account; reuse during the same unchanged job.

## 1. Account and surface

Use signed-in Chrome. Verify the visible account and that inventory belongs to it, not another public profile; preserve the owned profile URL in the ledger. Follow available browser-control documentation and observed UI evidence.

Never inspect/expose cookies, session identifiers, passwords, Steam Guard data, extension storage, or unrelated local storage. The audited helper uses native inventory/fee objects internally and its own audit ledger; read its published machine summary. Exclude trades, purchases, speculation, and unattended selling.

## 2. Optional card helper

The canonical [card helper](../scripts/steam-card-bulk-lister.user.js) is read-only 0.4.0/schema 2. It scans cards, fetches grouped quotes, previews fees, and exposes audit metadata. It cannot submit or establish listing completion. Other items use native UI or an explicitly compatible audited helper.

Only install/update when needed. Verify the local header/source, serve `scripts/` on loopback, and open its `.user.js` URL in Chrome. Let the user click extension-owned Install/Update when browser automation cannot. Existing authorization governs any agent-operated installation; obtain required installation approval only after the source is reviewable. Reload inventory and verify read-only mode, version, and `data-audit-schema="2"`. A skill-file update does not update Tampermonkey.

Use JSON from `#scbl-agent-summary`, not translated logs, status labels, or table layout. Require `schema: 2`, `helperVersion: "0.4.0"`, `mode: "READ_ONLY"`, idle `busy`, supported `currency`, and the verified `account`, `inventoryProfileUrl`, `appid`, and `contextid`. `scan` carries `generation`, `status`, `complete`, `startedAt`, `completedAt`, and `error`; only a fresh `status: "COMPLETE"` with `complete: true` proves a full scan. `RUNNING`, `FAILED`, and `NOT_SCANNED` do not. Each `assets` row carries exact `assetid`, `appid`, `contextid`, full `market_hash_name`, `marketable`, `tradable`, `state`, `locked`, and `lockReason`. Verify identity and freshness again after reload. Missing fields, incompatible versions, unknown states, a busy/incomplete scan, or a ledger error fail closed; an eligibility flag cannot override a lock.

The helper ledger is account/app/context-scoped and separate from the job ledger. Legacy migration preserves historical safety locks conservatively. A corrupt ledger is an error, never an empty first-use ledger. Do not clear, rename, or switch ledger namespaces to bypass a lock. The helper's bounded read timeout includes consuming the entire response body; timeout does not prove a transaction failed.

## 3. Complete inventory and locks

1. Record account, owned inventory URL, actual app/context, item type/variant, and exact asset IDs.
2. Load complete inventory. After cancellation/mobile confirmation, reload before scanning: `LoadCompleteInventory()` on an already loaded page can reuse stale assets.
3. Select only currently marketable and tradable assets whose machine state is known and explicitly unlocked. Treat trade protection, pending listings, prior submission markers, quarantined assets, and unknown outcomes as locks; record unlock dates where available. Preserve locks from either helper or job ledger.
4. Read pending and active/held market rows by exact identity. Compare displayed active/held total with rows actually read. Pagination or missing rows cannot prove absence; expand/navigate visible UI or stop read-only.
5. Stop on wrong account, duplicates, incomplete scans, unreadable pending state, timeouts, or unsupported contexts. Independent read-only checks may run in parallel when supported.

Group by app/context/full market hash. Keep original `submission_contextid` separate from `observed_contextid`; market context `16` can be the same listed asset. Preserve the exact observed cancellation link identity; do not rewrite its context to submission context `6`.

## 4. Quote and lock

Query once per homogeneous group. Record current lowest sell listing, highest buy order, relevant recent range/median/volume, timestamp, and missing evidence. The helper's lowest-price preview alone does not supply every strategy input. No active listing or failed quote requires a specific user-selected price.

Calibrate each distinct item/price pair in Steam's native sell UI; never estimate when unavailable. Trigger input events after manual edits and verify recalculation. One group at one price needs one calibration.

Persist a dry-run with account, profile URL, exact identifiers, quantity, buyer/receive/fee cents, group totals, both overall totals, failures, and excluded locks. Repricing identifies every old listing to cancel. Restore and verify approved values when a page auto-fills different prices; otherwise seek renewed approval.

## 5. Approve once, execute serially

Show the complete plan and obtain explicit approval before its first cancellation/submission: account, assets/listings, quantity, locked prices, both totals, fees, possible phone confirmation/hold. Approval covers all unchanged groups and continuation turns; do not repeat it per group. Changed scope needs fresh approval.

1. Verify source listing ID, app, original submission context, asset, market item, active/unlocked state, and exact observed cancel-link identity. Record complete before-inventory for repricing. Before the first cancellation, open the intended native route with every quantity set to zero and verify account, item rows, page structure, and required controls. An unsupported route or control stops before cancellation. This preflight cannot replace final real-quantity/fee checks or user acceptance of terms.
2. Persist before each exact native cancellation. For one approved cohort, cancel serially using the observed link's listing/app/context/asset identity and exact acknowledgement per item, then refresh market and complete inventory once for the whole cohort. An ambiguous cancellation stops immediately; do not finish the cohort first.
3. Steam may change returned asset IDs. Establish a cohort only if the group had zero copies before, all approved old listings disappeared, and exactly the approved quantity of new, eligible, unlisted copies appeared. Persist old listings to the returned cohort; never invent one-to-one lineage. Extra copies, partial returns, or ambiguity require manual exact-asset reconciliation.
4. Open native `/market/multisell` with the actual app/context, full encoded market hash, and approved quantity. Exact-asset fallback uses amount 1 and concurrency 1.
5. Verify account, item, available/requested count, buyer price, seller receive, fee pair, and totals. Follow fresh UI evidence requirements. Leave unaccepted legal terms to the user.
6. Persist the submission lock before clicking. With authorized consolidated staging, one native form may contain multiple homogeneous approved rows when every row/cohort and both totals are proven. Otherwise submit groups serially. Reconcile every asset against market rows and freshly reloaded inventory before any later transaction.

A failed/timeout modal may coexist with accepted rows. Lock every accepted asset and never replay apparent failures. Residual form quantity is not retryability evidence.

## 6. Stop and recover

Stop the whole queue for confirmation limits, rate limits, account/session errors, missing locks, incomplete data, user pause/takeover, or ambiguous cancellation/submission. Only proven asset-specific rejection can be quarantined while other groups continue.

Persist `OUTCOME_UNKNOWN`, or retain the durable in-flight marker if saving fails. Lock across restart; never assume failure/retry or replay a write. Resume writes only after authoritative read-only reconciliation with approval still valid. Unproved acceptance stays `RECONCILE_PENDING`. A purely read-only preparation failure may be repaired and rechecked under the same approval; unknown or corrupt durable state must first be resolved without discarding locks.

## 7. Phone confirmation and holds

Pending assets are hard locks. Default to pausing for Steam Guard. If the user requests all approved groups staged first, continue only disjoint groups after proving prior acceptance, preserving that preference for the job. Systemic stop rules remain in force.

Once staged, show a single combined pending count and both totals and ask for phone confirmation on the correct account. Then refresh market and reload complete inventory.

- `PENDING_MOBILE_CONFIRMATION`: exact pending row; never resubmit.
- `CONFIRMED_MARKET_HOLD`: exact confirmed row with hold date and no eligible inventory copy. Report the date; it is not active or sold.
- `ACTIVE`: exact active row without hold and no eligible inventory copy.
- `SOLD`: authoritative sale/history evidence matched to the transaction. Absence alone cannot prove sale.
- `RECONCILE_PENDING`: missing/conflicting proof, stale inventory, or incomplete pages. Retain locks even if pending vanished.

If a confirmed item remains in inventory, wait for synchronization and repeat only read-only checks. An explicit relist needs pending gone, no active/held listing, exact asset eligible in original context, new specific approval, and native fee revalidation. Orphaned phone confirmations stay locked; cancellation/relisting needs specific approval.

Reuse one market tab and one inventory tab per checkpoint. Reload for fresh state rather than accumulating tabs. Reuse unchanged price locks; revalidate fees/availability instead of repeating discovery.

Keep one execution owner and runner per ledger; `jobKey` is only an in-process guard, not a cross-process lease. Query independent market/inventory tabs concurrently; collect same-page fields together. Prefer `runStep()` to a long group call. A tool timeout may leave the original running: retain its owner, inspect its state, and do not reset, start a replacement, or replay writes. Parallel read-only calls must all settle before an error releases the queue.

## 8. Closeout

Keep full evidence in the durable ledger; return compact counts/totals and expand discrepancies. Separate planned, submitted, pending, confirmed-held with dates, active, sold, unresolved, and remaining. Identify excluded/retryable/quarantined items when present. New discoveries need a new plan. Clicks or inventory disappearance alone do not establish completion.
