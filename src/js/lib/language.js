/* The language an exported document declares. novel.settings.language is either an explicit
   choice ('en', 'ru', ...) or null, meaning "detect it from the text". Exporters call
   resolveLanguage(novel) fresh every time and never store the detected value, so a novel's
   exports follow its text as it changes. */

/* Languages offered in the Compile dialog, in display order. Add new ones here; the
   per-format tables (TOC_LABEL, DOCX_LOCALE) fall back gracefully for any they lack. */
export const NOVEL_LANGUAGES = [['en', 'English'], ['ru', 'Русский']];
/* Majority script of the title plus every scene's text: Cyrillic -> 'ru', Latin -> 'en'
   (ties go to 'en'), no letters of either script at all -> null. Tags and entities are
   stripped first so markup like <p> or &nbsp; never counts as Latin text. */
export function detectLanguage(novel) {
  if (!novel) return null;
  let text = String(novel.title || '');
  (novel.chapters || []).forEach(c => (c.scenes || []).forEach(sc => {
    text += ' ' + String(sc.content || '').replace(/<[^>]*>/g, ' ').replace(/&[#a-z0-9]+;/gi, ' ');
  }));
  const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  if (cyr > lat) return 'ru';
  return lat ? 'en' : null;
}
/* An explicit setting wins if it is shaped like a language tag; anything else (unset, or a
   hand-edited file holding garbage) falls back to detection, then to English. */
export function resolveLanguage(novel) {
  const set = novel && novel.settings && novel.settings.language;
  if (typeof set === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(set)) return set;
  return detectLanguage(novel) || 'en';
}
