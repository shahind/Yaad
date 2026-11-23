<div align="center">
  <img src="www/icons/icon-192.png" width="96" alt="Yaad logo" />
  <h1>یاد · Yaad</h1>
  <p><b>لغت‌نامهٔ دهخدا، سریع، سبک و کاملاً آفلاین</b><br/>
  The Dehkhoda Persian dictionary: fast, lightweight and fully offline.</p>

  <p>
  <a href="https://shahind.github.io/Yaad/"><img alt="Web" src="https://custom-icon-badges.demolab.com/badge/Web-1D68B0?logo=globe&logoColor=white&style=for-the-badge" width="104"></a>
  <a href="https://github.com/shahind/Yaad/releases/latest"><img alt="Windows" src="https://custom-icon-badges.demolab.com/badge/Windows-0078D6?logo=windows11&logoColor=white&style=for-the-badge" width="161"></a>
  <a href="https://github.com/shahind/Yaad/releases/latest"><img alt="Linux" src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black&style=for-the-badge" width="123"></a>
  <a href="https://github.com/shahind/Yaad/releases/latest"><img alt="iOS" src="https://img.shields.io/badge/iOS-000000?logo=apple&logoColor=white&style=for-the-badge" width="99"></a>
  <a href="https://github.com/shahind/Yaad/releases/latest"><img alt="Google Play" src="https://img.shields.io/badge/Google_Play-414141?logo=googleplay&logoColor=white&style=for-the-badge" width="194"></a>
  <a href="https://cafebazaar.ir/app/com.shahinsoft.yaad"><img alt="Bazaar" src="https://img.shields.io/badge/Bazaar-2BAE66?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAyNCAyNCc+PHBhdGggZD0nTTQuNSA4aDE1bC0xLjIgMTIuNUg1Ljd6JyBmaWxsPSd3aGl0ZScvPjxwYXRoIGQ9J004LjUgOFY2LjhhMy41IDMuNSAwIDAgMSA3IDBWOCcgZmlsbD0nbm9uZScgc3Ryb2tlPSd3aGl0ZScgc3Ryb2tlLXdpZHRoPScyJy8+PC9zdmc+&logoColor=white&style=for-the-badge" width="139"></a>
  </p>

  <img src="docs/screenshots/desktop.png" alt="Yaad on desktop" width="820" />
  <br/><br/>
  <img src="docs/screenshots/mobile-search.png" alt="Search" width="200" />&nbsp;
  <img src="docs/screenshots/mobile-entry.png" alt="A meaning" width="200" />&nbsp;
  <img src="docs/screenshots/mobile-dark.png" alt="Dark theme" width="200" />
</div>

## Download

| Platform | |
|---|---|
| Web | [shahind.github.io/Yaad](https://shahind.github.io/Yaad/), installable, works offline |
| Android | [Cafe Bazaar](https://cafebazaar.ir/app/com.shahinsoft.yaad) or the `.apk` from [Releases](https://github.com/shahind/Yaad/releases/latest) |
| iOS | unsigned `.ipa` from [Releases](https://github.com/shahind/Yaad/releases/latest) (install with AltStore or Sideloadly) |
| Windows | installer or portable `.exe` from [Releases](https://github.com/shahind/Yaad/releases/latest) |
| Linux | `.AppImage` or `.deb` from [Releases](https://github.com/shahind/Yaad/releases/latest) |

## Features

- All **312,507 entries** of Dehkhoda, plus 54,008 phrases found inside other entries.
- **Instant search** as you type. Spaces, half-spaces, diacritics and Arabic letter forms don't matter.
- **Search inside meanings**: «یاد» also finds «خاطره».
- **Favorites and your own lists**, recent words, a random word.
- **Copy and share** meanings.
- Light and dark themes, adjustable text size.
- **No internet needed**, no ads, no data collected.

---

## For developers

### Why it is fast and light

`tools/build-data.mjs` turns the 255 MB of source SQL into **56 MB** of app data, once, at build time. Persian letters take 2 bytes each in UTF-8, so the builder gives the 255 most frequent characters a 1-byte code each (rarer ones are escaped), and replaces the HTML markup with a few control characters. That cuts the text from 186 MB to 108 MB before compression and saves 16% after gzip. The meanings are then cut into ~64 KB gzip blocks, so the app downloads and unpacks only the block holding the entry you open. For searching inside meanings, the builder makes an **inverted index**, a list of entries for every word. Entry numbers are stored as delta-encoded varints, each with a 4-bit relevance score (BM25), and the index is split by word prefix into small files, so a query reads only the few files it needs and «یاد» can also match «یادگار».

At run time all 312,000 headwords stay in memory as one normalized string (about 1 MB to download), so a word search is a native `indexOf` that takes **2–20 ms**. Normalization, shared by the builder and the app, ignores diacritics, half-spaces and Arabic letter forms. All searching runs in a **Web Worker**, so typing never blocks the screen, and the app starts in about 250 ms.

### Technology

Plain **JavaScript, HTML and CSS**, with no framework and no bundler. **Capacitor** wraps it for Android and iOS, and **Electron** for Windows and Linux. The data is built with **Node.js** scripts in `tools/`.

### Run, test, build

Needs Node.js 20+.

```bash
npm install
npm run build:data   # build the dictionary data into www/data
npm test             # search tests
npm run serve        # open http://localhost:5173
```

| Target | Command |
|---|---|
| Desktop app | `npm run electron` |
| Windows build | `npm run dist:win` |
| Linux build | `npm run dist:linux` |
| Android | `npm run android` (opens Android Studio) |
| iOS | `npm run ios` (opens Xcode, macOS only) |

### Open a word in Yaad from your app

Any app can show Yaad's meaning for a word, as [Doost](https://github.com/shahind/Doost) does. Open the Yaad app if it is installed, otherwise the web version:

| | Link |
|---|---|
| Yaad app (Android, iOS) | `yaad://search?q=<word>` |
| Web version (any platform) | `https://shahind.github.io/Yaad/#/?q=<word>` |

Encode the word with `encodeURIComponent` (or your platform's equivalent). Both links show the search results for the word. On the web, adding `&go=1` opens the exact entry instead.

**Android**: declare Yaad's package so your app can check for it (Android 11+), then open the link:

```xml
<!-- AndroidManifest.xml -->
<queries><package android:name="com.shahinsoft.yaad" /></queries>
```

```kotlin
val word = Uri.encode("یاد")
val installed = runCatching { packageManager.getPackageInfo("com.shahinsoft.yaad", 0) }.isSuccess
val link = if (installed) "yaad://search?q=$word" else "https://shahind.github.io/Yaad/#/?q=$word"
startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
```

**iOS**: add `yaad` to `LSApplicationQueriesSchemes` in `Info.plist`, then:

```swift
let word = "یاد".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!
let app = URL(string: "yaad://search?q=\(word)")!
UIApplication.shared.open(UIApplication.shared.canOpenURL(app) ? app : URL(string: "https://shahind.github.io/Yaad/#/?q=\(word)")!)
```

**Web and desktop**: open the web link, for example `window.open('https://shahind.github.io/Yaad/#/?q=' + encodeURIComponent(word))`.

## Credits

- Content: *Loghatnameh-ye Dehkhoda* (لغت‌نامهٔ دهخدا), SQL format by [Nimah79](https://github.com/nimah79/Dehkhoda-SQL).
- Font: [Vazirmatn](https://github.com/rastikerdar/vazirmatn) (SIL Open Font License).
- Code: [GNU GPL v3](LICENSE).
