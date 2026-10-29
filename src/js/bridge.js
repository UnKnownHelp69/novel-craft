/* The Tauri bridge, with a graceful browser fallback: in a plain browser invoke() resolves to null and listen() to a no-op unlisten, so `src/`
   still runs without the backend; anything that needs a real result checks hasTauri. */
export const TAURI = window.__TAURI__ || null;
export const hasTauri = !!TAURI;
export const invoke = hasTauri ? TAURI.core.invoke : async () => null;
export const listen = hasTauri ? TAURI.event.listen : async () => () => {};

/* Native file dialogs (pick_open / pick_save). They run off the main thread, so the window
   stays live behind them; on Linux they cannot even be made modal. While one is pending the
   window is shielded (body.native-dialog blocks the mouse, the capture listener below the
   keyboard), so nothing can edit, close or open behind a pending save or open. */
export let nativeDialogOpen = false;
export async function pickPath(cmd, args) {
  nativeDialogOpen = true;
  document.body.classList.add('native-dialog');
  try { return await invoke(cmd, args); }
  finally { nativeDialogOpen = false; document.body.classList.remove('native-dialog'); }
}

export function init() {
  document.addEventListener('keydown', e => {
    if (nativeDialogOpen) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
