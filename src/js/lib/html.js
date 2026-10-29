/* Scene HTML in and out: inert parsing, plain text, and the sanitizer every piece of scene
   HTML from a file or the clipboard passes through (see "Security invariants" in CLAUDE.md). */

/* Parse HTML without side effects. A DOMParser document has no browsing context, so nothing
   in it loads or runs: an <img onerror> stays inert. Never parse file or clipboard HTML
   through document.createElement(...).innerHTML — that element belongs to the live page,
   and its images load and fire their handlers even while it is detached. The <body> prefix
   starts the parser in body mode, so markup lands exactly where div.innerHTML would put it
   (and <title>/<meta>/<style> stay in the body, where the sanitizer can see them). */
export const parseInert = html => {
  const doc = new DOMParser().parseFromString('<!DOCTYPE html><body>' + (html || ''), 'text/html');
  return doc.body || doc.documentElement;
};

/* Plain text of a node tree. DOM-free: it walks any node-like tree ({nodeType, nodeName,
   nodeValue, childNodes}), which is how test/strip-html.test.js feeds it plain objects.
   Text is collected in an array and the last emitted character is tracked on the
   side: growing one string with += and calling .endsWith() on it makes V8 flatten the string
   on every call, which made this walk quadratic (~0.4 s per keystroke on a 30k-word scene). --- */
const TEXT_BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TR', 'UL', 'OL', 'TABLE']);
export function textFromNode(root) {
  const parts = [];
  let last = '';
  const push = s => { if (s) { parts.push(s); last = s[s.length - 1]; } };
  const walk = node => {
    if (node.nodeType === 3) { push(node.nodeValue); return; }
    if (node.nodeName === 'BR') { push('\n'); return; }
    const isBlock = TEXT_BLOCK_TAGS.has(node.nodeName);
    if (isBlock && parts.length && last !== '\n') push('\n');
    for (const c of node.childNodes) walk(c);
    if (isBlock && parts.length && last !== '\n') push('\n');
  };
  walk(root);
  return parts.join('').trim();
}
export const stripHtml = html => textFromNode(parseInert(html));

/* The allowlist behind sanitizeSceneHTML(), DOM-free (test/html-policy.test.js). Scene HTML comes from .novel files (which may
   be someone else's) and from the clipboard, and it ends up in the live editor, so anything
   not listed here is either dropped with its content or unwrapped to its text. --- */
// Kept as-is (minus attributes): everything the editor, mdToHtml() and ordinary pastes produce.
export const SCENE_KEEP_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'hr', 'ul', 'ol', 'li', 'img',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ruby', 'rt', 'rp', 'center'
]);
// Dropped together with everything inside: active content, raw-text containers, form
// controls and foreign (SVG/MathML) content, whose parsing rules differ from plain HTML.
export const SCENE_DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'param', 'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track', 'picture',
  'link', 'meta', 'base', 'title', 'head', 'textarea', 'select', 'option', 'optgroup', 'input',
  'button', 'marquee', 'xmp', 'plaintext', 'noembed', 'noframes', 'portal'
]);
export function sceneTagAction(tag) {
  tag = String(tag || '').toLowerCase();
  if (SCENE_KEEP_TAGS.has(tag)) return 'keep';
  if (SCENE_DROP_TAGS.has(tag)) return 'drop';
  return 'unwrap';
}
const FONT_FAMILY_RE = /^[\p{L}\p{N} ,.'"_-]{1,200}$/u;
// Images stay only as inline raster data (pasted screenshots); remote or SVG sources go.
const IMG_SRC_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
/* The value an attribute keeps, or null to remove it. `style` is filtered property by
   property (sceneStyleValueOk) by the DOM side, so it never passes here. */
export function sceneAttrValue(tag, name, value) {
  tag = String(tag || '').toLowerCase();
  name = String(name || '').toLowerCase();
  value = String(value == null ? '' : value);
  if (tag === 'font' && name === 'face') return FONT_FAMILY_RE.test(value) ? value : null;
  if (tag === 'img' && name === 'src') return IMG_SRC_RE.test(value) ? value : null;
  if (tag === 'img' && name === 'alt') return value;
  // Layout that older pastes carry and that cannot load anything.
  if (name === 'dir') return /^(?:ltr|rtl|auto)$/i.test(value) ? value : null;
  if (name === 'align') return /^(?:left|right|center|justify)$/i.test(value) ? value : null;
  if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan')) return /^[1-9]\d{0,2}$/.test(value) ? value : null;
  return null;
}
// Inline styles keep only what per-selection formatting needs (contenteditable sometimes
// writes these instead of <b>/<i>/<font>) plus alignment and tab spacing from older pastes;
// nothing in this list can load a resource. Colours are deliberately not kept: pastes from
// Word/Docs carry black text that would vanish on the dark editor.
const SCENE_STYLE_PROPS = {
  'text-align': /^(?:left|right|center|justify|start|end)$/,
  'white-space': /^(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)$/,
  'font-family': FONT_FAMILY_RE,
  'font-weight': /^(?:normal|bold|bolder|lighter|[1-9]00)$/,
  'font-style': /^(?:normal|italic|oblique)$/,
  'text-decoration-line': /^(?:none|(?:underline|overline|line-through)(?: (?:underline|overline|line-through))*)$/
};
export function sceneStyleValueOk(prop, value) {
  const re = SCENE_STYLE_PROPS[prop];
  return !!re && re.test(String(value == null ? '' : value).trim());
}

/* Clean untrusted HTML in place (children of `parent`) according to the policy above.
   Children are cleaned before their parent is unwrapped, so unwrapping only ever moves
   already-clean nodes. */
export function sanitizeChildren(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) continue;                          // text
    if (node.nodeType !== 1) { node.remove(); continue; }       // comments, processing instructions
    const tag = node.localName;
    const action = sceneTagAction(tag);
    if (action === 'drop') { node.remove(); continue; }
    sanitizeChildren(node);
    if (action === 'unwrap') { node.replaceWith(...node.childNodes); continue; }
    // `style` is rebuilt from the declarations the browser parsed, one allowlisted property at a
    // time, never copied as raw text; the raw attribute is removed with the rest below.
    let style = '';
    if (node.hasAttribute('style') && node.style) {
      style = Object.keys(SCENE_STYLE_PROPS)
        .map(p => [p, node.style.getPropertyValue(p).trim()])
        .filter(([p, v]) => v && sceneStyleValueOk(p, v))
        .map(([p, v]) => `${p}: ${v};`).join(' ');
    }
    for (const a of [...node.attributes]) {
      const v = sceneAttrValue(tag, a.name, a.value);
      if (v === null) node.removeAttribute(a.name);
    }
    if (style) node.setAttribute('style', style);
    if (tag === 'img' && !node.hasAttribute('src')) node.remove();   // its source was not inline raster data
  }
}
/* Scene HTML as it may safely enter the editor, previews and exports. Idempotent. */
export function sanitizeSceneHTML(html) {
  if (!html) return '';
  const root = parseInert(html);
  sanitizeChildren(root);
  return root.innerHTML;
}
