'use strict';

const {
  app, BrowserWindow, globalShortcut,
  ipcMain, screen, shell
} = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Logger ────────────────────────────────────────────────────────────────────

let logPath;
const logs = [];
const MAX_LOGS = 200;

function log(level, ...args) {
  const ts  = new Date().toISOString();
  const msg = args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
    if (typeof a === 'object') try { return JSON.stringify(a); } catch { return String(a); }
    return String(a);
  }).join(' ');
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  logs.push({ ts, level, msg });
  if (logs.length > MAX_LOGS) logs.shift();
  if (logPath) try { fs.appendFileSync(logPath, line + '\n'); } catch (_) {}
  if (debugWin && !debugWin.isDestroyed()) {
    try { debugWin.webContents.send('log', { ts, level, msg }); } catch (_) {}
  }
}

const logger = {
  info:  (...a) => log('info',  ...a),
  warn:  (...a) => log('warn',  ...a),
  error: (...a) => log('error', ...a),
  debug: (...a) => log('debug', ...a),
};

process.on('uncaughtException',  e => logger.error('uncaughtException', e));
process.on('unhandledRejection', e => logger.error('unhandledRejection', e));

// Disable HTTP disk cache — prevents the "Unable to move cache: Access denied" error
// caused by Chromium trying to cache Google Fonts on restricted paths
app.commandLine.appendSwitch('disable-http-cache');
// Use the exe path as AppUserModelId so Windows uses the exe's embedded icon directly
app.setAppUserModelId(process.execPath);

// Returns the path to the ICO file for use directly in BrowserWindow({ icon: path })
// Passing a file path string to BrowserWindow.icon causes Electron to load the HICON
// natively via Windows API, which is more reliable than going through nativeImage.
function getIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'icon.ico');
  }
  return path.join(__dirname, 'build', 'icon.ico');
}

// ── Data persistence ──────────────────────────────────────────────────────────

let dataPath, settingsPath;

const DEFAULT_SETTINGS = {
  alwaysOnTop:     true,
  opacity:         0.95,
  accentColor:     'cyan',
  ticketUrl:       'https://halopsa.groupesl.com/ticket?id=',
  shortcuts:       { start: 'F6', pause: 'F7', stop: 'F8', history: 'F9' },
  dailyGoalHours:  0,
  alertMinutes:    0,
  showDebugTab:    false,
};

function getHistory() {
  try { return JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
  catch (e) { logger.warn('getHistory:', e.message); return []; }
}
function saveHistory(data) {
  try { fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { logger.error('saveHistory:', e); }
}
function getSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...s, shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(s.shortcuts || {}) } };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8'); }
  catch (e) { logger.error('saveSettings:', e); }
}

// ── Clamp overlay position to visible area ─────────────────────────────────── 

function clampOverlayPosition(x, y, w, h) {
  const displays = screen.getAllDisplays();
  // Check if position is on any display
  const onScreen = displays.some(d => {
    const b = d.workArea;
    return x < b.x + b.width && x + w > b.x && y < b.y + b.height && y + h > b.y;
  });
  if (onScreen) return { x, y };
  // Fall back to top-right of primary display
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  return { x: width - w - 20, y: 20 };
}

// ── Shortcuts ─────────────────────────────────────────────────────────────────

function registerShortcuts(shortcuts) {
  globalShortcut.unregisterAll();
  for (const [action, key] of Object.entries(shortcuts)) {
    if (!key) continue;
    try {
      globalShortcut.register(key, () => {
        if (action === 'history') createHistory();
        else if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('hotkey', action);
      });
      logger.info(`Shortcut [${key}] → ${action}`);
    } catch (e) { logger.warn(`Shortcut [${key}] failed: ${e.message}`); }
  }
}

// ── Windows ───────────────────────────────────────────────────────────────────

