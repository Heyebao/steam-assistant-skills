'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const suites = [
 'skills/steam-market-listing/scripts/test-steam-market-reprice.cjs',
 'skills/steam-market-listing/scripts/test-steam-market-reprice-staged.cjs',
 'skills/steam-market-listing/scripts/test-steam-market-native-io.cjs',
 'skills/steam-market-listing/scripts/test-steam-market-helper-contract.cjs',
 'tests/forward-native-dom.cjs', 'tests/probe-legacy-pause.cjs'
];
for (const suite of suites) {
 console.log(`\n=== ${suite} ===`);
 const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', suite)], {stdio:'inherit'});
 if (result.error) throw result.error;
 if (result.status !== 0) process.exit(result.status || 1);
}
console.log('All six offline suites passed.');
