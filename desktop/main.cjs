const {app, BrowserWindow, dialog, ipcMain, Menu, shell} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {startBackend} = require('./backend.cjs');

app.setName('MatchER');
let win, backend, origin, quitting = false, mayExit = false, dialogOpen = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(start).catch(e => { dialog.showErrorBox('MatchER could not start', e.message); app.quit(); });
}

function trustedFrame(event) {
  return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame &&
    origin && new URL(event.senderFrame.url).origin === origin;
}

async function start() {
  const root = path.resolve(__dirname, '..');
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  const data = process.env.MATCHER_DATA || (process.platform === 'win32' ? path.join(local, 'MatchER', 'data') :
    path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share'), 'matcher'));
  const models = process.env.MATCHER_MODELS || (process.platform === 'win32' ? path.join(local, 'MatchER', 'models') :
    path.join(process.env.XDG_CACHE_HOME || path.join(app.getPath('home'), '.cache'), 'matcher', 'models'));
  fs.mkdirSync(app.getPath('logs'), {recursive: true});
  const logfile = path.join(app.getPath('logs'), 'startup.log');
  if (fs.existsSync(logfile) && fs.statSync(logfile).size > 1024 * 1024) fs.renameSync(logfile, logfile + '.previous');
  const log = line => fs.appendFileSync(logfile, line.replace(/([?&]k=)[A-Za-z0-9_-]+/g, '$1[private]'));
  win = new BrowserWindow({width: 1440, height: 960, minWidth: 700, minHeight: 520, backgroundColor: '#18142a',
    title: 'MatchER', icon: path.join(__dirname, 'assets', 'icon.png'), show: false,
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true}});
  win.on('closed', () => { win = null; });
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', (event, url) => {
    if (!origin || new URL(url).origin !== origin) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!origin || new URL(url).origin !== origin) event.preventDefault();
  });
  await win.loadFile(path.join(__dirname, 'loading.html'));
  if (!win || quitting) return;
  win.show();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label: 'MatchER', submenu: [
      {label: 'Your saves folder', click: () => { fs.mkdirSync(data, {recursive: true}); shell.openPath(data); }},
      {type: 'separator'}, {role: 'quit'},
    ]},
    {label: 'Edit', submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}]},
    {label: 'View', submenu: [{role: 'togglefullscreen'}, {type: 'separator'}, {role: 'zoomIn'}, {role: 'zoomOut'}, {role: 'resetZoom'}]},
    {label: 'Help', submenu: [
      {label: 'Getting started', click: () => shell.openExternal('https://github.com/nikhilavibeauterai/MatchER/blob/main/docs/install.md')},
      {label: 'Report a problem', click: () => shell.openExternal('https://github.com/nikhilavibeauterai/MatchER/issues')},
      {label: 'Source code and license', click: () => shell.openExternal('https://github.com/nikhilavibeauterai/MatchER')},
      {label: 'Open startup log', click: () => shell.openPath(logfile)},
      {label: `About MatchER ${app.getVersion()}`, click: () => dialog.showMessageBox(win, {type: 'info', title: 'MatchER',
        message: `MatchER ${app.getVersion()}`, detail: 'Turn a folder of photos into a game. Find the keepers.\n\nYour photos and choices stay on this computer.'})},
    ]},
  ]));
  ipcMain.handle('matcher:choose-folder', async event => {
    if (!trustedFrame(event)) throw new Error('Folder selection is only available inside MatchER.');
    if (dialogOpen) return {available: true, path: null};
    dialogOpen = true;
    try {
      const result = await dialog.showOpenDialog(win, {title: 'Pick your photo folder', properties: ['openDirectory']});
      return {available: true, path: result.canceled ? null : result.filePaths[0]};
    } finally { dialogOpen = false; }
  });
  backend = startBackend({packaged: app.isPackaged, resources: process.resourcesPath, root, data, models, log});
  try {
    const url = await backend.ready;
    if (quitting) return;
    origin = url.origin;
    await win.loadURL(url.href);
    backend.exited.then(({code}) => { if (!quitting) { dialog.showErrorBox('MatchER stopped', `The photo engine exited (${code}). Your saved choices are safe. Reopen MatchER to resume.\n\nStartup log: ${logfile}`); app.quit(); } });
  } catch (e) {
    if (!quitting) { dialog.showErrorBox('MatchER could not start', `${e.message}\n\nStartup log: ${logfile}`); app.quit(); }
  }
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (mayExit || !backend) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  if (win && !win.isDestroyed()) win.hide();
  backend.stop().finally(() => { mayExit = true; app.quit(); });
});
