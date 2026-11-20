// Word-origin and grammar search filters, shared by dictionary builds and the UI.
// Bits are part of the on-disk format: keep existing assignments when adding tags.
import { normalizeSpaced } from './normalize.js';

export const TAG_VERSION = 5;
// These revisions share a layout; newly added tags need their own revision's data.
export function compatibleTagIndex(version, { include = 0n, exclude = 0n } = {}) {
  return [3, 4, TAG_VERSION].includes(version)
    && ENTRY_TAGS.every((tag) => !(tag.since > version) || !((include | exclude) & tag.bit));
}
export const ENTRY_TAGS = [
  { key: 'arabic', label: 'عربی', group: 'origin', bit: 0, pattern: /(?:^| )(?:ع|عربی|تازی)(?= |$)/ },
  { key: 'arabicized', label: 'معرّب', group: 'origin', bit: 1, pattern: /(?:^| )معرب(?= |$)/ },
  // Bit 2 is reserved for compatibility with previously generated indexes.
  { key: 'turkish', label: 'ترکی', group: 'origin', bit: 3, pattern: /(?:^| )ترکی(?= |$)/ },
  { key: 'french', label: 'فرانسوی', group: 'origin', bit: 4, pattern: /(?:^| )(?:فرانسوی|فرنسوی|فرانسه)(?= |$)/ },
  { key: 'english', label: 'انگلیسی', group: 'origin', bit: 5, pattern: /(?:^| )انگلیسی(?= |$)/ },
  { key: 'greek', label: 'یونانی', group: 'origin', bit: 6, pattern: /(?:^| )یونانی(?= |$)/ },
  { key: 'latin', label: 'لاتینی', group: 'origin', bit: 7, pattern: /(?:^| )(?:لاتینی|لاطینی)(?= |$)/ },
  { key: 'hindi', label: 'هندی', group: 'origin', bit: 8, pattern: /(?:^| )هندی(?= |$)/ },
  { key: 'russian', label: 'روسی', group: 'origin', bit: 9, pattern: /(?:^| )روسی(?= |$)/ },
  { key: 'noun', label: 'اسم', group: 'kind', bit: 10, pattern: /(?:^| )(?:ا(?! خ(?: |$))(?= |$|مرکب|مصغر|صوت)|اسم(?= |$))/ },
  { key: 'proper', label: 'اسم خاص', group: 'kind', bit: 11, pattern: /(?:^| )(?:اخ|ا خ)(?= |$)/ },
  { key: 'adjective', label: 'صفت', group: 'kind', bit: 12, pattern: /(?:^| )(?:ص(?= |$|مرکب)|صفت(?= |$)|نعت(?= |$))/ },
  { key: 'infinitive', label: 'مصدر', group: 'kind', bit: 13, pattern: /(?:^| )(?:مص(?= |$|مرکب)|مصدر(?= |$|منحوت))/ },
  { key: 'verbal-noun', label: 'اسم مصدر', group: 'kind', bit: 14, pattern: /(?:^| )امص(?= |$|مرکب)/ },
  { key: 'abstract', label: 'حاصل مصدر', group: 'kind', bit: 15, pattern: /(?:^| )حامص(?= |$|مرکب)/ },
  { key: 'active', label: 'صفت فاعلی', group: 'kind', bit: 16, pattern: /(?:^| )(?:نف(?= |$|مرکب)|نعت فاعلی(?= |$))/ },
  { key: 'passive', label: 'اسم مفعول', group: 'kind', bit: 17, pattern: /(?:^| )ن مف(?= |$)/ },
  { key: 'comparative', label: 'صفت تفضیلی', group: 'kind', bit: 18, pattern: /(?:^| )(?:ن تف|ص تفضیلی|صفت تفضیلی)(?= |$)/ },
  { key: 'verb', label: 'فعل', group: 'kind', bit: 19, pattern: /(?:^| )فعل(?= |$)/ },
  { key: 'adverb', label: 'قید', group: 'kind', bit: 20, pattern: /(?:^| )(?:ق(?= |$|مرکب)|قید(?= |$))/ },
  { key: 'pronoun', label: 'ضمیر', group: 'kind', bit: 21, pattern: /(?:^| )(?:ضمیر|موصول)(?= |$)/ },
  { key: 'particle', label: 'حرف', group: 'kind', bit: 22, pattern: /(?:^| )(?:حرف|ادات)(?= |$)/ },
  { key: 'prefix', label: 'پیشوند', group: 'kind', bit: 23, pattern: /(?:^| )(?:پیشوند(?= |$|فعلی)|مزید مقدم(?= |$))/ },
  { key: 'suffix', label: 'پسوند', group: 'kind', bit: 24, pattern: /(?:^| )(?:پسوند(?= |$)|مزید موخر(?= |$|امکنه))/ },
  { key: 'compound', label: 'مرکب', group: 'kind', bit: 25, pattern: /مرکب(?= |$)|(?:^| )ترکیب(?= |$)/ },
  { key: 'mongolian', label: 'مغولی', group: 'origin', bit: 26, pattern: /(?:^| )مغولی(?= |$)/ },
  { key: 'huzvarish', label: 'هزوارش', group: 'origin', bit: 27, pattern: /(?:^| )هزوارش(?= |$)/ },
  { key: 'syriac', label: 'سریانی', group: 'origin', bit: 28, pattern: /(?:^| )سریانی(?= |$)/ },
  { key: 'pahlavi', label: 'پهلوی', group: 'origin', bit: 29, pattern: /(?:^| )پهلوی(?= |$)/ },
  { key: 'avestan', label: 'اوستایی', group: 'origin', bit: 30, pattern: /(?:^| )اوستایی(?= |$)/ },
  { key: 'sanskrit', label: 'سانسکریت', group: 'origin', bit: 31, pattern: /(?:^| )(?:سانسکریت|سنسکریت)(?= |$)/ },
  { key: 'hebrew', label: 'عبری', group: 'origin', bit: 32, pattern: /(?:^| )(?:عبری|عبرانی)(?= |$)/ },
  { key: 'spanish', label: 'اسپانیایی', group: 'origin', bit: 33, pattern: /(?:^| )(?:اسپانیایی|اسپانیولی)(?= |$)/ },
  { key: 'german', label: 'آلمانی', group: 'origin', bit: 34, pattern: /(?:^| )المانی(?= |$)/ },
  { key: 'armenian', label: 'ارمنی', group: 'origin', bit: 35, pattern: /(?:^| )ارمنی(?= |$)/ },
  { key: 'chinese', label: 'چینی', group: 'origin', bit: 36, pattern: /(?:^| )چینی(?= |$)/ },
  { key: 'japanese', label: 'ژاپنی', group: 'origin', bit: 37, pattern: /(?:^| )ژاپنی(?= |$)/ },
  { key: 'georgian', label: 'گرجی', group: 'origin', bit: 38, pattern: /(?:^| )گرجی(?= |$)/ },
  { key: 'kurdish', label: 'کردی', group: 'origin', bit: 39, pattern: /(?:^| )کردی(?= |$)/ },
  { key: 'aramaic', label: 'آرامی', group: 'origin', bit: 40, pattern: /(?:^| )ارامی(?= |$)/ },
  { key: 'italian', label: 'ایتالیایی', group: 'origin', bit: 41, pattern: /(?:^| )ایتالیایی(?= |$)/ },
  { key: 'nabataean', label: 'نبطی', group: 'origin', bit: 42, pattern: /(?:^| )نبطی(?= |$)/ },
  { key: 'ossetian', label: 'آسی', group: 'origin', bit: 43, pattern: /(?:^| )اسی(?= |$)/ },
  { key: 'azeri', label: 'آذری', group: 'origin', bit: 44, pattern: /(?:^| )اذری(?= |$)/ },
  { key: 'tabari', label: 'طبری', group: 'origin', bit: 45, pattern: /(?:^| )طبری(?= |$)/ },
  { key: 'luri', label: 'لری', group: 'origin', bit: 46, pattern: /(?:^| )لری(?= |$)/ },
  { key: 'gilaki', label: 'گیلکی', group: 'origin', bit: 47, pattern: /(?:^| )گیلکی(?= |$)/ },
  { key: 'tatar', label: 'تاتاری', group: 'origin', bit: 48, pattern: /(?:^| )تاتاری(?= |$)/ },
  { key: 'desatiri', label: 'دساتیری', group: 'origin', bit: 49, pattern: /(?:^| )دساتیری(?= |$)/ },
  { key: 'roman', label: 'رومی', group: 'origin', bit: 50, pattern: /(?:^| )رومی(?= |$)/ },
  { key: 'phoenician', label: 'فینیقی', group: 'origin', bit: 51, pattern: /(?:^| )فینیقی(?= |$)/ },
  { key: 'interjection', label: 'صوت', group: 'kind', bit: 52, pattern: /(?:^| )(?:صوت|اصوت)(?= |$|مرکب)/ },
  { key: 'numeral', label: 'عدد', group: 'kind', bit: 53, pattern: /(?:^| )عدد(?= |$|مرکب|ترتیبی)/ },
  { key: 'sentence', label: 'جمله', group: 'kind', bit: 54, pattern: /(?:^| )جمله(?= |$)/ },
  { key: 'abbreviation', label: 'علامت اختصاری', group: 'kind', bit: 55, pattern: /(?:^| )علامت اختصاری(?= |$)/ },
  { key: 'negation', label: 'نفی', group: 'kind', bit: 56, pattern: /(?:^| )نفی(?= |$)/ },
  { key: 'vocative', label: 'منادا', group: 'kind', bit: 57, pattern: /(?:^| )منادا(?= |$)/ },
  { key: 'urdu', label: 'اردو', group: 'origin', bit: 58, pattern: /(?:^| )اردو(?= |$)/ },
  { key: 'azerbaijani', label: 'آذربایجانی', group: 'origin', bit: 59, pattern: /(?:^| )اذربایجانی(?= |$)/ },
  { key: 'relative-adjective', label: 'صفت نسبی', group: 'kind', bit: 60, pattern: /(?:^| )(?:ص|صفت) نسبی(?= |$|مرکب)/ },
  { key: 'diminutive', label: 'مصغر', group: 'kind', bit: 61, pattern: /(?:^| |ا)مصغر(?= |$)/ },
  { key: 'shortened', label: 'مرخم', group: 'kind', bit: 62, pattern: /(?:^| )مرخم(?= |$)/ },
  { key: 'echo', label: 'اتباع', group: 'kind', bit: 63, since: 5, pattern: /(?:^| )(?:از ?)?اتباعی?(?= |$|مرکب)/ },
];

