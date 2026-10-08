// Electron shell for Windows / Linux (and macOS). Serves www/ through a privileged custom
// protocol so module workers, fetch() and the clipboard work exactly like on the web.
const { app, BrowserWindow, protocol, net, shell, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'www');
const CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'";

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    title: 'یاد',
    icon: path.join(ROOT, 'icons', 'icon-512.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1420' : '#f4f6fa',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.loadURL('app://yaad/index.html');
  // External links open in the system browser; the app itself never goes online.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  if (process.env.YAAD_SMOKE) {
    win.webContents.on('console-message', (_e, _level, message) => console.log('[renderer]', message));
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const r = await win.webContents.executeJavaScript(
          `document.querySelector('#splash') ? 'loading' : 'ready:' + document.querySelector('#stats')?.textContent`,
        );
        console.log('smoke:', r);
        app.quit();
      }, 4000),
    );
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    });
  });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
