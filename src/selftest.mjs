// Offline self-check: manifest fields, substituted build placeholders, and a
// bundle that registers under the package name without touching the DOM.
//
//   node src/selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

assert.equal(pkg.type, 'module', 'package must be ESM');
assert.equal(pkg.main, 'lib/index.js', 'host half entry');
assert.equal(pkg.exports['./client'], './lib/client.js', 'client half export');
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform');
assert.equal(pkg.dsh.client.immediately, true, 'client half must load eagerly');
assert.ok(pkg.dsh?.bundle?.patch, 'bundle patch declared');

assert.ok(!source.includes('__DSH_WALLPAPER_'), 'placeholders substituted');
assert.match(source, /data:image\/(jpeg|png);base64,/, 'at least one image embedded');

const registered = [];
globalThis.window = { __ModuleLoader__: { load: (entry) => registered.push(entry) } };

await import(new URL('../lib/client.js', import.meta.url).href);

assert.equal(registered.length, 1, 'exactly one bundle registration');
const entry = registered[0];
assert.equal(entry.id, pkg.name, 'bundle id is the package name');

const plugin = entry.factory(() => {
  throw new Error('the wallpaper bundle must not require anything');
});
assert.equal(typeof plugin.apply, 'function', 'plugin exports apply()');
plugin.apply(); // no document here: must stay inert

console.log('ok — manifest, build placeholders, bundle registration');
console.log(`  bundle id : ${entry.id}`);
console.log(`  size      : ${(source.length / 1024).toFixed(1)} KiB`);