const TAG_CODES = {
  arabic: 'ع', arabicized: 'معرب', turkish: 'ترکی', french: 'فرانسوی', english: 'انگلیسی',
  greek: 'یونانی', latin: 'لاتینی', hindi: 'هندی', russian: 'روسی', noun: 'اِ', proper: 'اِخ',
  adjective: 'ص', infinitive: 'مص', 'verbal-noun': 'اِمص', abstract: 'حامص', active: 'نف',
  passive: 'ن مف', comparative: 'ن تف', verb: 'فعل', adverb: 'ق', pronoun: 'ضمیر',
  particle: 'حرف', prefix: 'پیشوند', suffix: 'پسوند', compound: 'مرکب',
  mongolian: 'مغولی', huzvarish: 'هزوارش', syriac: 'سریانی', pahlavi: 'پهلوی', avestan: 'اوستایی',
  sanskrit: 'سانسکریت', hebrew: 'عبری', spanish: 'اسپانیایی', german: 'آلمانی', armenian: 'ارمنی',
  chinese: 'چینی', japanese: 'ژاپنی', georgian: 'گرجی', kurdish: 'کردی', aramaic: 'آرامی', italian: 'ایتالیایی',
  nabataean: 'نبطی', ossetian: 'آسی', azeri: 'آذری', tabari: 'طبری', luri: 'لری', gilaki: 'گیلکی',
  tatar: 'تاتاری', desatiri: 'دساتیری', roman: 'رومی', phoenician: 'فینیقی', urdu: 'اردو', azerbaijani: 'آذربایجانی',
  interjection: 'صوت', numeral: 'عدد', sentence: 'جمله', abbreviation: 'علامت اختصاری', negation: 'نفی', vocative: 'منادا',
  'relative-adjective': 'ص نسبی', diminutive: 'مصغر', shortened: 'مرخم', echo: 'اتباع',
};
for (const tag of ENTRY_TAGS) {
  tag.bit = 1n << BigInt(tag.bit);
  tag.code = TAG_CODES[tag.key];
}