let overlayWin = null, historyWin = null, debugWin = null, detailWin = null, notesWin = null;

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    logger.info('[overlay] already exists — showing');
    overlayWin.show(); overlayWin.focus(); return;
  }
  try {
    logger.info('[overlay] creating window...');
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    const s  = getSettings();
    const ow = Math.min(Math.max(s.overlaySize?.width  || 300, 240), 480);
    const oh = Math.min(Math.max(s.overlaySize?.height || 220, 160), 320);
    const rawX = s.overlayPos?.x ?? (width - ow - 20);
    const rawY = s.overlayPos?.y ?? 20;
    const { x: ox, y: oy } = clampOverlayPosition(rawX, rawY, ow, oh);

    logger.debug(`[overlay] size=${ow}×${oh} pos=${ox},${oy} alwaysOnTop=${s.alwaysOnTop}`);

    overlayWin = new BrowserWindow({
      width: ow, height: oh, x: ox, y: oy,
      frame: false, show: false, transparent: true,
      alwaysOnTop: s.alwaysOnTop, skipTaskbar: false, resizable: true,
      minWidth: 240, minHeight: 160, maxWidth: 480, maxHeight: 320,
      icon: getIconPath(),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });

    overlayWin.loadFile('overlay.html');
    overlayWin.setAlwaysOnTop(s.alwaysOnTop, 'screen-saver');
    overlayWin.setOpacity(Math.max(0.1, Math.min(1, s.opacity)));

    // Debounced save on resize/move
    let persistTimer = null;
    const saveOverlayBounds = () => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        if (!overlayWin || overlayWin.isDestroyed()) return;
        const [w, h] = overlayWin.getSize();
        const [x, y] = overlayWin.getPosition();
        const cur = getSettings();
        cur.overlaySize = { width: w, height: h };
        cur.overlayPos  = { x, y };
        saveSettings(cur);
        logger.debug(`[overlay] bounds saved: ${w}×${h} @ ${x},${y}`);
      }, 400);
    };
    overlayWin.on('resize', saveOverlayBounds);
    overlayWin.on('moved',  saveOverlayBounds);
    overlayWin.once('ready-to-show', () => {
      overlayWin.show();
      logger.info('[overlay] visible');
    });
    overlayWin.on('show',         () => logger.info('[overlay] show'));
    overlayWin.on('hide',         () => logger.info('[overlay] hide'));
    overlayWin.on('focus',        () => logger.debug('[overlay] focus'));
    overlayWin.on('blur',         () => logger.debug('[overlay] blur'));
    overlayWin.on('closed',       () => { overlayWin = null; logger.info('[overlay] closed'); });
    overlayWin.on('unresponsive', () => logger.error('[overlay] UNRESPONSIVE'));
    overlayWin.on('responsive',   () => logger.info('[overlay] responsive again'));
    overlayWin.webContents.on('did-start-loading',  () => logger.debug('[overlay] loading'));
    overlayWin.webContents.on('did-finish-load',    () => logger.info('[overlay] load finished'));
    overlayWin.webContents.on('did-fail-load',      (_, code, desc) =>
      logger.error(`[overlay] load FAILED code=${code} "${desc}"`));
    overlayWin.webContents.on('console-message', (event) => {
      const lvl = ['debug','info','warn','error'][event.level] || 'info';
      if (event.message && !event.message.includes('Electron Security Warning'))
        logger.debug(`[overlay] console.${lvl}: ${event.message}`);
    });
    overlayWin.webContents.on('render-process-gone', (_, d) =>
      logger.error(`[overlay] RENDERER GONE reason="${d.reason}" exitCode=${d.exitCode}`));
    logger.info('[overlay] created');
  } catch (e) { logger.error('[overlay] createOverlay FAILED:', e); }
}

function createHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    logger.info('[history] already open — focusing');
    historyWin.focus(); return;
  }
  try {
    logger.info('[history] opening...');
    historyWin = _makeHistoryWin('Menu — Ticket Timer');
    logger.info('[history] created');
  } catch (e) { logger.error('[history] FAILED:', e); }
}

function createSettings() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.focus();
    historyWin.webContents.send('switch-tab', 'settings');
    return;
  }
  try {
    historyWin = _makeHistoryWin('Menu — Ticket Timer');
    historyWin.webContents.once('did-finish-load', () => {
      historyWin.webContents.send('switch-tab', 'settings');
    });
  } catch (e) { logger.error('[settings] FAILED:', e); }
}

