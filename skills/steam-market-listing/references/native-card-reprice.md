# Reusable native card repricing

Use for a concrete approved plan to cancel and reprice existing card listings. The [runner](../scripts/steam-market-reprice-runner.cjs) imports without side effects and uses supplied cua Tab handles, not direct transaction requests. The [canonical helper](../scripts/steam-card-bulk-lister.user.js) is read-only. Neither depends on a previous chat directory/private ledger.

## Readiness and limits

The current adapter supports Chinese/CNY, app `753`, original submission context `6`, full card market hashes, and read-only helper 0.4.0/audit schema 2. Verify owned inventory and selected context before creating the runner. It checks visible account names on market, inventory, and sell pages and refuses unsupported wallet currency.

Inventory comes from the helper's `#scbl-agent-summary` JSON contract, not translated logs or table cells. Require compatible metadata, account/app/context identity, fresh scan generation and completeness, and each asset's explicit `state`, `locked`, and `lockReason`. Unknown states, missing/incompatible fields, corrupt ledger, or incomplete scan stop before writes. Marketability/tradability cannot override a helper or job lock. The helper's account/app/context ledger preserves legacy safety locks; do not reset or switch namespaces to make an asset eligible.

The market adapter checks active and held counts separately against parsed visible rows, including valid empty markets. On `MARKET_PAGINATED`, expand the visible page and re-read; never infer absence from a partial page. Changed Steam structure needs fresh locator evidence and an adapter correction before live work.

The returned group must have zero inventory copies before cancellation. Extra same-name copies, partial returns, trade locks, or ambiguous lineage stop execution. Other languages/currencies/apps/contexts and new inventory listings require a separately verified native workflow. This module chooses no prices and expands no scope. Update the browser helper only when needed; local skill updates do not install it. An incompatible helper stops before cancellation.

Keep one execution agent, one runner, and separate market/inventory/sell tabs for the job. Before the first cancellation, preflight the intended native route at quantity zero: account, item rows, page structure, and required controls must be supported. Repeat real quantity, fee, total, and terms checks after returns and immediately before submission; leave unaccepted legal terms to the user. Do not hand off tab ownership or share a ledger between processes. `jobKey` prevents overlapping calls in one loaded module; it is not a cross-process lease.

## Approved ledger

Store each job ledger in its workspace, not inside the skill. Use integer cents/string IDs. Required input:

```json
{
  "account": "visible account name",
  "inventoryProfileUrl": "verified owned inventory URL",
  "approvedBuyerTotalCents": 78, "approvedReceiveTotalCents": 64,
  "rows": [{
    "listingid": "10001", "appid": "753", "submission_contextid": "6",
    "assetid": "20001", "name": "Example", "game": "Example Trading Card",
    "url": "https://steamcommunity.com/market/listings/753/12345-Example",
    "proposedBuyerCents": 78, "nativeReceiveCents": 64, "nativeFeeCents": 14,
    "state": "APPROVED_ACTIVE"
  }],
  "batches": []
}
```

Add quote/fee evidence and human approval. The runner fills old IDs, returned submission IDs, original submission context, exact observed market/cancellation identity, price locks, in-flight states, native results, exact observations, and errors, plus an `execution` phase and approved-plan/returned-cohort fingerprints. An ACTIVE market row observed in context `16` can match the approved source in submission context `6`; cancellation uses its exact observed link rather than a rewritten context. Preserve across turns/restarts; never edit locks to force retry. An unchanged approved plan needs readiness and final native checks, not repeat pricing discovery or full historical-sales auditing.

## Call through cua

Initialize/select tabs using documented browser APIs first. Set `skillRoot` from this skill's actual location and `ledgerPath` to the job file. Use verified `marketTab`, `inventoryTab`, `sellTab` handles. Filesystem use is for the module/job artifacts only, not browser/profile/extension data.

