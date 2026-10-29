/* Blank novel objects: what File → New and "add scene/chapter" create, and the shape
   migrateNovel() (novel-file.js) fills in for older files. */
import { uuid } from './text.js';

export function nowISO() { return new Date().toISOString(); }
export function blankScene(n) {
  return {
    id: uuid(), title: `Scene ${n + 1}`, order: n,
    content: '', markdownContent: '', wordCount: 0,
    povCharacter: null, location: null, timeOfDay: 'unknown', status: 'draft',
    notes: [], createdAt: nowISO(), modifiedAt: nowISO()
  };
}
export function blankChapter(n) {
  return { id: uuid(), order: n, title: `Chapter ${n + 1}`, wordCount: 0, collapsed: false, scenes: [blankScene(0)] };
}
/* A fresh, empty world map (lives in novel.settings.worldMap). The background
   image is stored inline as a base64 data URL so the map is self-contained and
   works in the browser fallback (no external file to resolve). */
export function blankWorldMap() {
  return {
    backgroundImage: '', imageW: 0, imageH: 0,
    locations: {},              // locationId -> { x, y, visible }; x/y are fractions (0-1) of the image size
    routes: [],
    layers: [],                 // custom drawing layers
    baseLayers: { background: true, locations: true, routes: true, labels: true }
  };
}
/* One .novel file = ONE novel; these top-level keys are exactly what toFileObject() writes.
   fontSize is in px, wordGoal in words; language null = auto-detect from the text. */
export function newNovel(title) {
  return {
    version: '1.0',
    title: title || 'Untitled Novel',
    settings: { fontSize: 18, defaultFont: 'Georgia, serif', wordGoal: 80000, customNoteTypes: [], noteTypeColors: {}, worldMap: blankWorldMap(), compilationPresets: [], language: null },
    chapters: [blankChapter(0)],
    characters: [],
    locations: [],
    races: []
  };
}