function _makeHistoryWin(title) {
  const s = getSettings();
  const w = Math.max(s.windowSize?.width  || 900, 700);
  const h = Math.max(s.windowSize?.height || 640, 500);

  const win = new BrowserWindow({
    width: w, height: h, minWidth: 700, minHeight: 500, title,
    backgroundColor: '#080c12', skipTaskbar: false, icon: getIconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setMenu(null);
  win.loadFile('history.html');

  let resizeTimer = null;
  win.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [width, height] = win.getSize();
      const cur = getSettings();
      cur.windowSize = { width, height };
      saveSettings(cur);
      logger.debug(`[history] size saved: ${width}×${height}`);
    }, 400);
  });

  win.on('show',        () => logger.info(`[history] show`));
  win.on('focus',       () => logger.debug('[history] focus'));
  win.on('closed',      () => { historyWin = null; logger.info('[history] closed'); });
  win.on('unresponsive',() => logger.error('[history] UNRESPONSIVE'));
  win.on('responsive',  () => logger.info('[history] responsive'));
  win.webContents.on('did-finish-load', () => {
    logger.info('[history] load finished');
  });
  win.webContents.on('did-fail-load', (_, code, desc) =>
    logger.error(`[history] load FAILED code=${code} "${desc}"`));
  win.webContents.on('console-message', (event) => {
    const lvl = ['debug','info','warn','error'][event.level] || 'info';
    if (event.message && !event.message.includes('Electron Security Warning'))
      logger.debug(`[history] console.${lvl}: ${event.message}`);
  });
  win.webContents.on('render-process-gone', (_, d) =>
    logger.error(`[history] RENDERER GONE reason="${d.reason}" exitCode=${d.exitCode}`));
  return win;
}

