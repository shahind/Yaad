// Platform helpers: clipboard and share across web, Capacitor (Android/iOS) and Electron.
const cap = typeof window !== 'undefined' ? window.Capacitor : undefined;
export const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
export const isElectron = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);

// Native plugin proxy (requires js/vendor/capacitor.js, the @capacitor/core runtime).
const plugins = {};
export function plugin(name) {
  if (!isNative) return null;
  if (!(name in plugins)) {
    plugins[name] = (cap.Plugins && cap.Plugins[name]) || (cap.registerPlugin ? cap.registerPlugin(name) : null);
  }
  return plugins[name];
}

export async function copyText(text) {
  const clip = plugin('Clipboard');
  if (clip) {
    await clip.write({ string: text });
    return true;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Returns 'shared', 'copied' or 'cancelled'. */
export async function shareText(title, text) {
  const share = plugin('Share');
  try {
    if (share) {
      await share.share({ title, text, dialogTitle: title });
      return 'shared';
    }
    if (navigator.share) {
      await navigator.share({ title, text });
      return 'shared';
    }
  } catch (e) {
    if (e && (e.name === 'AbortError' || /cancel/i.test(e.message || ''))) return 'cancelled';
  }
  await copyText(text);
  return 'copied';
}
