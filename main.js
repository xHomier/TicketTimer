'use strict';

const {
  app, BrowserWindow, globalShortcut,
  ipcMain, Tray, Menu, nativeImage, screen, shell
} = require('electron');
const path = require('path');
const fs   = require('fs');
const zlib = require('zlib');

// ── PNG helpers (pure Node, zero deps) ───────────────────────────────────────

function crc32(buf) {
  const t = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length);
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

function buildPng(rows, S) {
  const compressed = zlib.deflateSync(Buffer.from(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function makeAppIcon() {
  const S = 32, cx = S / 2, cy = S / 2, R = S / 2 - 1;
  const rows = [];
  for (let y = 0; y < S; y++) {
    rows.push(0);
    for (let x = 0; x < S; x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= R - 2.5 && r <= R) {
        rows.push(0, 229, 255, 255);
      } else if (r < R - 2.5) {
        const angle = Math.atan2(dy, dx);
        const hourA = -Math.PI / 2 - Math.PI / 4;
        const minA  = -Math.PI / 2 + Math.PI / 3;
        const dH = Math.abs(Math.atan2(Math.sin(angle - hourA), Math.cos(angle - hourA)));
        const dM = Math.abs(Math.atan2(Math.sin(angle - minA),  Math.cos(angle - minA)));
        if ((dH < 0.18 && r > 2 && r < R * 0.52) || (dM < 0.13 && r > 2 && r < R * 0.72)) {
          rows.push(0, 229, 255, 230);
        } else {
          rows.push(8, 17, 32, 240);
        }
      } else {
        rows.push(0, 0, 0, 0);
      }
    }
  }
  return buildPng(rows, S);
}

// ── Data persistence ──────────────────────────────────────────────────────────

let dataPath;
let settingsPath;

const DEFAULT_SETTINGS = {
  alwaysOnTop:      true,
  opacity:          0.95,
  startWithWindows: false,
  accentColor:      'cyan',
  shortcuts: {
    start:   'F6',
    pause:   'F7',
    stop:    'F8',
    history: 'F9',
  },
};

function getHistory() {
  try { return JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
  catch { return []; }
}
function saveHistory(data) {
  try { fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('Save error:', e.message); }
}
function getSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...s, shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(s.shortcuts || {}) } };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8'); }
  catch (e) { console.error('Settings save error:', e.message); }
}

// ── Global shortcuts management ───────────────────────────────────────────────

function registerShortcuts(shortcuts) {
  globalShortcut.unregisterAll();
  for (const [action, key] of Object.entries(shortcuts)) {
    if (!key) continue;
    try {
      globalShortcut.register(key, () => {
        if (action === 'history') {
          createHistory();
        } else if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('hotkey', action);
        }
      });
    } catch (e) {
      console.warn(`Could not register [${key}]:`, e.message);
    }
  }
}

// ── Windows ───────────────────────────────────────────────────────────────────

let overlayWin = null;
let historyWin = null;
let tray       = null;

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.show();
    overlayWin.focus();
    return;
  }

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const settings  = getSettings();

  overlayWin = new BrowserWindow({
    width:       300,
    height:      190,
    x:           width - 320,
    y:           20,
    frame:       false,
    transparent: true,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    resizable:   false,
    icon:        makeAppIcon(),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  overlayWin.loadFile('overlay.html');
  overlayWin.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  overlayWin.setOpacity(settings.opacity);
  overlayWin.on('closed', () => { overlayWin = null; });
}

function createHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.focus();
    return;
  }
  historyWin = new BrowserWindow({
    width:           640,
    height:          600,
    title:           'Ticket Timer',
    backgroundColor: '#080c12',
    frame:           true,
    skipTaskbar:     true,
    icon:            makeAppIcon(),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  historyWin.setMenu(null);
  historyWin.loadFile('history.html');
  historyWin.on('closed', () => { historyWin = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  dataPath     = path.join(app.getPath('userData'), 'history.json');
  settingsPath = path.join(app.getPath('userData'), 'settings.json');

  app.dock?.hide(); // macOS

  createOverlay();

  // Tray
  try {
    tray = new Tray(makeAppIcon());
    tray.setToolTip('Ticket Timer');
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: 'Afficher l\'overlay',
        click: () => {
          if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
          else { overlayWin.show(); overlayWin.focus(); }
        },
      },
      {
        label: 'Masquer l\'overlay',
        click: () => overlayWin?.hide(),
      },
      { type: 'separator' },
      { label: 'Historique & Paramètres', click: createHistory },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ]));

    // Left-click: toggle overlay
    tray.on('click', () => {
      if (!overlayWin || overlayWin.isDestroyed()) {
        createOverlay();
      } else if (overlayWin.isVisible()) {
        overlayWin.hide();
      } else {
        overlayWin.show();
        overlayWin.focus();
      }
    });
  } catch (e) {
    console.warn('Tray unavailable:', e.message);
  }

  registerShortcuts(getSettings().shortcuts);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault());

// ── IPC: data ─────────────────────────────────────────────────────────────────

ipcMain.handle('save-entry', (_, entry) => {
  const h = getHistory(); h.push(entry); saveHistory(h);
});
ipcMain.handle('get-history',   () => getHistory());
ipcMain.handle('clear-history', () => saveHistory([]));
ipcMain.handle('delete-entry',  (_, i) => {
  const h = getHistory(); h.splice(i, 1); saveHistory(h);
});
ipcMain.handle('export-csv', (_, data) => {
  const dest = path.join(
    app.getPath('downloads'),
    `ticket_timer_${new Date().toISOString().slice(0, 10)}.csv`
  );
  const rows = data.map(e => `${e.date},${e.time},"${e.ticket}",${e.duration},${e.duration_s}`).join('\n');
  fs.writeFileSync(dest, '\uFEFF' + 'Date,Heure,Billet,Durée,Secondes\n' + rows, 'utf8');
  shell.showItemInFolder(dest);
  return dest;
});

// ── IPC: window control ───────────────────────────────────────────────────────

ipcMain.on('open-history',    () => createHistory());
ipcMain.on('hide-overlay',    () => overlayWin?.hide());
ipcMain.on('quit-app',        () => app.quit());
ipcMain.on('toggle-collapse', () => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayWin.isVisible()) overlayWin.hide();
  else { overlayWin.show(); overlayWin.focus(); }
});
ipcMain.on('reset-position',  () => {
  if (!overlayWin) return;
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlayWin.setPosition(width - 320, 20);
});
ipcMain.on('drag-window', (_, { dx, dy }) => {
  if (!overlayWin) return;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setPosition(x + dx, y + dy);
});

// ── IPC: settings ─────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => getSettings());

ipcMain.handle('save-settings', (_, s) => {
  saveSettings(s);

  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setAlwaysOnTop(s.alwaysOnTop, 'screen-saver');
    overlayWin.setOpacity(Math.max(0.1, Math.min(1, s.opacity)));
    overlayWin.webContents.send('apply-settings', { accentColor: s.accentColor, shortcuts: s.shortcuts });
  }

  registerShortcuts(s.shortcuts);

  if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    try {
      if (s.startWithWindows) {
        const cmd = `"${process.execPath}" "${path.join(__dirname, 'main.js')}"`;
        execSync(`reg add "${regKey}" /v TicketTimer /t REG_SZ /d "${cmd}" /f`);
      } else {
        execSync(`reg delete "${regKey}" /v TicketTimer /f 2>nul`);
      }
    } catch (_) {}
  }
});
