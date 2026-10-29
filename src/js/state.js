/* The open novel and what is selected in it. Other modules read these as live imports but
   cannot assign them (an imported binding is read-only), hence the setters. `dirty` is
   normally changed through markDirty()/setSaved() in dirty.js, which also update the save
   indicator. */
export let novel = null;              // the currently-open novel (null = none open)
export function setNovel(v) { novel = v; }
export let currentChapterId = null;
export function setCurrentChapterId(v) { currentChapterId = v; }
export let currentSceneId = null;     // the scene currently loaded in the editor
export function setCurrentSceneId(v) { currentSceneId = v; }
export let currentFilePath = null;    // path of the open .novel file (null = never saved)
export function setCurrentFilePath(v) { currentFilePath = v; }
export let dirty = false;
export function setDirty(v) { dirty = v; }

/* Dirty tracking: see markDirty() and the editor's input handler. */
export let isLoadingContent = false;  // true while code (not the user) fills the editor; markDirty() ignores it
export function setLoadingContent(v) { isLoadingContent = v; }