function createTicketDetail(entry, index) {
  if (!entry || typeof entry !== 'object') {
    logger.warn('[detail] createTicketDetail called with invalid entry');
    return;
  }
  if (detailWin && !detailWin.isDestroyed()) detailWin.close();
  try {
    detailWin = new BrowserWindow({
      width: 600, height: 680,
      minWidth: 480, minHeight: 500,
      title: `Billet #${entry.ticket || '?'}`,
      backgroundColor: '#080c12', skipTaskbar: false,
      resizable: true, icon: getIconPath(),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    detailWin.setMenu(null);
    detailWin.loadFile('ticket-detail.html');
    detailWin.webContents.once('did-finish-load', () => {
      if (!detailWin || detailWin.isDestroyed()) return;
      detailWin.webContents.send('ticket-detail', { entry, index: index ?? -1 });
    });
    detailWin.on('closed', () => { detailWin = null; });
    logger.info(`[detail] opened #${entry.ticket} index=${index}`);
  } catch (e) { logger.error('[detail] FAILED:', e); }
}

function createDebug() {
  if (debugWin && !debugWin.isDestroyed()) { debugWin.focus(); return; }
  try {
    debugWin = new BrowserWindow({
      width: 720, height: 520, title: 'Debug — Ticket Timer',
      backgroundColor: '#080c12', skipTaskbar: true, icon: getIconPath(),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    debugWin.setMenu(null);
    debugWin.loadFile('debug.html');
    debugWin.on('closed', () => { debugWin = null; logger.info('[debug] closed'); });
    debugWin.webContents.on('did-finish-load', () => logger.info('[debug] load finished'));
    logger.info('[debug] created');
  } catch (e) { logger.error('[debug] FAILED:', e); }
}

function createSessionNotes(slotIndex, notes, ticket) {
  try {
    if (notesWin && !notesWin.isDestroyed()) {
      notesWin.focus();
      notesWin.webContents.send('session-notes-init', slotIndex, notes, ticket);
      return;
    }
    notesWin = new BrowserWindow({
      width: 500, height: 460, title: `Notes — Timer ${slotIndex + 1}`,
      backgroundColor: '#080c12', skipTaskbar: false, icon: getIconPath(),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    notesWin.setMenu(null);
    notesWin.loadFile('session-notes.html');
    notesWin.webContents.once('did-finish-load', () => {
      notesWin.webContents.send('session-notes-init', slotIndex, notes, ticket);
    });
    notesWin.on('closed', () => { notesWin = null; logger.info('[notes] closed'); });
    logger.info(`[notes] opened for slot ${slotIndex}`);
  } catch (e) { logger.error('[notes] createSessionNotes FAILED:', e); }
}

app.whenReady().then(() => {
  try {
    dataPath     = path.join(app.getPath('userData'), 'history.json');
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    logPath      = path.join(app.getPath('userData'), 'app.log');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });

    // Rotate log if > 1MB
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1_000_000)
        fs.renameSync(logPath, logPath + '.old');
    } catch (_) {}

    logger.info(`Starting v${app.getVersion()} — electron ${process.versions.electron}, node ${process.versions.node}, platform ${process.platform}, isPackaged=${app.isPackaged}, exe=${process.execPath}`);

    app.dock?.hide();
    createOverlay();
    createHistory();

    registerShortcuts(getSettings().shortcuts);
    logger.info('App ready');
  } catch (e) { logger.error('whenReady FAILED:', e); }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault());

// ── IPC: data ─────────────────────────────────────────────────────────────────

ipcMain.handle('save-entry', (_, entry) => {
  if (!entry || typeof entry !== 'object') throw new Error('Invalid entry');
  logger.info(`[ipc] save-entry ticket="${entry.ticket}" duration=${entry.duration_s}s`);
  try {
    const h = getHistory(); h.push(entry); saveHistory(h);
    logger.debug(`[ipc] save-entry OK total=${h.length}`);
  } catch (e) { logger.error('[ipc] save-entry FAILED:', e); throw e; }
});

ipcMain.handle('get-history', () => {
  logger.debug('[ipc] get-history');
  try { const h = getHistory(); logger.debug(`[ipc] get-history OK ${h.length} entries`); return h; }
  catch (e) { logger.error('[ipc] get-history FAILED:', e); return []; }
});

ipcMain.handle('clear-history', () => {
  logger.info('[ipc] clear-history');
  try { saveHistory([]); logger.info('[ipc] clear-history OK'); }
  catch (e) { logger.error('[ipc] clear-history FAILED:', e); }
});

ipcMain.handle('delete-entry', (_, i) => {
  if (typeof i !== 'number' || i < 0) { logger.warn('[ipc] delete-entry invalid index:', i); return; }
  logger.info(`[ipc] delete-entry index=${i}`);
  try {
    const h = getHistory(); h.splice(i, 1); saveHistory(h);
    logger.debug(`[ipc] delete-entry OK remaining=${h.length}`);
  } catch (e) { logger.error('[ipc] delete-entry FAILED:', e); }
});

ipcMain.handle('update-entry', (_, index, entry) => {
  if (typeof index !== 'number' || index < 0) { logger.warn('[ipc] update-entry invalid index:', index); return; }
  logger.info(`[ipc] update-entry index=${index} ticket=${entry?.ticket}`);
  try {
    const h = getHistory();
    if (index >= h.length) { logger.warn('[ipc] update-entry index out of range:', index); return; }
    h[index] = entry;
    saveHistory(h);
    if (historyWin && !historyWin.isDestroyed()) historyWin.webContents.send('history-updated');
    logger.debug('[ipc] update-entry OK');
  } catch (e) { logger.error('[ipc] update-entry FAILED:', e); }
});

ipcMain.handle('export-csv', (_, data) => {
  if (!Array.isArray(data)) throw new Error('Invalid data');
  logger.info(`[ipc] export-csv ${data.length} rows`);
  try {
    const dest = path.join(app.getPath('downloads'), `ticket_timer_${new Date().toISOString().slice(0, 10)}.csv`);
    const header = 'Date,Heure,Billet,Note,Durée,Secondes\n';
    const rows = data.map(e => {
      const note = (e.note || '').replace(/"/g, '""');
      return `${e.date || ''},${e.time || ''},"${e.ticket || ''}","${note}",${e.duration || ''},${e.duration_s || 0}`;
    }).join('\n');
    fs.writeFileSync(dest, '\uFEFF' + header + rows, 'utf8');
    shell.showItemInFolder(dest);
    logger.info(`[ipc] export-csv OK ${dest}`);
    return dest;
  } catch (e) { logger.error('[ipc] export-csv FAILED:', e); throw e; }
});

// ── IPC: window ───────────────────────────────────────────────────────────────

ipcMain.on('open-session-notes', (_, { slotIndex, notes, ticket }) => {
  logger.info(`[ipc] open-session-notes slot=${slotIndex}`);
  createSessionNotes(slotIndex, notes, ticket);
});
ipcMain.on('save-session-notes', (_, { slotIndex, notes }) => {
  logger.debug(`[ipc] save-session-notes slot=${slotIndex} len=${notes?.length}`);
  // Forward to overlay so it updates its slot state
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('session-notes-updated', slotIndex, notes);
  }
});
ipcMain.on('open-history',       () => { logger.info('[ipc] open-history'); createHistory(); });
ipcMain.on('open-debug',         () => { logger.info('[ipc] open-debug');   createDebug();   });
ipcMain.on('open-ticket-detail', (_, payload) => {
  const entry = payload?.entry ?? payload;
  const index = payload?.index ?? -1;
  logger.info(`[ipc] open-ticket-detail #${entry?.ticket} index=${index}`);
  createTicketDetail(entry, index);
});
ipcMain.on('show-overlay', () => {
  logger.info('[ipc] show-overlay');
  if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
  else { overlayWin.show(); overlayWin.focus(); }
});
ipcMain.on('hide-overlay', () => { logger.info('[ipc] hide-overlay'); overlayWin?.hide(); });
ipcMain.on('quit-app',     () => { logger.info('[ipc] quit-app'); app.quit(); });
ipcMain.on('toggle-collapse', () => {
  if (!overlayWin || overlayWin.isDestroyed()) { logger.warn('[ipc] toggle-collapse — no overlay'); return; }
  if (overlayWin.isMinimized()) {
    overlayWin.restore();
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    logger.info('[ipc] toggle-collapse → restore');
  } else {
    overlayWin.minimize();
    logger.info('[ipc] toggle-collapse → minimize');
  }
});
ipcMain.on('reset-position', () => {
  logger.info('[ipc] reset-position');
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const [w] = overlayWin.getSize();
  overlayWin.setPosition(width - w - 20, 20);
});
ipcMain.on('resize-overlay', (_, { w, h }) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  logger.debug(`[ipc] resize-overlay ${w}×${h}`);
  overlayWin.setSize(Math.round(w), Math.round(h));
});
ipcMain.on('restore-overlay', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const s = getSettings();
  const w = Math.min(Math.max(s.overlaySize?.width  || 300, 240), 480);
  const h = Math.min(Math.max(s.overlaySize?.height || 220, 160), 320);
  logger.debug(`[ipc] restore-overlay ${w}×${h}`);
  overlayWin.setSize(w, h);
});
ipcMain.on('drag-window', (_, { dx, dy }) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setPosition(x + dx, y + dy);
});