// Tagged regexes run against "headword\n(tag) (tag)". Separate, canonical labels
// keep origin/grammar abbreviations unambiguous while exposing real regex syntax.
export function entryTagText(mask) {
  return ENTRY_TAGS.filter((tag) => mask & tag.bit).map((tag) => `(${tag.code})`).join(' ');
}

// Full grammatical names share the same categories as dictionary abbreviations.
const GRAMMAR_NAMES = new Map([
  ['اسم خاص', 'اخ'], ['اسم مصدر', 'امص'], ['اسم فاعل', 'نف'],
  ['اسم مفعول', 'ن مف'], ['حاصل مصدر', 'حامص'],
]);
const MODIFIER = /^(?:نسبی|لیاقت|مصغر|منفی|مرخم|جعلی|وصفی|اضافی|عطفی|از|ماخوذ|امر|نهی|فعلیه|دعایی|اسمیه|ترتیبی|ربط|اضافه|عالی|مبهم|جر|نفرینی|امری|استفهامی|کسری|ندا|استفهام|تشبیه|سوالی|سوءالی|متصل|منفصل|جمع|مفرد|امکنه|مکان|زمان|باستان|ملکی|شرطیه|شرطی|ماضی|مضارع|و|یا)(?= |$|مرکب)/;

// Explicit, unambiguous header typos from the content audit. Classification is
// tolerant; the original dictionary text remains available for editorial fixes.
const LABEL_ALIASES = [
  [/(^| )(?:فرانسسوی|فرنسه)(?= |$)/g, '$1فرانسوی'],
  [/(^| )(?:م رکب|مرک ب|مررکب)(?= |$)/g, '$1مرکب'],
  [/(^| )حا مص(?= |$)/g, '$1حامص'],
  [/(^| )(ص(?:فت)? )تفصیلی(?= |$)/g, '$1$2تفضیلی'],
  [/(^| )اصطلا ح(?= |$)/g, '$1اصطلاح'],
];

