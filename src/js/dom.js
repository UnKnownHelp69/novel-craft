/* DOM helpers and the elements nearly every module touches. Module scripts run after the
   document has been parsed, so these lookups find their elements. */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const editor = $('#editor');
export const mdEditor = $('#mdEditor');
export const chapterList = $('#chapterList');