// ── IPC: settings ─────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
  logger.debug('[ipc] get-settings');
  try {
    const s = getSettings();
    logger.debug(`[ipc] get-settings OK accentColor=${s.accentColor} alwaysOnTop=${s.alwaysOnTop}`);
    return s;
  } catch (e) { logger.error('[ipc] get-settings FAILED:', e); return { ...DEFAULT_SETTINGS }; }
});

ipcMain.handle('save-settings', (_, s) => {
  if (!s || typeof s !== 'object') throw new Error('Invalid settings');
  logger.info(`[ipc] save-settings accentColor=${s.accentColor} alwaysOnTop=${s.alwaysOnTop} opacity=${s.opacity}`);
  try {
    // Preserve geometry fields not managed by the settings UI
    const existing = getSettings();
    const merged = { ...s, overlaySize: existing.overlaySize, overlayPos: existing.overlayPos, windowSize: existing.windowSize };
    saveSettings(merged);
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setAlwaysOnTop(s.alwaysOnTop, 'screen-saver');
      overlayWin.setOpacity(Math.max(0.1, Math.min(1, s.opacity)));
      overlayWin.webContents.send('apply-settings', {
        accentColor:  s.accentColor,
        shortcuts:    s.shortcuts,
        alertMinutes: s.alertMinutes || 0,
      });
    }
    registerShortcuts(s.shortcuts);
    logger.info('[ipc] save-settings OK');
  } catch (e) { logger.error('[ipc] save-settings FAILED:', e); throw e; }
});

// ── IPC: debug ────────────────────────────────────────────────────────────────

ipcMain.handle('get-logs',     () => { logger.debug('[ipc] get-logs'); return [...logs]; });
ipcMain.handle('get-log-path', () => logPath);
ipcMain.handle('clear-logs',   () => {
  logs.length = 0;
  try { fs.writeFileSync(logPath, ''); } catch (_) {}
  logger.info('[ipc] logs cleared');
});
ipcMain.on('renderer-log',  (_, { level, msg }) => log(level || 'debug', `[renderer] ${msg}`));
ipcMain.on('open-log-file', (_, p) => {
  if (!p || typeof p !== 'string') return;
  logger.info(`[ipc] open-log-file ${p}`);
  try { shell.showItemInFolder(p); }
  catch (e) { logger.warn('[ipc] open-log-file FAILED:', e.message); }
});
ipcMain.on('open-external', (_, url) => {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    logger.warn('[ipc] open-external blocked invalid URL:', url); return;
  }
  logger.info(`[ipc] open-external ${url}`);
  shell.openExternal(url).catch(e => logger.error('[ipc] open-external FAILED:', e));
});