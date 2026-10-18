# Steam Economy Enhancer compatibility note

Read this reference only when the user explicitly asks to use Steam Economy Enhancer (SEE), or when a visible SEE/manual bulk-listing control is present in the signed-in Chrome session.

## What is reusable from SEE

SEE's public source provides a useful orchestration pattern for Steam's native commodity multisell surface:

- validate that the selected items share the same `contextid` and are commodity items;
- select only currently marketable items, retaining exact `assetid` identity;
- group selected items by `market_hash_name` and quantity;
- build Steam's native `/market/multisell` request with the group's `appid`, `contextid`, repeated `items[]` market hash names, and `qty[]` quantities;
- process groups serially with a short delay rather than firing concurrent listing requests;
- treat the native page and Steam's market tables as the authorities for price, fees, accepted count, pending confirmation, and final reconciliation.

Public references: [SEE repository](https://github.com/Nuklon/Steam-Economy-Enhancer) and [SEE userscript source](https://raw.githubusercontent.com/Nuklon/Steam-Economy-Enhancer/master/code.user.js).

## Safety boundary for this skill

SEE does not replace the live-workflow invariants. Before opening a batch page, create a price lock and an exact asset ledger. Exclude assets already in Steam's pending-confirmation table, trade-protected assets, and any asset with an unknown outcome. For a cases/crates/capsules/keys batch, use SEE only if the visible control and rendered page clearly support that item's actual `appid`, `contextid`, and commodity market hash; do not use a card-only helper for non-card items.

The compatible URL shape is a native Steam multisell URL with repeated `items[]` and `qty[]` parameters. It must represent one homogeneous quote group and the exact approved quantity; it must not be treated as permission to sell an entire inventory or to overwrite the user's locked price. Verify item name, available/requested count, buyer-pays amount, seller-receive amount, and fees on the native page immediately before submission.

SEE may expose automatic retry or queue behavior. This skill deliberately does not inherit blind retries: use serial submission, reconcile exact asset IDs against Steam's pending and inventory state, quarantine an outcome-unknown asset, and stop the remaining batch until the state is clear. If the SEE control is absent, redirects away from the multisell page, or cannot be reconciled to exact assets, fall back to the native workflow only with the same confirmation and stopping rules.
