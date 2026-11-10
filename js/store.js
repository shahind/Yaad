// Local persistence: favorites, custom lists, history and settings (all on-device).
const KEY = 'yaad.v1';
export const FAV = 'fav';

const defaults = () => ({
  lists: [{ id: FAV, name: 'برگزیده‌ها', items: [] }],
  history: [],
  settings: { theme: 'system', font: 1 },
});

let state = load();
const listeners = new Set();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.lists)) {
      const d = defaults();
      if (!s.lists.some((l) => l.id === FAV)) s.lists.unshift(d.lists[0]);
      return { ...d, ...s, settings: { ...d.settings, ...s.settings } };
    }
  } catch (e) {
    /* storage unavailable or corrupt: start fresh */
  }
  return defaults();
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    /* quota or private mode: keep in memory */
  }
  listeners.forEach((fn) => fn(state));
}

export const onChange = (fn) => listeners.add(fn);
export const getState = () => state;

const listById = (id) => state.lists.find((l) => l.id === id);
const itemOf = (entry) => ({ id: entry.id, w: entry.word, t: Date.now() });

export const lists = () => state.lists;
export const getList = listById;
export const inList = (listId, id) => !!listById(listId)?.items.some((i) => i.id === id);
export const isFav = (id) => inList(FAV, id);
export const listsWith = (id) => state.lists.filter((l) => l.items.some((i) => i.id === id)).map((l) => l.id);

export function toggleInList(listId, entry) {
  const l = listById(listId);
  if (!l) return false;
  const i = l.items.findIndex((x) => x.id === entry.id);
  if (i >= 0) l.items.splice(i, 1);
  else l.items.unshift(itemOf(entry));
  save();
  return i < 0;
}

export function removeFromList(listId, id) {
  const l = listById(listId);
  if (!l) return;
  l.items = l.items.filter((x) => x.id !== id);
  save();
}

export function createList(name) {
  const id = 'l' + Date.now().toString(36);
  state.lists.push({ id, name: name.trim() || 'فهرست تازه', items: [] });
  save();
  return id;
}

export function renameList(id, name) {
  const l = listById(id);
  if (l && name.trim()) {
    l.name = name.trim();
    save();
  }
}

export function deleteList(id) {
  if (id === FAV) return;
  state.lists = state.lists.filter((l) => l.id !== id);
  save();
}

export function addHistory(entry) {
  state.history = [itemOf(entry), ...state.history.filter((h) => h.id !== entry.id)].slice(0, 40);
  save();
}

export function clearHistory() {
  state.history = [];
  save();
}

export const settings = () => state.settings;
export function setSetting(k, v) {
  state.settings[k] = v;
  save();
}