export function normalizeTagLabel(text, stripOriginPrefix = false) {
  let label = normalizeSpaced(text.replace(/[\x00-\x1f]/g, ''));
  if (stripOriginPrefix) label = label.replace(/^(?:ماخوذ ?)?از ?/, '');
  for (const [pattern, replacement] of LABEL_ALIASES) label = label.replace(pattern, replacement);
  return label;
}

export function readEntryTags(body) {
  let rest = body.replace(/^[\s.،؛:\x01]+/, '');
  // Compounds can have their own inline pronunciation before the labels.
  rest = rest.replace(/^(?:\[[^\]]{0,200}\]|\x0e[^\x0f]{0,200}\x0f)\s*/, '');
  let mask = 0n;
  for (let i = 0; i < 4; i++) {
    const match = rest.match(/^\(([^()\n]{1,100})\)\s*/);
    if (!match) break;
    let found = 0n;
    let accepted = false;
    for (const field of match[1].split(/[,،]/)) {
      let label = normalizeTagLabel(field, true);
      for (const [name, code] of GRAMMAR_NAMES) label = label.replace(new RegExp('(^| )' + name + '(?= |$)', 'g'), '$1' + code);
      if (label.startsWith('مرکب از ')) break;
      let fieldAccepted = false;
      while (label) {
        let length = 0;
        for (const tag of ENTRY_TAGS) {
          const match = tag.pattern.exec(label);
          if (match?.index !== 0) continue;
          found |= tag.bit;
          length = Math.max(length, match[0].length);
        }
        // Persian labels carry no origin bit. Stop at unfamiliar prose instead
        // of finding unrelated abbreviations later in an explanatory field.
        const neutral = label.match(/^(?:فارسی|پارسی)(?= |$)/);
        if (neutral) length = Math.max(length, neutral[0].length);
        if (length) accepted = true;
        else if (accepted) length = label.match(MODIFIER)?.[0].length || 0;
        if (!length) break;
        fieldAccepted = true;
        label = label.slice(length).trimStart();
      }
      if (!fieldAccepted) break;
    }
    if (!accepted) break;
    mask |= found;
    rest = rest.slice(match[0].length);
  }
  return mask;
}

// 0/absent = unrestricted; 1 = selected; -1 = exclude the label.
export function tagFilterMasks(filters = {}, modes) {
  let include = 0n;
  let exclude = 0n;
  const groups = new Map();
  for (const tag of ENTRY_TAGS) {
    if (filters[tag.key] === 1) {
      include |= tag.bit;
      groups.set(tag.group, (groups.get(tag.group) || 0n) | tag.bit);
    } else if (filters[tag.key] === -1) exclude |= tag.bit;
  }
  return { include, exclude, ...(modes ? { groups: [...groups].map(([group, bits]) => ({ bits, all: modes[group] === 'all' })) } : {}) };
}

export function matchesEntryTags(mask, { include, exclude, groups }) {
  if (mask & exclude) return false;
  return groups ? groups.every(({ bits, all }) => all ? (mask & bits) === bits : !!(mask & bits)) : (mask & include) === include;
}
