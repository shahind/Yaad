<div align="center">
  <img src="www/icons/icon-192.png" width="96" alt="Yaad logo" />
  <h1>یاد · Yaad</h1>
  <p><b>لغت‌نامهٔ دهخدا — سریع، سبک و کاملاً آفلاین</b><br/>
  A fast, lightweight, fully offline Dehkhoda dictionary for Web, Android, iOS, Windows and Linux.</p>
  <p><a href="https://shahind.github.io/Yaad/"><b>▶ Open the web version</b></a></p>
</div>

---

## Download

| Platform | Get it |
|---|---|
| 🌐 Web | **[shahind.github.io/Yaad](https://shahind.github.io/Yaad/)** — installable as an app (PWA); Settings → “بارگیری همهٔ داده‌ها” caches the whole dictionary for offline use |
| 🤖 Android | **[Yaad-1.0.0.apk](https://github.com/shahind/Yaad/releases/latest/download/Yaad-1.0.0.apk)** (signed release, ~61 MB, Android 7+) |
| 🍏 iOS | **[Yaad-1.0.0-ios-unsigned.ipa](https://github.com/shahind/Yaad/releases/latest/download/Yaad-1.0.0-ios-unsigned.ipa)** — unsigned; install by re-signing with AltStore, Sideloadly or your own developer certificate |
| 🪟 Windows / 🐧 Linux | build with `npm run dist:win` / `npm run dist:linux` (see below) |

All downloads are on the [Releases page](https://github.com/shahind/Yaad/releases).

## Features

- **Instant search** over all 312,507 Dehkhoda entries plus 54,008 sub-entry phrases
  (compounds such as «به یاد آوردن» that live inside other entries).
  Matches exact words, prefixes, word starts inside multi-word headwords and substrings,
  regardless of spaces / ZWNJ, Arabic letter variants (ي/ك/ة…), diacritics or hamza forms.
- **Search inside meanings**: «یاد» also finds «خاطره» (whose meaning lists «یادگار»),
  ranked by relevance (synonym-style definitions and early mentions first).
- **Favorites and custom lists** (create / rename / delete / share a list).
- **Copy** a meaning, **share** a word (native share sheet on Android/iOS).
- **Dark / light / automatic theme**, adjustable reading size, recent history, random word.
- Desktop two-pane layout, phone single-pane layout, keyboard navigation (`/`, arrows, Enter, Esc),
  double-click any word inside a meaning to look it up.
- **100% offline**: the dictionary ships inside the app; nothing is ever downloaded at runtime.
  The web version caches what you use (or everything, from Settings) with a service worker.

## Performance

| | |
|---|---|
| Source SQL dumps | 255 MB |
| Shipped data | **≈ 56 MB** (39 MB meanings, 16 MB full-text index, 1 MB headwords) |
| Startup (index load) | ≈ 250 ms |
| Headword search | 2 – 20 ms per keystroke |
| Meaning search | 10 – 25 ms |
| Memory | ≈ 30 MB of data structures; meanings are loaded in 64 KB blocks on demand (LRU cache) |

All searching runs in a Web Worker, so typing never blocks the UI.

## How it works

The SQL dumps in `DB/` (one per starting letter) are converted once by
[`tools/build-data.mjs`](tools/build-data.mjs) into a compact, purpose-built format in `www/data/`:

| File | Content |
|---|---|
| `words.bin` | every headword, one per line (gzip). Loaded at startup. |
| `phrases.bin`, `phrase-parents.bin` | sub-entry phrases (♦ …؛) and the entry each belongs to. |
| `m/<n>.bin` | meanings in ~64 KB blocks. HTML is reduced to a tiny control-character markup and text is transcoded to a **single-byte charset** (Persian letters are 2 bytes in UTF‑8) before gzip — 16 % smaller than gzip alone. |
| `t/<n>.bin` | full-text inverted index, **sharded by token prefix** (a size-bounded trie), so a query loads only the shards it needs and can expand prefixes («یاد» → «یادگار»…). Postings are delta + varint encoded with a 4-bit relevance score (BM25 × position × synonym boost). |
| `meta.json` | block table, shard table, charset, stop-words, build id. |

Why not one file per letter? A word can appear anywhere: «یاد» must match «به یاد آوردن»
(starts with «ب») and the meaning of «خاطره». So the app keeps *all* headwords in memory
as one normalized string (a few MB — searched with native `indexOf`, which is extremely fast)
and uses the inverted index for meanings. Only the large meaning texts are split and lazy-loaded.

Text normalization ([`www/js/normalize.js`](www/js/normalize.js)) is shared by the builder and the
app, so both sides always agree.

## Project layout

```
DB/                 Dehkhoda SQL dumps (source data)
tools/              data builder, SQL parser, dev server, search smoke test
www/                the app (vanilla JS, no framework, no bundler)
  js/app.js           UI
  js/search.worker.js search engine (Web Worker)
  data/               generated dictionary data (git-ignored; run npm run build:data)
electron/main.cjs   desktop shell (Windows / Linux / macOS)
android/, ios/      Capacitor native projects
resources/          icon & splash sources
```

## Build

Requires Node.js 20+.

```bash
npm install
npm run build:data      # DB/*.sql -> www/data (≈ 1 minute)
npm test                # search smoke tests
npm run serve           # http://localhost:5173
```

**Windows / Linux (Electron)**

```bash
npm run electron        # run
npm run dist:win        # installer + portable .exe in dist/
npm run dist:linux      # AppImage + .deb in dist/ (run on Linux)
```

**Android / iOS (Capacitor)**

```bash
npx cap sync            # copy www/ into the native projects
npm run android         # open in Android Studio (or: cd android && ./gradlew assembleDebug)
npm run ios             # open in Xcode (macOS)
```

Signed Android release: create a keystore, put `storeFile`, `storePassword`, `keyAlias` and
`keyPassword` in a properties file **outside the repo**, then

```bash
YAAD_KEYSTORE_PROPERTIES=/path/to/keystore.properties ./gradlew assembleRelease   # in android/
```

**iOS IPA (CI)** — publishing a GitHub release runs [`.github/workflows/ios.yml`](.github/workflows/ios.yml),
which builds an unsigned `.ipa` on macOS and attaches it to the release (it can also be started
manually from the Actions tab with a tag).

**Web (GitHub Pages)** — `npm run build:data && bash tools/deploy-pages.sh` publishes `www/`
(including `data/`) to the `gh-pages` branch.

## Credits & license

- Dictionary content: *Loghatnameh-ye Dehkhoda* (لغت‌نامهٔ دهخدا).
- Font: [Vazirmatn](https://github.com/rastikerdar/vazirmatn) by Saber Rastikerdar — SIL Open Font License (`www/fonts/OFL.txt`).
- Code: GNU GPL v3 — see [LICENSE](LICENSE).
