import test from 'node:test';
import assert from 'node:assert/strict';

import en from '../public/i18n/en.js';
import sv from '../public/i18n/sv.js';
import { t, setLang, getLang, detectLang, pos, DICTS } from '../public/i18n/index.js';
import { SLOTS } from '../public/engine.js';

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, key) : [[key, v]];
  });

test('i18n: every key in one language exists in the other', () => {
  const enKeys = flatten(en).map(([k]) => k).sort();
  const svKeys = flatten(sv).map(([k]) => k).sort();
  assert.deepEqual(svKeys, enKeys);
});

test('i18n: no empty strings', () => {
  for (const [k, v] of [...flatten(en), ...flatten(sv)]) {
    assert.equal(typeof v, 'string', `${k} must be a string`);
    assert.ok(v.trim().length > 0, `${k} is empty`);
  }
});

test('i18n: the words that matter are actually translated', () => {
  const mustDiffer = ['coach', 'view', 'goal', 'stop', 'sub',
    'onField', 'bench', 'whoComesOn', 'whoComesOff', 'minutes', 'assists',
    'changePosition', 'readOnly', 'takeover', 'nextBlock'];
  for (const key of mustDiffer) {
    assert.notEqual(sv[key], en[key], `${key} looks untranslated`);
  }
});

test('i18n: every slot has a code and a name in both languages', () => {
  for (const slot of SLOTS) {
    for (const dict of [en, sv]) {
      assert.ok(dict.pos[slot], `missing pos entry for ${slot}`);
      assert.ok(dict.pos[slot].code.trim(), `missing code for ${slot}`);
      assert.ok(dict.pos[slot].name.trim(), `missing name for ${slot}`);
    }
  }
  // The codes are the whole point of D8: they differ between languages.
  assert.equal(en.pos.LB.code, 'LB');
  assert.equal(sv.pos.LB.code, 'VB');
  assert.equal(en.pos.G.code, 'G');
  assert.equal(sv.pos.G.code, 'MÅL');
});

test('i18n: t() interpolates and falls back without throwing', () => {
  setLang('en');
  assert.equal(t('periodN', { n: 2 }), 'Period 2');
  assert.equal(t('doesNotExist'), 'doesNotExist');
  setLang('sv');
  assert.equal(t('periodN', { n: 3 }), 'Period 3');
  setLang('en');
});

test('i18n: switсhing language changes pos() codes', () => {
  setLang('en');
  assert.equal(pos('RM'), 'RM');
  setLang('sv');
  assert.equal(pos('RM'), 'HM');
  assert.equal(pos('F', 'name'), 'Anfallare');
  setLang('en');
});

test('i18n: detectLang maps the device language', () => {
  assert.equal(detectLang({ language: 'sv-SE' }), 'sv');
  assert.equal(detectLang({ language: 'en-GB' }), 'en');
  assert.equal(detectLang({ language: 'de-DE' }), 'sv', 'unknown falls back to Swedish');
  assert.equal(detectLang({}), 'sv');
});

test('i18n: both dictionaries are loaded and complete', () => {
  assert.deepEqual(Object.keys(DICTS).sort(), ['en', 'sv']);
  assert.equal(getLang(), 'en');
});
