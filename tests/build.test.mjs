import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The service worker caches the shell, so a stale build is invisible unless the
 * app can say which build it is. That only works if the number the app prints
 * is the number the worker caches by.
 */
test('the build stamp matches the service worker version', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const build = /const BUILD = '([^']+)'/.exec(app)?.[1];
  const version = /VERSION = '([^']+)'/.exec(sw)?.[1];
  assert.ok(build, 'app.js has no BUILD constant');
  assert.ok(version, 'sw.js has no VERSION');
  assert.equal(build, version, `app says ${build}, worker caches ${version}`);
});
