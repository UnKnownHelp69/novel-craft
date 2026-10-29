/* Small pure helpers used everywhere. Nothing in lib/ touches the DOM or app state when it
   is imported, so the node:test suites in test/ import these modules directly. */

export const uuid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
export const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* esc() is for element content only: it leaves quotes alone (DOCX tests pin that output).
   Values interpolated into double-quoted attributes (value="${escAttr(x)}") need escAttr(). */
export const escAttr = s => esc(s).replace(/"/g, '&quot;');
/* A word starts and ends with a letter or digit (combining marks included); apostrophes and
   hyphens only count when they join letters (кто-то, rock'n'roll), so a hyphen typed as a
   dash (" - ") is not a word of its own. */
export const countWords = t => {
  const m = String(t || '').match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu);
  return m ? m.length : 0;
};
