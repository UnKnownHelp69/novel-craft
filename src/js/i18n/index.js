/* Interface translations. Every piece of UI text goes through t('area.key'); the strings live in
   one dictionary per language (en.js, ru.js, …). To add a language, write its dictionary and add
   one line to LOCALES: the Settings menu, plurals, dates and numbers follow by themselves.

   Like lib/, this module touches no DOM and no app state when imported (applyI18n() needs a
   document only when called), so node can import it in the tests.

   The interface language is independent of a novel's export language (lib/language.js): the
   one is about the app, the other about the book. */
import en from './en.js';
import ru from './ru.js';

/* code -> { name (in its own language), dict }. English is the fallback for missing keys. */
export const LOCALES = {
  en: { name: 'English', dict: en },
  ru: { name: 'Русский', dict: ru }
};
export const FALLBACK = 'en';

export let locale = FALLBACK;
const pluralRules = {};

/* 'auto' (or anything unknown) picks the system language when a dictionary exists for it. */
export function resolveLocale(pref, systemLanguages = []) {
  if (pref && pref !== 'auto' && LOCALES[pref]) return pref;
  for (const tag of systemLanguages) {
    const base = String(tag || '').toLowerCase().split('-')[0];
    if (LOCALES[base]) return base;
  }
  return FALLBACK;
}
export function setLocale(code) { locale = LOCALES[code] ? code : FALLBACK; }

/* The text for `key` with {name} placeholders filled from `params`. A plural entry is an
   object of Intl.PluralRules forms ({ one, few, many, other }), chosen by params.n. A key
   missing from the current language falls back to English, then to the key itself. */
export function t(key, params) {
  let v = LOCALES[locale].dict[key];
  let lang = locale;
  if (v === undefined) { v = LOCALES[FALLBACK].dict[key]; lang = FALLBACK; }
  if (v === undefined) return key;
  if (typeof v === 'object') {
    const n = params && typeof params.n === 'number' ? params.n : 0;
    const rules = pluralRules[lang] || (pluralRules[lang] = new Intl.PluralRules(lang));
    v = v[rules.select(n)] ?? v.other;
  }
  if (!params) return v;
  return v.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/* Numbers and dates in the interface language. */
export const fmtNumber = n => Number(n).toLocaleString(locale);
export const fmtDate = (d, opts) => new Date(d).toLocaleDateString(locale, opts);
export const fmtDateTime = (d, opts) => new Date(d).toLocaleString(locale, opts);

/* Static markup: data-i18n="key" sets the text; data-i18n-title, -placeholder and -aria-label
   set those attributes. The English text in index.html stays as the fallback. */
const ATTRS = ['title', 'placeholder', 'aria-label'];
export function applyI18n(root) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  for (const a of ATTRS) {
    root.querySelectorAll(`[data-i18n-${a}]`).forEach(el => el.setAttribute(a, t(el.getAttribute(`data-i18n-${a}`))));
  }
}
