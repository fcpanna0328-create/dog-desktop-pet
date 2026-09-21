const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let win = null;

// ---- 設定（いまはエフェクトのオン/オフだけ） ----
// ユーザーごとの保存場所に置くので、アプリを入れ直しても残る。
const SETTINGS_DEFAULTS = { effects: true };
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (e) {
    return { ...SETTINGS_DEFAULTS };
  }
}
function saveSettings(next) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch (e) {
    // 保存できなくても動きは止めない
  }
}
let settings = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  // Scaled to 2/3 of the original 260x300 size (looks cuter smaller).
  const winW = 173;
  const winH = 200;
  const startX = Math.round(screenW - winW - 40);
  const startY = Math.round(screenH - winH);

  win = new BrowserWindow({
    width: winW,
    height: winH,
    x: startX,
    y: startY,
    minWidth: winW,
    minHeight: winH,
    maxWidth: winW,
    maxHeight: winH,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep the dog above the dock/taskbar and other normal windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile('index.html');

  // The dog has no close button of its own; if something ever tries to
  // close the window, just hide it instead of quitting the whole app
  // (the tray icon is still there to bring it back or quit for real).
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  // Renderer asks main process to shift the window horizontally
  // (used for the "walk" animation).
  ipcMain.on('move-window-by', (_event, dx) => {
    if (!win) return;
    const bounds = win.getBounds();
    let newX = bounds.x + dx;
    const maxX = screenW - bounds.width;
    if (newX < 0) newX = 0;
    if (newX > maxX) newX = maxX;
    win.setBounds({
      x: Math.round(newX),
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
    lastWindowMoveAt = Date.now();
  });

  ipcMain.handle('get-settings', () => settings);

  ipcMain.handle('get-screen-info', () => ({
    screenW,
    screenH,
    winW,
    winH,
  }));

  // Manual drag support (see preload.js/renderer.js/style.css): the
  // renderer tracks mouse movement itself and asks us to move the window
  // to an absolute position, rather than relying on
  // -webkit-app-region: drag (which breaks custom cursors on macOS).
  ipcMain.on('get-window-bounds-sync', (event) => {
    event.returnValue = win ? win.getBounds() : { x: 0, y: 0, width: winW, height: winH };
  });

  ipcMain.on('move-window-to', (_event, { x, y }) => {
    if (!win) return;
    const bounds = win.getBounds();
    const maxX = screenW - bounds.width;
    const maxY = screenH - bounds.height;
    let newX = Math.round(x);
    let newY = Math.round(y);
    if (newX < 0) newX = 0;
    if (newX > maxX) newX = maxX;
    if (newY < 0) newY = 0;
    if (newY > maxY) newY = maxY;
    win.setBounds({
      x: newX,
      y: newY,
      width: bounds.width,
      height: bounds.height,
    });
    lastWindowMoveAt = Date.now();
  });

  startCursorWatcher();
}

const CURSOR_POLL_MS = 150;

// Polls the global mouse position and tells the renderer whether the
// cursor is literally over the dog's window right now -- that's the one
// signal driving the "petting" interaction (deliberately not a wider
// proximity radius: the dog only reacts when actually touched).
function startCursorWatcher() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;

    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();

    const over = cursor.x >= bounds.x
      && cursor.x <= bounds.x + bounds.width
      && cursor.y >= bounds.y
      && cursor.y <= bounds.y + bounds.height;

    updateHoverFocus(over, cursor);
    win.webContents.send('cursor-status', { over });
  }, CURSOR_POLL_MS);
}

// ---- Hand cursor support (macOS) ----
//
// macOS refuses to let an inactive application change the mouse cursor:
// NSCursor.set()/cursorUpdate/cursorRects are all ignored unless the app
// is frontmost. This mascot hides its Dock icon and normally sits in the
// background, so the `cursor: grab` in style.css never got a chance to
// render and the pointer stayed a plain arrow.
//
// The workaround is to briefly make this app frontmost while the cursor
// is resting on the dog, then hand activation straight back to whatever
// app the user was in. A short dwell time keeps the pointer merely
// passing over the dog from stealing focus.

const HOVER_ACTIVATE_MS = 300; // cursor must rest on the dog this long
const LEAVE_RESTORE_MS = 400; // grace period before handing focus back
const MOVE_SETTLE_MS = 3000; // don't hand focus back mid-walk
const CURSOR_MOVED_PX = 20; // cursor travel that counts as "user moved away"

// Our own bundle, so we never try to "restore" focus to ourselves.
const OWN_BUNDLE = (() => {
  const exe = app.getPath('exe');
  const i = exe.indexOf('.app/');
  return i === -1 ? null : exe.slice(0, i + 4);
})();

let overSince = null;
let awaySince = null;
let stealPending = false;
let stolenFrom = null; // { bundlePath, pid } of the app we took focus from
let lastWindowMoveAt = 0;
let lastOverCursor = null; // where the cursor sat the last time it was on the dog