```javascript
const auditFs = await import('node:fs/promises');
const auditVm = await import('node:vm');
const runnerSource = await auditFs.readFile(skillRoot + '/scripts/steam-market-reprice-runner.cjs', 'utf8');
const runnerModule = { exports: {} };
auditVm.compileFunction(runnerSource, ['module', 'exports'])(runnerModule, runnerModule.exports);
const { createRunner } = runnerModule.exports;
const approvedLedger = JSON.parse(await auditFs.readFile(ledgerPath, 'utf8'));
const runner = createRunner({
  ledger: approvedLedger, jobKey: ledgerPath,
  tabs: { market: marketTab, inventory: inventoryTab, sell: sellTab },
  approvedPlan: true, // Only after approval of this exact plan.
  collectMobileConfirmations: true, // Only if user requested consolidation.
  batchGroups: true, // Only with consolidation; one exact native multi-row form.
  persist: async value => {
    await auditFs.writeFile(ledgerPath + '.tmp', JSON.stringify(value, null, 2), 'utf8');
    await auditFs.rename(ledgerPath + '.tmp', ledgerPath);
  },
});
nodeRepl.write(await runner.runStep()); // One awaited stage; inspect phase/error before continuing.
// After phone confirmation:
nodeRepl.write(await runner.reconcile());
```

Load only the locally audited bundled runner, once per session. Some cua runtimes allow reading the module but reject CommonJS `require` realpath resolution; the demonstrated source loader above avoids that module-loader dependency. Do not compile downloaded or webpage-provided code. If local reads or compilation are denied, stop scripted execution and use supported native UI without circumventing permissions.

Continue the same runner with one `runStep()` per call; stop on `halted`/`error`. `PREFLIGHT` checks the quantity-zero native route, rows, controls, and account before `CHECK_BEFORE` obtains the concurrent complete baseline. Then follow one exact cancellation per stage; a concurrent returned-cohort checkpoint after all cancellations; open the real native form; fill one group's price and trigger recalculation; one fresh combined row/fee/quantity/terms verification plus persist-and-click; concurrent market/inventory/result reconciliation. The complete cohort checkpoints remain baseline, returns, and post-submission. No unbounded loops or unawaited background work. `runNext()` is retained for fast/mock IO compatibility, not recommended for native browser work.

Without authorized consolidated staging, set both `collectMobileConfirmations` and `batchGroups` to false. Batch mode validates all selected groups before the first cancellation; every native row remains homogeneous with its own approved quantity and fee pair. It does not infer one-to-one returned IDs. Full IDs stay on disk; return compact phase/counts/totals and expand DOM only for fresh locator evidence, changes or mismatches.

An outer timeout may leave the original stage running. Keep its runtime/owner; inspect durable state without reset, write replay, or a replacement runner. Increasing an inner timeout does not override the outer deadline. Helper read timeouts cover response headers and full body consumption; a read failure grants no write retry. After a submission click the saved phase is `RECONCILE` with `SUBMITTING_NATIVE` locks: the next stage is read-only, including after restart once the former owner is known stopped. Missing acceptance becomes an unsafe lock, never another click.

Every action is preceded by durable saving and a fresh approval/identity guard. Unknown outcomes and `RECONCILE_PENDING` block every later group across restart. Systemic errors persist a queue pause even when acceptance was proved. Repair purely read-only issues then use `await runner.resumeReadOnly()`; it resets partial form preparation but cannot unlock unknown outcomes. `reconcile()` reads state, never infers sales from absence, and retains unknown cancellation locks that lack returned submission identities.

For an observed shortcut losing the numeric game prefix, the optional [preview fix](../scripts/steam-card-native-preview-fix.user.js) preserves the hash and opens quantity `0`. Install only for that defect; it neither submits nor cancels.

## Local verification

From the skill root run `node --check scripts/steam-market-reprice-runner.cjs` and these offline suites:

- `node scripts/test-steam-market-reprice.cjs`
- `node scripts/test-steam-market-reprice-staged.cjs`
- `node scripts/test-steam-market-native-io.cjs`
- `node scripts/test-steam-market-helper-contract.cjs`

Tests use fictional assets/mocked UI with no Steam/network requests. They cover approvals, fees, cohort completeness, helper/adapter contract and preserved locks, observed versus submission contexts, preflight ordering, bounded stages, persistence/restart no-replay, parallel read lifecycle, and browser-call budgets. Offline checks do not prove live locator compatibility; verify readiness before the first live action. Precise overall time/token savings require usage measurements.
