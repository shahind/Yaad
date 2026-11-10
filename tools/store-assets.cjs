// Store graphics: phone screenshots (1080×1920) and the feature graphic (1024×500), captured from
// the real app with Electron (Chromium shapes Persian text correctly; image libraries don't).
//   npx electron tools/store-assets.cjs store/assets.config.cjs
// The config module exports { out, brand, scenes, feature } — see store/assets.config.cjs.
// Uses a throwaway browser profile, so the installed desktop app's data is never touched.
const { app, BrowserWindow, nativeTheme } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const config = require(path.resolve(process.argv[process.argv.length - 1]));
const OUT = path.join(ROOT, config.out);
const SCALE = 3; // pages lay out at 360×640 CSS px and are captured at 1080×1920

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'store-assets-')));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
// Compose pages and captures are written as temporary files under www/__store/ (removed at the end).
const STORE_TMP = path.join(WWW, '__store');
const extra = { set: (p, { body }) => (fs.mkdirSync(STORE_TMP, { recursive: true }), fs.writeFileSync(path.join(STORE_TMP, path.basename(p)), body)) };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(WWW, p.endsWith('/') ? p + 'index.html' : p);
      if (!file.startsWith(WWW)) return res.writeHead(403).end();
      fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Electron's loadURL() promise can reject for tiny pages even though they load fine:
// wait for the real did-finish-load event instead (with a timeout).
function load(win, url) {
  const done = new Promise((r) => {
    win.webContents.once('did-finish-load', r);
    setTimeout(r, 8000);
  });
  win.loadURL(url).catch(() => {});
  return done;
}

async function capture(url, { width, height, scale = SCALE, theme = 'light', storage = {}, setup = '', wait = 4000 }) {
  nativeTheme.themeSource = theme;
  // A hidden window stops producing frames after a reload, so the capture would hang: show it,
  // but far off-screen, without a taskbar entry and unable to take focus.
  const win = new BrowserWindow({ show: false, x: -4000, y: -4000, width: 400, height: 400, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  // Device emulation (DevTools protocol): the page lays out at width×height CSS px and is
  // rendered at `scale` device pixels per px — independent of the window and the screen.
  // (Attach only after a page has loaded: attaching to a fresh window crashes Electron.)
  // Load once to write the saved state for this origin, then reload so the app starts with it.
  await load(win, url);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: scale > 1 });
  await win.webContents.executeJavaScript(`localStorage.clear(); ${Object.entries(storage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))});`).join('')}`);
  const reloaded = new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.reload();
  await reloaded;
  // Screenshots show the finished state: no fade-ins or transitions caught half-way.
  await win.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
  await sleep(wait);
  if (setup) {
    await win.webContents.executeJavaScript(`(async () => { ${setup} })()`);
    await sleep(1800);
  }
  const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
  dbg.detach();
  win.destroy();
  return Buffer.from(data, 'base64');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

app.on('window-all-closed', () => {}); // capture windows come and go: don't quit in between
app.whenReady().then(async () => {
  const base = await serve();

  fs.mkdirSync(OUT, { recursive: true });
  const { brand } = config;
  const fontFace = brand.fonts.map(([fam, file, w]) => `@font-face{font-family:'${fam}';src:url('/fonts/${file}') format('woff2');font-weight:${w}}`).join('');

  for (const [i, s] of config.scenes.entries()) {
    const raw = await capture(`${base}/${s.hash}`, { width: 360, height: 640, ...s });
    extra.set('/__store/shot.png', { type: 'image/png', body: raw });
    // Framed: brand background, caption on top, the screen as a rounded phone display.
    extra.set('/__store/frame.html', {
      type: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fontFace}
        html,body{margin:0;width:360px;height:640px;overflow:hidden}
        body{background:${brand.background};font-family:'${brand.font}';color:#fff;display:flex;flex-direction:column;align-items:center}
        h1{margin:34px 26px 0;font-size:24px;line-height:1.7;text-align:center;font-weight:700}
        p{margin:4px 30px 0;font-size:13.5px;opacity:.85;text-align:center;line-height:1.8}
        .phone{margin-top:22px;width:264px;height:470px;border-radius:30px;padding:7px;background:#0b0f14;box-shadow:0 18px 40px rgba(0,0,0,.35)}
        .phone img{width:100%;height:100%;border-radius:24px;display:block;object-fit:cover;object-position:top}
      </style><h1>${esc(s.caption)}</h1>${s.sub ? `<p>${esc(s.sub)}</p>` : ''}<div class="phone"><img src="/__store/shot.png?${i}"></div></html>`,
    });
    const framed = await capture(`${base}/__store/frame.html`, { width: 360, height: 640, wait: 900 });
    const name = `${String(i + 1).padStart(2, '0')}-${s.name}.png`;
    fs.writeFileSync(path.join(OUT, name), framed);
    fs.writeFileSync(path.join(OUT, 'raw-' + name), raw);
    console.log('screenshot', name);
  }

  // Feature graphic: 1024×500 (captured at 3× and downscaled afterwards).
  extra.set('/__store/feature.html', { type: 'text/html; charset=utf-8', body: `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fontFace}${config.feature.css}</style>${config.feature.html}</html>` });
  const feature = await capture(`${base}/__store/feature.html`, { width: 1024, height: 500, scale: 1, wait: 900 });
  fs.writeFileSync(path.join(OUT, 'feature-graphic.png'), feature);
  console.log('feature graphic');
  fs.rmSync(STORE_TMP, { recursive: true, force: true });
  app.quit();
});