// Frontmost app, via lsappinfo. Unlike the AppleScript route (System
// Events), this needs no Automation permission, so the user never sees a
// consent dialog.
function getFrontmostApp(callback) {
  execFile('/bin/sh', ['-c',
    'ASN=$(/usr/bin/lsappinfo front); /usr/bin/lsappinfo list | '
    + 'awk -v asn="$ASN" \'index($0, asn) { found=1 } '
    + 'found && /bundle path=/ { p=$0; sub(/^.*bundle path="/,"",p); sub(/".*$/,"",p) } '
    + 'found && /pid = / { q=$0; sub(/^.*pid = /,"",q); sub(/ .*$/,"",q); print p "\\n" q; exit }\'',
  ], { timeout: 2000 }, (err, stdout) => {
    if (err) return callback(null);
    const [bundlePath, pid] = String(stdout).trim().split('\n');
    if (!bundlePath) return callback(null);
    callback({ bundlePath, pid: Number(pid) || 0 });
  });
}

function updateHoverFocus(over, cursor) {
  if (process.platform !== 'darwin') return;
  const now = Date.now();

  if (over) {
    awaySince = null;
    lastOverCursor = cursor;
    if (overSince === null) overSince = now;
    const settled = now - overSince >= HOVER_ACTIVATE_MS;
    if (settled && !stealPending && !stolenFrom && !win.isFocused()) {
      stealPending = true;
      getFrontmostApp((front) => {
        stealPending = false;
        // The cursor may well have moved on during the lookup.
        if (overSince === null || !win || win.isDestroyed()) return;
        if (front && front.bundlePath !== OWN_BUNDLE) stolenFrom = front;
        app.focus({ steal: true });
      });
    }
    return;
  }

  overSince = null;
  if (!stolenFrom) return;

  // If the user has since clicked their way into some other app, the
  // activation we borrowed is long gone -- pulling their old app back to
  // the front now would yank them out of whatever they just switched to.
  if (!win.isFocused()) {
    stolenFrom = null;
    awaySince = null;
    return;
  }

  if (awaySince === null) awaySince = now;

  if (now - awaySince < LEAVE_RESTORE_MS) return;

  // Two very different ways the cursor can stop being over the dog. If
  // the user moved the pointer away, they are done petting and want
  // their app back straight away. If the pointer hasn't moved and the
  // dog simply walked out from under it, hold on: the walk ends with the
  // dog returning to exactly where it started, and handing focus back
  // now would flicker the menu bar twice per walk.
  const moved = !lastOverCursor
    || Math.hypot(cursor.x - lastOverCursor.x, cursor.y - lastOverCursor.y) > CURSOR_MOVED_PX;
  if (!moved && now - lastWindowMoveAt < MOVE_SETTLE_MS) return;

  const target = stolenFrom;
  stolenFrom = null;
  awaySince = null;
  // Only reactivate if that app is still running -- `open -a` on a quit
  // app would relaunch it.
  if (target.pid > 0) {
    try {
      process.kill(target.pid, 0);
    } catch (e) {
      return;
    }
  }
  execFile('/usr/bin/open', ['-a', target.bundlePath], () => {});
}

function buildTrayMenu() {
  const loginSettings = app.getLoginItemSettings();
  const openAtLogin = loginSettings.openAtLogin;

  return Menu.buildFromTemplate([
    {
      label: 'ビスケットを表示',
      click: () => {
        if (win) {
          win.show();
        } else {
          createWindow();
        }
      },
    },
    {
      label: 'ビスケットを隠す',
      click: () => {
        if (win) win.hide();
      },
    },
    {
      // 動きはふだんランダムなので、見たいものをすぐ見られるように
      label: '動きを見る',
      submenu: [
        ['wake', 'あくび・のび'], ['walk', 'おさんぽ（歩く）'], ['sniff', 'クンクン'],
        ['paw', 'お手（ぱふっ）'], ['spin', 'くるっと回る'], ['run', '走る（タタタッ）'],
        ['roll', '転がる（ゴロン）'], ['stand', 'まったり'], ['smile', 'にっこり'],
        ['lick', '手をなめる'], ['bow', 'はしゃいでお辞儀'],
        null,
        ['goronPose', 'ごろん'], ['kashige', '首かしげ'], ['ureshii', 'うれしい'],
        ['fuse', '伏せ'], ['dakko', '抱っこして'], ['furifuri', '尻尾ふりふり'], ['osumashi', 'おすまし'],
      ].map((item) => (item === null ? { type: 'separator' } : {
        label: item[1],
        click: () => {
          if (!win) createWindow();
          win.show();
          win.webContents.send('play-action', item[0]);
        },
      })),
    },
    { type: 'separator' },
    {
      label: 'エフェクト（ハート・吹き出し・季節）',
      type: 'checkbox',
      checked: settings.effects !== false,
      click: (menuItem) => {
        settings = { ...settings, effects: menuItem.checked };
        saveSettings(settings);
        if (win && !win.isDestroyed()) win.webContents.send('settings', settings);
      },
    },
    {
      label: 'ログイン時に自動起動',
      type: 'checkbox',
      checked: openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: 'separator' },
    {
      label: '終了',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray_icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon);
  tray.setToolTip('ビスケット');
  tray.setContextMenu(buildTrayMenu());
}

app.whenReady().then(() => {
  settings = loadSettings();
  // This is a menu-bar style utility app, so it doesn't need a Dock icon
  // taking up space (macOS only).
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Keep running in the tray even if the window is gone; only the
  // tray's "終了" (Quit) menu item should fully quit the app.
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
