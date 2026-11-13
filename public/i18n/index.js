/**
 * i18n — no library, no build step. Two flat dictionaries, one key set.
 */
import en from './en.js';
import sv from './sv.js';

export const DICTS = { en, sv };
export const LANGS = ['en', 'sv'];
export const DEFAULT_LANG = 'sv';

let current = DEFAULT_LANG;

export function setLang(lang) {
  if (DICTS[lang]) current = lang;
  return current;
}

export function getLang() {
  return current;
}

/** sv-SE if the device speaks Swedish, en otherwise, sv if we cannot tell. */
export function detectLang(nav = globalThis.navigator) {
  const tag = String((nav && nav.language) || '').toLowerCase();
  if (tag.startsWith('sv')) return 'sv';
  if (tag.startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

/** t('whoComesOn'), t('periodN', { n: 2 }) */
export function t(key, vars) {
  const dict = DICTS[current] || DICTS[DEFAULT_LANG];
  let out = dict[key];
  if (out === undefined) out = DICTS.en[key];
  if (out === undefined) return key;
  if (!vars) return out;
  return String(out).replace(/\{(\w+)\}/g, (m, k) =>
    vars[k] === undefined ? m : String(vars[k]),
  );
}

/** Localised position code ('LB' / 'VB') or name ('Back left' / 'Vänster back'). */
export function pos(slot, field = 'code') {
  const dict = DICTS[current] || DICTS[DEFAULT_LANG];
  return dict.pos?.[slot]?.[field] ?? slot;
}

export function benchTag(field = 'code') {
  const dict = DICTS[current] || DICTS[DEFAULT_LANG];
  return dict.benchTag?.[field] ?? 'BN';
}
