'use strict';
/**
 * Nanute — Main Process
 *
 * Manages:
 *   - Frameless transparent always-on-top overlay window
 *   - System tray icon (PNG generated on-the-fly — no external assets)
 *   - IPC handlers (mode switch, mouse passthrough, hide/show)
 *   - Single-instance lock
 *   - Clean shutdown
 *
 * Performance guarantees:
 *   - Window is non-focusable in compact mode (doesn't steal focus)
 *   - Mouse passthrough enabled by default (forward:true)
 *   - RAM: ~45 MB typical (Electron minimum)
 *   - CPU/GPU idle: <0.3% (renderer throttles RAF to 5–30 fps in idle states)
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
} = require('electron');
const path = require('path');
const zlib = require('zlib');

// ── Single instance ────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// ── Constants ──────────────────────────────────────────────────────────────
const COMPACT_W  = 80;
const COMPACT_H  = 80;
const EXPANDED_W = 380;
const EXPANDED_H = 480;

// ── App state ──────────────────────────────────────────────────────────────
let win        = null;
let tray       = null;
let isVisible  = true;
let isPaused   = false;
let isExpanded = false;

// ── PNG generator — no file, no external deps ──────────────────────────────
// Produces a valid RGBA PNG in memory using Node's built-in zlib.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tb  = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}

/**
 * Generate a solid-color anti-aliased circle PNG.
 * @param {number} size  image width & height in pixels
 * @param {number} r  red   0–255
 * @param {number} g  green 0–255
 * @param {number} b  blue  0–255
 * @returns {Buffer} PNG byte buffer
 */
function makeCirclePNG(size, r, g, b) {
  const cx = size / 2, cy = size / 2;
  const radius = size / 2 - 1.5;
  const rowLen = 1 + size * 4; // filter byte + RGBA per pixel
  const raw    = Buffer.alloc(size * rowLen, 0);

  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      // Sub-pixel distance for anti-aliased edge
      const dx   = x - cx + 0.5;
      const dy   = y - cy + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let alpha  = 0;
      if (dist < radius - 1)  alpha = 255;
      else if (dist < radius) alpha = Math.round(255 * (radius - dist));
      const off = y * rowLen + 1 + x * 4;
      raw[off]     = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = alpha;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Window position helpers ────────────────────────────────────────────────

function getWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

function compactPos() {
  const { x, y, width } = getWorkArea();
  return { x: x + Math.round(width / 2 - COMPACT_W / 2), y: y + 12 };
}

function expandedPos() {
  const { x, y, width } = getWorkArea();
  return { x: x + Math.round(width / 2 - EXPANDED_W / 2), y: y + 12 };
}

// ── Window ────────────────────────────────────────────────────────────────

function createWindow() {
  const { x, y } = compactPos();

  win = new BrowserWindow({
    x,
    y,
    width:       COMPACT_W,
    height:      COMPACT_H,
    transparent: true,
    frame:       false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   false,
    movable:     false,   // we handle positioning via IPC
    hasShadow:   false,
    focusable:   false,   // compact mode: never steal focus
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      sandboxed:            false,      // preload needs require()
      devTools:             !app.isPackaged,
      backgroundThrottling: false,      // keep RAF alive when not focused
    },
  });

  // Keep above fullscreen apps (but not exclusive fullscreen)
  win.setAlwaysOnTop(true, 'screen-saver');

  // Mouse passthrough on by default; forward:true so renderer still sees mousemove
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Close event → minimise to tray instead of quitting
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
      isVisible = false;
      refreshTray();
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: isVisible ? 'Ocultar' : 'Mostrar',
      click: toggleVisibility,
    },
    { type: 'separator' },
    {
      label: isPaused ? '▶  Continuar' : '⏸  Pausar',
      click: togglePause,
    },
    { type: 'separator' },
    {
      label:   'Modo Compacto',
      type:    'radio',
      checked: !isExpanded,
      click:   () => setMode('compact'),
    },
    {
      label:   'Modo Expandido',
      type:    'radio',
      checked: isExpanded,
      click:   () => setMode('expanded'),
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildMenu());
}

function createTray() {
  // Generate tray icon programmatically — blue circle, 16×16
  const pngBuf = makeCirclePNG(16, 100, 180, 255);
  const icon   = nativeImage.createFromBuffer(pngBuf);

  tray = new Tray(icon);
  tray.setToolTip('Nanute · Assistente Pessoal');
  tray.setContextMenu(buildMenu());

  // Left-click toggles visibility
  tray.on('click',        toggleVisibility);
  tray.on('double-click', toggleVisibility);
}

// ── Actions ───────────────────────────────────────────────────────────────

function toggleVisibility() {
  if (isVisible) {
    win.hide();
    isVisible = false;
  } else {
    win.show();
    isVisible = true;
    // Restore always-on-top after hide/show cycle
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  refreshTray();
}

function togglePause() {
  isPaused = !isPaused;
  win.webContents.send('command', isPaused ? 'pause' : 'resume');
  refreshTray();
}

function setMode(mode) {
  const toExpanded = (mode === 'expanded');
  if (toExpanded === isExpanded) return; // no-op
  isExpanded = toExpanded;

  if (toExpanded) {
    const { x, y } = expandedPos();
    win.setFocusable(true);
    win.setIgnoreMouseEvents(false);
    win.setSize(EXPANDED_W, EXPANDED_H);
    win.setPosition(x, y);
    win.focus();
    win.webContents.send('command', 'mode:expanded');
  } else {
    const { x, y } = compactPos();
    win.setSize(COMPACT_W, COMPACT_H);
    win.setPosition(x, y);
    win.webContents.send('command', 'mode:compact');
    // Delay making window non-focusable so renderer CSS transition can run
    setTimeout(() => {
      if (!isExpanded) {
        win.setFocusable(false);
        win.setIgnoreMouseEvents(true, { forward: true });
      }
    }, 520);
  }
  refreshTray();
}

// ── IPC handlers ──────────────────────────────────────────────────────────

function setupIPC() {
  // Renderer tells us cursor is over the orb → disable passthrough
  ipcMain.on('mouse:capture', () => {
    if (win && !isExpanded) win.setIgnoreMouseEvents(false);
  });

  // Renderer tells us cursor left the orb → re-enable passthrough
  ipcMain.on('mouse:ignore', () => {
    if (win && !isExpanded) win.setIgnoreMouseEvents(true, { forward: true });
  });

  // Renderer triggered expand (user clicked orb)
  ipcMain.on('overlay:expand', () => setMode('expanded'));

  // Renderer triggered collapse (user clicked close or pressed Escape)
  ipcMain.on('overlay:compact', () => setMode('compact'));

  // Renderer requested hide (future use)
  ipcMain.on('overlay:hide', () => {
    isVisible = false;
    win.hide();
    refreshTray();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setAppUserModelId('com.nanute.overlay');

  createWindow();
  createTray();
  setupIPC();

  // Restore window if a second instance is launched
  app.on('second-instance', () => {
    if (win && !isVisible) toggleVisibility();
  });
});

// Prevent Electron's default quit-when-last-window-closes behaviour
app.on('window-all-closed', (e) => e.preventDefault());

app.on('before-quit', () => {
  app.isQuitting = true;
});
