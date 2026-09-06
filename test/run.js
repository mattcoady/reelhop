// Runs every test file and reports a combined result:  node test/run.js
//
// Each file is a standalone script that can also be run on its own; this only
// exists so there is one command for a person or for CI to run.
const { spawnSync } = require('child_process');
const path = require('path');

const files = ['shared.test.js', 'background.test.js'];
let failed = 0;
let totals = { pass: 0, fail: 0 };

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const run = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
  process.stdout.write(run.stdout || '');
  if (run.stderr) process.stderr.write(run.stderr);

  const summary = (run.stdout || '').match(/(\d+) passed, (\d+) failed/);
  if (summary) {
    totals.pass += Number(summary[1]);
    totals.fail += Number(summary[2]);
  }
  if (run.status !== 0) failed++;
}

console.log(`\n=== total: ${totals.pass} passed, ${totals.fail} failed ===`);
process.exit(failed ? 1 : 0);
