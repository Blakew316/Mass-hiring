// Run the regression tests one after another and say which failed.
//   node tests/run.js                 every *.test.js here
//   node tests/run.js a.test.js b ... just those
// ROOT, PORT_BASE, PLAYWRIGHT_CORE and CHROMIUM pass through (see helpers.js).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const here = __dirname;
const asked = process.argv.slice(2);
const all = fs.readdirSync(here).filter((f) => f.endsWith('.test.js')).sort();
const list = asked.length ? asked.map((a) => (a.endsWith('.js') ? a : `${a}.test.js`)) : all;
const failed = [];
for (const t of list) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, t)], { encoding: 'utf8', env: process.env, timeout: 15 * 60000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const passes = (out.match(/^PASS /gm) || []).length;
  const fails = (out.match(/^FAIL /gm) || []).length;
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (r.status !== 0 || fails) {
    failed.push(t);
    console.log(`${t.padEnd(36)} FAIL  (${passes} pass, ${fails} fail, exit ${r.status}, ${secs}s)`);
    for (const line of out.split('\n').filter((l) => /^FAIL |Error/.test(l)).slice(0, 8)) console.log(`      ${line.slice(0, 300)}`);
  } else {
    console.log(`${t.padEnd(36)} ok    (${passes} checks, ${secs}s)`);
  }
}
console.log(failed.length ? `\nFAILED: ${failed.join(' ')}` : `\nALL GREEN (${list.length} tests)`);
process.exit(failed.length ? 1 : 0);
