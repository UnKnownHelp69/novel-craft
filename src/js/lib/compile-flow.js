/* The compiled flow, the format-neutral middle of every export. buildFlow() turns comp.items into a format-neutral list of part / chapter / break / scene
   entries that the preview and every exporter render. A chapter's heading appears once,
   before the first of its scenes in the order, even when its scenes are scattered. Headings
   get sequential anchors (h0, h1, …) that the HTML/EPUB TOCs link to. The scene separator
   between two consecutive scenes is not in the flow; each renderer inserts it. */
export function sepText(settings) {
  const s = settings;
  if (s.sceneSeparator === 'blank') return '';
  if (s.sceneSeparator === 'custom') return s.sceneSepCustom || '* * *';
  return '* * *';
}
/* The word in "Chapter N" headings, per export language (settings.language, resolved by
   compFlow()); a language missing here falls back to English. */
const CHAPTER_LABEL = { en: 'Chapter', ru: 'Глава' };
export function chapterHeadingText(chap, ci, settings) {
  const word = CHAPTER_LABEL[settings.language] || CHAPTER_LABEL.en;
  const title = chap.title || (word + ' ' + (ci + 1));
  // A title that is just "Chapter N" / "Глава N" adds nothing after the number.
  const isDefault = /^(chapter|глава)\s+\d+$/i.test(title.trim());
  const suffix = isDefault ? '' : ': ' + title;
  switch (settings.numberChapters) {
    case 'arabic': return word + ' ' + (ci + 1) + suffix;
    case 'plain': return (ci + 1) + '. ' + title;
    default: return title;
  }
}
export function buildFlow(items, settings, chapters, findSceneFn) {
  const flow = [];
  const seen = new Set();
  let hc = 0;
  items.forEach(it => {
    if (it.type === 'part') { if (settings.includeParts) flow.push({ type: 'part', title: it.title || 'Part', anchor: 'h' + (hc++) }); return; }
    if (it.type === 'break') { flow.push({ type: 'break' }); return; }
    const f = findSceneFn(it.sceneId);
    if (!f) return;
    if (settings.sceneTitles !== 'no' && !seen.has(f.chapter.id)) {
      seen.add(f.chapter.id);
      const ci = chapters.indexOf(f.chapter);
      flow.push({ type: 'chapter', title: chapterHeadingText(f.chapter, ci, settings), anchor: 'h' + (hc++) });
    }
    const showTitle = settings.sceneTitles === 'yes';
    flow.push({ type: 'scene', title: it.title || f.scene.title, html: f.scene.content || '', showTitle, anchor: showTitle ? 'h' + (hc++) : null });
  });
  return flow;
}
export function compTocEntries(flow, settings) {
  return flow.filter(f => f.type === 'part' || f.type === 'chapter' || (settings.tocDepth === 'scenes' && f.type === 'scene' && f.showTitle));
}
/* The table of contents heading, per export language (resolveLanguage()). Every format's
   TOC and the EPUB nav document read it through tocLabel(); a language missing here falls
   back to English. */
export const TOC_LABEL = { en: 'Contents', ru: 'Содержание' };
export function tocLabel(lang) { return TOC_LABEL[lang] || TOC_LABEL.en; }
