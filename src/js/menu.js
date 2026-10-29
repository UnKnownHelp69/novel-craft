/* The native menu (build_menu in lib.rs) emits a `menu` event whose payload is the clicked
   item's id; the ids below must match the MenuItem ids there. "Open Recent" items carry
   "recent:<path>". That submenu is built once at launch, and the backend grants those
   paths at the same time, so loading one passes check_path. Menu clicks are ignored while
   a native file dialog is pending. */
import { hasTauri, listen, nativeDialogOpen, TAURI } from './bridge.js';
import { $ } from './dom.js';
import { guardUnsaved, loadFromPath } from './novel-file.js';
import { focusMode, setFocus } from './panels.js';
import { confirmModal } from './dialogs.js';
import { doOpen, doSave, newProject } from './save.js';
import { doExport } from './export.js';
import { doExportNotes } from './notes.js';
import { openCompile } from './compile.js';
import { openBackups } from './backups.js';
import { refreshMaxIcon, requestClose } from './window-controls.js';

export function init() {
  if (hasTauri) {
    listen('menu', e => {
      if (nativeDialogOpen) return;
      const p = e.payload;
      if (typeof p === 'string' && p.startsWith('recent:')) {
        const path = p.slice(7);
        guardUnsaved(() => loadFromPath(path), 'Discard unsaved changes and open this file?');
        return;
      }
      switch (p) {
        case 'new': newProject(); break;
        case 'open': doOpen(); break;
        case 'save': doSave(false); break;
        case 'save_as': doSave(true); break;
        case 'restore_backup': openBackups(); break;
        case 'compile': openCompile(); break;
        case 'export_txt': doExport('txt'); break;
        case 'export_html': doExport('html'); break;
        case 'export_md': doExport('md'); break;
        case 'export_notes_txt': doExportNotes('txt'); break;
        case 'export_notes_md': doExportNotes('md'); break;
        case 'undo': document.execCommand('undo'); break;
        case 'redo': document.execCommand('redo'); break;
        case 'toggle_focus': setFocus(!focusMode); break;
        case 'toggle_panels': $('#toggleLeft').click(); $('#toggleRight').click(); break;
        case 'about': confirmModal('About NovelCraft', 'NovelCraft — a distraction-free novel writing studio. Built with Tauri.', () => {}); break;
      }
    });

    /* OS-level close (Alt+F4, taskbar, native title bar) goes through the unsaved-changes
       dialog too. The window is then closed by close_window, which destroys it without
       raising another CloseRequested. */
    const win = TAURI.window.getCurrentWindow();
    win.onCloseRequested(ev => {
      ev.preventDefault();
      requestClose();
    });
    /* keep the maximize icon in sync when the OS changes the window state */
    win.onResized(() => refreshMaxIcon());
  }
}
