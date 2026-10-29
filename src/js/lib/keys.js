/* The key a shortcut is matched against. e.key follows the active layout, so on a Russian
   layout Ctrl+S arrives as 'ы' and Ctrl+G as 'п'; for anything that is not plain ASCII the
   physical key (e.code) is used instead. Latin layouts (QWERTY, AZERTY, Dvorak) keep
   their own letters. The key that types '/' on US keyboards types '.' on a Russian one,
   so that press counts as '/' (other layouts' characters on that key are left alone).
   Alt/AltGr combinations always keep their own character. */
export function shortcutKey(e) {
  const key = String(e.key || '');
  // No shortcut here uses Alt, and on Windows AltGr arrives as Ctrl+Alt: AltGr+S types 'ś'
  // on a Polish layout and must stay a letter, not turn into Ctrl+S.
  if (e.altKey || (e.getModifierState && e.getModifierState('AltGraph'))) return key;
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  if (key.length === 1 && key.charCodeAt(0) < 128) {
    return !e.shiftKey && e.code === 'Slash' && key === '.' ? '/' : key;
  }
  const m = /^Key([A-Z])$/.exec(e.code || '');
  if (m) return m[1].toLowerCase();
  if (e.code === 'Backslash') return '\\';
  if (e.code === 'Slash') return '/';
  return key;
}
