import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

test('local scripts exist, load in order, and stay relative for the /balloon/ subpath', () => {
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['js/vendor/three.min.js', 'js/vendor/OrbitControls.js', 'js/vendor/BufferGeometryUtils.js', 'js/app.js']);
  for (const src of srcs) assert.ok(fs.existsSync(path.join(root, src)), src);
  assert.equal(/(?:src|href)="\//.test(html), false, 'no root-absolute paths');
});

test('no claude.ai frame runtime and no network calls are left in the page', () => {
  for (const text of [html, app]) {
    assert.equal(/__FRAME|frame-runtime|claudeusercontent/.test(text), false);
    assert.equal(/\bfetch\(|XMLHttpRequest|window\.claude/.test(text), false);
  }
  assert.equal(/<canvas/.test(html), false, 'the app creates its own canvas');
});

test('app script parses and every element it looks up is in the page', () => {
  new vm.Script(app);
  for (const [, id] of app.matchAll(/getElementById\('([^']+)'\)/g)) assert.ok(html.includes(`id="${id}"`), id);
});
