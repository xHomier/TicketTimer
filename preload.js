'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Hotkeys & settings updates
  onHotkey:              cb => ipcRenderer.on('hotkey',                (_, a)    => cb(a)),
  onApplySettings:       cb => ipcRenderer.on('apply-settings',        (_, s)    => cb(s)),
  onSwitchTab:           cb => ipcRenderer.on('switch-tab',            (_, t)    => cb(t)),
  onLog:                 cb => ipcRenderer.on('log',                   (_, e)    => cb(e)),
  onSessionNotesInit:    cb => ipcRenderer.on('session-notes-init',    (_, i, n, t) => cb(i, n, t)),
  onSessionNotesUpdated: cb => ipcRenderer.on('session-notes-updated',  (_, i, n)    => cb(i, n)),
  onTicketDetail:        cb => ipcRenderer.once('ticket-detail',         (_, p)       => cb(p)),
  onHistoryUpdated:      cb => ipcRenderer.on('history-updated',         ()           => cb()),

  // Data
  saveEntry:    e       => ipcRenderer.invoke('save-entry', e),
  getHistory:   ()      => ipcRenderer.invoke('get-history'),
  clearHistory: ()      => ipcRenderer.invoke('clear-history'),
  deleteEntry:  i       => ipcRenderer.invoke('delete-entry', i),
  updateEntry:  (i, e)  => ipcRenderer.invoke('update-entry', i, e),
  exportCsv:    d       => ipcRenderer.invoke('export-csv', d),

  // Settings
  getSettings:  ()  => ipcRenderer.invoke('get-settings'),
  saveSettings: s   => ipcRenderer.invoke('save-settings', s),

  // Debug
  getLogs:      ()  => ipcRenderer.invoke('get-logs'),
  getLogPath:   ()  => ipcRenderer.invoke('get-log-path'),
  clearLogs:    ()  => ipcRenderer.invoke('clear-logs'),
  openLogFile:  p   => ipcRenderer.send('open-log-file', p),

  // Session notes
  openSessionNotes: (slotIndex, notes, ticket) => ipcRenderer.send('open-session-notes', { slotIndex, notes, ticket }),
  saveSessionNotes: (slotIndex, notes)          => ipcRenderer.send('save-session-notes', { slotIndex, notes }),

  // External & detail
  openExternal:      url   => ipcRenderer.send('open-external', url),
  openTicketDetail:  entry => ipcRenderer.send('open-ticket-detail', entry),

  // Renderer logging
  rendererLog: (level, msg) => ipcRenderer.send('renderer-log', { level, msg }),

  // Window
  openHistory:    ()       => ipcRenderer.send('open-history'),
  openDebug:      ()       => ipcRenderer.send('open-debug'),
  hideOverlay:    ()       => ipcRenderer.send('hide-overlay'),
  showOverlay:    ()       => ipcRenderer.send('show-overlay'),
  quitApp:        ()       => ipcRenderer.send('quit-app'),
  toggleCollapse: ()       => ipcRenderer.send('toggle-collapse'),
  resetPosition:  ()       => ipcRenderer.send('reset-position'),
  resizeOverlay:  (w, h)   => ipcRenderer.send('resize-overlay', { w, h }),
  restoreOverlay: ()       => ipcRenderer.send('restore-overlay'),
  dragWindow:     (dx, dy) => ipcRenderer.send('drag-window', { dx, dy }),
});
