// Citation search filters for named works and notes. IDs are stored on disk; append sources.
import { normalizeSpaced } from './normalize.js';
import { splitSenses } from './search-subject-usage.js';

export const SOURCE_VERSION = 1;
export const SOURCE_TAGS = [
  { key: 'source-burhan', label: 'برهان قاطع', names: ['برهان قاطع', 'برهان'] },
  { key: 'source-anandraj', label: 'آنندراج', names: ['آنندراج'] },
  { key: 'source-nazem', label: 'ناظم الاطباء', names: ['ناظم الاطباء', 'ناظم الاطبا', 'فرهنگ ناظم الاطباء'] },
  { key: 'source-montaha', label: 'منتهی الارب', names: ['منتهی الارب'] },
  { key: 'source-aqrab', label: 'اقرب الموارد', names: ['اقرب الموارد'] },
  { key: 'source-ghiyas', label: 'غیاث اللغات', names: ['غیاث اللغات', 'غیاث اللغة', 'غیاث'] },
  { key: 'source-rashidi', label: 'فرهنگ رشیدی', names: ['فرهنگ رشیدی', 'رشیدی'] },
  { key: 'source-jahangiri', label: 'فرهنگ جهانگیری', names: ['فرهنگ جهانگیری', 'جهانگیری'] },
  { key: 'source-anjoman', label: 'انجمن آرا', names: ['انجمن آرا', 'انجمن آرای ناصری'] },
  { key: 'source-nezam', label: 'فرهنگ نظام', names: ['فرهنگ نظام'] },
  { key: 'source-moein', label: 'فرهنگ معین', names: ['فرهنگ فارسی معین', 'فرهنگ معین'] },
  { key: 'source-dehar', label: 'دهار', names: ['دهار'] },
  { key: 'source-qamus-alam', label: 'قاموس الاعلام', names: ['قاموس الاعلام', 'قاموس الاعلام ترکی'] },
  { key: 'source-qamus-bible', label: 'قاموس کتاب مقدس', names: ['قاموس کتاب مقدس'] },
  { key: 'source-shoori', label: 'فرهنگ شعوری', names: ['شعوری', 'فرهنگ شعوری', 'لسان العجم شعوری'] },
  { key: 'source-author-notes', label: 'یادداشت مؤلف', names: ['یادداشت مؤلف', 'یادداشتهای مؤلف', 'یادداشت به خط مؤلف', 'یادداشت بخط مؤلف', 'یادداشت مرحوم دهخدا', 'یادداشت به خط مرحوم دهخدا', 'یادداشت بخط مرحوم دهخدا', 'یادداشت به خط دهخدا', 'یادداشت بخط دهخدا', 'یادداشت دهخدا', 'یادداشت لغت نامه'] },
  { key: 'source-geography-iran', label: 'فرهنگ جغرافیایی ایران', names: ['فرهنگ جغرافیایی ایران', 'فرهنگ جغرافیائی ایران', 'فرهنگجغرافیایی ایران', 'فرهنگ جغرافیای ایران'] },
  { key: 'source-taj-masader', label: 'تاج المصادر بیهقی', names: ['تاج المصادر بیهقی', 'تاج المصادربیهقی', 'تاج المصادر'] },
  { key: 'source-mohazzab', label: 'مهذب الاسماء', names: ['مهذب الاسماء'] },
  { key: 'source-matn-lugha', label: 'متن اللغة', names: ['متن اللغة', 'متن اللغه', 'معجم متن اللغة'] },
  { key: 'source-taj-arus', label: 'تاج العروس', names: ['تاج العروس'] },
  { key: 'source-monjed', label: 'المنجد', names: ['المنجد'] },
  { key: 'source-qatr-mohit', label: 'قطر المحیط', names: ['قطر المحیط', 'قطرالمحیط'] },
  { key: 'source-sharafnameh', label: 'شرفنامهٔ منیری', names: ['شرفنامه منیری', 'شرفنامه'] },
  { key: 'source-lisan-arab', label: 'لسان العرب', names: ['لسان العرب'] },
  { key: 'source-kashshaf', label: 'کشاف اصطلاحات الفنون', names: ['کشاف اصطلاحات الفنون'] },
  { key: 'source-makhzan', label: 'مخزن الادویه', names: ['مخزن الادویه', 'فهرست مخزن الادویه'] },
  { key: 'source-tohfeh', label: 'تحفهٔ حکیم مؤمن', names: ['تحفه حکیم مؤمن'] },
  { key: 'source-asadi', label: 'لغت فرس اسدی', names: ['لغت فرس اسدی', 'لغت فرس', 'فرهنگ اسدی', 'فرهنگ اسدی نخجوانی', 'لغت نامه اسدی'] },
  { key: 'source-asadi-notes', label: 'حاشیهٔ فرهنگ اسدی', names: ['حاشیه فرهنگ اسدی', 'حاشیه فرهنگ اسدی نخجوانی', 'حاشیه لغت فرس اسدی', 'حاشیه لغت فرس اسدی نخجوانی', 'حاشیه لغت نامه اسدی نخجوانی'] },
  { key: 'source-mojmal-lugha', label: 'مجمل اللغة', names: ['مجمل اللغة'] },
  { key: 'source-sehah-fors', label: 'صحاح الفرس', names: ['صحاح الفرس'] },
  { key: 'source-montakhab', label: 'منتخب اللغات', names: ['منتخب اللغات'] },
  { key: 'source-bahar-ajam', label: 'بهار عجم', names: ['بهار عجم', 'بهارعجم'] },
  { key: 'source-moayyed', label: 'مؤید الفضلاء', names: ['مؤید الفضلاء'] },
  { key: 'source-johnson', label: 'فرهنگ جانسون', names: ['فرهنگ جانسون'] },
  { key: 'source-owbahi', label: 'فرهنگ اوبهی', names: ['فرهنگ اوبهی', 'اوبهی'] },
  { key: 'source-majma-fors', label: 'مجمع الفرس سروری', names: ['مجمع الفرس', 'مجمعالفرس', 'مجمع الفرس سروری', 'مجمعالفرس سروری', 'فرهنگ سروری', 'سروری'] },
  { key: 'source-haft-qolzom', label: 'هفت قلزم', names: ['هفت قلزم'] },
  { key: 'source-mohit', label: 'محیط المحیط', names: ['محیط المحیط', 'محیطالمحیط'] },
  { key: 'source-majma-amthal', label: 'مجمع الامثال میدانی', names: ['مجمع الامثال میدانی', 'مجمع الامثال', 'مجمعالامثال', 'مجمعالامثال میدانی'] },
  { key: 'source-shams-lughat', label: 'شمس اللغات', names: ['شمس اللغات'] },
  { key: 'source-sorah', label: 'صراح اللغة', names: ['صراح اللغة', 'صراح اللغه', 'صراح'] },
  { key: 'source-kanz', label: 'کنز اللغات', names: ['کنز اللغات', 'کنزاللغات'] },
  { key: 'source-molakhkhas', label: 'ملخص اللغات', names: ['ملخص اللغات', 'ملخص اللغات حسن خطیب', 'ملخص اللغات حسن خطیب کرمانی'] },
  { key: 'source-steingass', label: 'فرهنگ استینگاس', names: ['فرهنگ استینگاس', 'استینگاس', 'اشتینگاس'] },
  { key: 'source-dozy', label: 'فرهنگ دزی', names: ['فرهنگ دزی', 'دزی'] },
  { key: 'source-zia', label: 'فرهنگ ضیاء', names: ['فرهنگ ضیاء', 'فرهنگ ضیا'] },
  { key: 'source-dastur-lugha', label: 'دستور اللغة', names: ['دستور اللغة', 'دستوراللغة'] },
  { key: 'source-kashf-lughat', label: 'کشف اللغات', names: ['کشف اللغات'] },
  { key: 'source-majma-khavas', label: 'مجمع الخواص', names: ['مجمع الخواص', 'مجمعالخواص'] },
  { key: 'source-shahnameh-shafaq', label: 'فرهنگ شاهنامهٔ شفق', names: ['فرهنگ شاهنامه شفق', 'فرهنگ شاهنامه رضازاده شفق'] },
  { key: 'source-wolff', label: 'فرهنگ ولف', names: ['فرهنگ ولف', 'فرهنگ لغات ولف', 'فهرست ولف', 'ولف'] },
  { key: 'source-philosophy-terms', label: 'فرهنگ اصطلاحات فلسفی', names: ['فرهنگ اصطلاحات فلسفی', 'فرهنگ لغات و اصطلاحات فلسفی', 'فرهنگ لغات و اصطلاحات فلسفی سجادی'] },
  { key: 'source-rational-sciences', label: 'فرهنگ علوم عقلی', names: ['فرهنگ علوم عقلی', 'فرهنگ علوم عقلی سجادی', 'فرهنگ علوم عقلی جعفر سجادی', 'فرهنگ علوم عقلی سیدجعفر سجادی', 'فرهنگ علوم عقلی تألیف سجادی', 'فرهنگ علوم عقلی تألیف سیدجعفر سجادی'] },
  { key: 'source-transmitted-sciences', label: 'فرهنگ علوم نقلی', names: ['فرهنگ علوم نقلی', 'فرهنگ علوم نقلی تألیف سجادی', 'فرهنگ علوم نقلی جعفر سجادی', 'فرهنگ علوم نقلی دکتر سجادی'] },
  { key: 'source-legal-dictionary', label: 'فرهنگ حقوقی', names: ['فرهنگ حقوقی', 'فرهنگ حقوقی تألیف جعفری لنگرودی', 'فرهنگ حقوقی جعفری لنگرودی'] },
  { key: 'source-colloquial-dictionary', label: 'فرهنگ لغات عامیانه', names: ['فرهنگ لغات عامیانه', 'فرهنگ لغات عامیانه جمال زاده', 'فرهنگ لغات عامیانه جمالزاده', 'فرهنگ عامیانه جمال زاده', 'فرهنگ عامیانه جمالزاده'] },
  { key: 'source-burhan-notes', label: 'حاشیهٔ برهان قاطع', names: ['حاشیه برهان قاطع', 'حاشیه برهان', 'حواشی برهان', 'حواشی برهان قاطع', 'حاشیه معین بر برهان قاطع', 'حاشیه دکتر معین بر برهان قاطع', 'حاشیه برهان قاطع معین'] },
  { key: 'source-aqrab-supplement', label: 'ذیل اقرب الموارد', names: ['ذیل اقرب الموارد'] },
  { key: 'source-bayhaqi-history', label: 'تاریخ بیهقی', names: ['تاریخ بیهقی'] },
  { key: 'source-kalila', label: 'کلیله و دمنه', names: ['کلیله و دمنه'] },
  { key: 'source-golestan', label: 'گلستان سعدی', names: ['گلستان سعدی', 'گلستان'] },
  { key: 'source-bustan', label: 'بوستان سعدی', names: ['بوستان سعدی', 'بوستان'] },
  { key: 'source-yamini', label: 'ترجمهٔ تاریخ یمینی', names: ['ترجمه تاریخ یمینی'] },
  { key: 'source-sistan', label: 'تاریخ سیستان', names: ['تاریخ سیستان'] },
  { key: 'source-vis-ramin', label: 'ویس و رامین', names: ['ویس و رامین'] },
  { key: 'source-habib-siyar', label: 'حبیب السیر', names: ['حبیب السیر'] },
  { key: 'source-jahangosha', label: 'جهانگشای جوینی', names: ['جهانگشای جوینی', 'تاریخ جهانگشای جوینی'] },
  { key: 'source-hodud', label: 'حدود العالم', names: ['حدود العالم', 'حدودالعالم'] },
  { key: 'source-qom-history', label: 'تاریخ قم', names: ['تاریخ قم'] },
  { key: 'source-samani', label: 'انساب سمعانی', names: ['انساب سمعانی', 'الانساب سمعانی'] },
  { key: 'source-zerekli', label: 'الاعلام زرکلی', names: ['الاعلام زرکلی', 'اعلام زرکلی'] },
  { key: 'source-mojmal-history', label: 'مجمل التواریخ و القصص', names: ['مجمل التواریخ و القصص', 'مجمل التواریخ والقصص', 'مجمل التواریخ'] },
  { key: 'source-garshasp', label: 'گرشاسب‌نامه', names: ['گرشاسب نامه', 'گرشاسبنامه'] },
  { key: 'source-nowruznameh', label: 'نوروزنامه', names: ['نوروزنامه'] },
  { key: 'source-sendbad', label: 'سندبادنامه', names: ['سندبادنامه'] },
  { key: 'source-farsnameh', label: 'فارسنامهٔ ابن بلخی', names: ['فارسنامه ابن بلخی', 'فارسنامه ابن البلخی'] },
  { key: 'source-iran-bastan', label: 'ایران باستان', names: ['ایران باستان', 'تاریخ ایران باستان'] },
  { key: 'source-tarikh-gozideh', label: 'تاریخ گزیده', names: ['تاریخ گزیده'] },
  { key: 'source-nozhat', label: 'نزهة القلوب', names: ['نزهة القلوب', 'نزهةالقلوب'] },
  { key: 'source-marzban', label: 'مرزبان‌نامه', names: ['مرزبان نامه', 'مرزباننامه'] },
  { key: 'source-kashf-zonun', label: 'کشف الظنون', names: ['کشف الظنون'] },
  { key: 'source-shahnameh', label: 'شاهنامه', names: ['شاهنامه'] },
  { key: 'source-mojam-boldan', label: 'معجم البلدان', names: ['معجم البلدان'] },
  { key: 'source-mojam-matbuat', label: 'معجم المطبوعات', names: ['معجم المطبوعات'] },
  { key: 'source-merat', label: 'مرآت البلدان', names: ['مرآت البلدان'] },
  { key: 'source-reyhanat', label: 'ریحانة الادب', names: ['ریحانة الادب'] },
  { key: 'source-tarifat', label: 'تعریفات جرجانی', names: ['تعریفات جرجانی', 'التعریفات جرجانی'] },
  { key: 'source-ekhtiarat', label: 'اختیارات بدیعی', names: ['اختیارات بدیعی'] },
  { key: 'source-zakhireh', label: 'ذخیرهٔ خوارزمشاهی', names: ['ذخیره خوارزمشاهی'] },
  { key: 'source-antaki', label: 'تذکرهٔ ضریر انطاکی', names: ['تذکره ضریر انطاکی', 'تذکره داود ضریر انطاکی'] },
  { key: 'source-moarrab', label: 'المعرب جوالیقی', names: ['المعرب جوالیقی'] },
  { key: 'source-sami', label: 'السامی فی الاسامی', names: ['السامی فی الاسامی', 'السامی'] },
  { key: 'source-zozani', label: 'مصادر زوزنی', names: ['مصادر زوزنی', 'المصادر زوزنی', 'المصادرزوزنی', 'مصادر اللغة زوزنی', 'مصادراللغة زوزنی'] },
  { key: 'source-nafisi', label: 'فرهنگ نفیسی', names: ['فرهنگ نفیسی'] },
  { key: 'source-amid', label: 'فرهنگ عمید', names: ['فرهنگ عمید'] },
  { key: 'source-larousse', label: 'لاروس', names: ['لاروس'] },
  { key: 'source-keyhan', label: 'جغرافیای سیاسی کیهان', names: ['جغرافیای سیاسی کیهان'] },
  { key: 'source-encyclopedia-persian', label: 'دائرة المعارف فارسی', names: ['دائرة المعارف فارسی', 'دایرة المعارف فارسی', 'دائرةالمعارف فارسی', 'دایرةالمعارف فارسی'] },
  { key: 'source-purdavud', label: 'فرهنگ ایران باستان', names: ['فرهنگ ایران باستان', 'فرهنگ ایران باستان پورداود', 'فرهنگ ایران باستان تألیف پورداود'] },
  { key: 'source-farsnameh-naseri', label: 'فارسنامهٔ ناصری', names: ['فارسنامه ناصری'] },
  { key: 'source-qabusnameh', label: 'قابوسنامه', names: ['قابوسنامه'] },
  { key: 'source-kimiya', label: 'کیمیای سعادت', names: ['کیمیای سعادت'] },
  { key: 'source-mozher', label: 'المزهر', names: ['المزهر'] },
  { key: 'source-mojam-vasit', label: 'معجم الوسیط', names: ['معجم الوسیط'] },
  { key: 'source-majma-fosaha', label: 'مجمع الفصحاء', names: ['مجمع الفصحاء', 'مجمعالفصحاء', 'مجمع الفصحا', 'مجمعالفصحا'] },
  { key: 'source-farhang-naseri', label: 'فرهنگ ناصری', names: ['فرهنگ ناصری'] },
  { key: 'source-ebrahim', label: 'فرهنگ میرزا ابراهیم', names: ['فرهنگ میرزا ابراهیم'] },
  { key: 'source-tabari-translation', label: 'ترجمهٔ تاریخ طبری', names: ['ترجمه تاریخ طبری', 'ترجمه تاریخ طبری بلعمی', 'ترجمه طبری بلعمی', 'تاریخ طبری ترجمه بلعمی', 'ترجمه طبری'] },
  { key: 'source-abolfotuh', label: 'تفسیر ابوالفتوح رازی', names: ['تفسیر ابوالفتوح رازی', 'تفسیر ابوالفتوح'] },
  { key: 'source-mojam-authors', label: 'معجم المؤلفین', names: ['معجم المؤلفین'] },
  { key: 'source-mojam-odaba', label: 'معجم الادباء', names: ['معجم الادباء'] },
  { key: 'source-lisan-mizan', label: 'لسان المیزان', names: ['لسان المیزان'] },
  { key: 'source-oyun', label: 'عیون الانباء', names: ['عیون الانباء'] },
  { key: 'source-lobab-albab', label: 'لباب الالباب', names: ['لباب الالباب'] },
  { key: 'source-tarjoman-quran', label: 'ترجمان القرآن', names: ['ترجمان القرآن', 'ترجمان القرآن جرجانی', 'ترجمان علامه جرجانی', 'ترجمان جرجانی ترتیب عادل بن علی', 'ترجمان القرآن ترتیب عادل بن علی'] },
  { key: 'source-amthal-hekam', label: 'امثال و حکم', names: ['امثال و حکم', 'امثال و حکم دهخدا'] },
  { key: 'source-quran', label: 'قرآن', names: ['قرآن'] },
  { key: 'source-tafhim', label: 'التفهیم', names: ['التفهیم'] },
  { key: 'source-bukhara', label: 'تاریخ بخارا', names: ['تاریخ بخارا', 'تاریخ بخارای نرشخی'] },
  { key: 'source-tabarestan', label: 'تاریخ طبرستان', names: ['تاریخ طبرستان'] },
  { key: 'source-bayhaq', label: 'تاریخ بیهق', names: ['تاریخ بیهق'] },
  { key: 'source-gorgan', label: 'تاریخ جرجان', names: ['تاریخ جرجان', 'تاریخ جرجان ابوالقاسم سهمی', 'تاریخ جرجان تألیف ابوالقاسم سهمی'] },
  { key: 'source-ghazani', label: 'تاریخ غازانی', names: ['تاریخ غازانی'] },
  { key: 'source-chahar-maqaleh', label: 'چهارمقاله', names: ['چهارمقاله', 'چهار مقاله'] },
  { key: 'source-asrar', label: 'اسرار التوحید', names: ['اسرار التوحید', 'اسرارالتوحید'] },
  { key: 'source-rahat', label: 'راحة الصدور راوندی', names: ['راحة الصدور راوندی', 'راحةالصدور راوندی'] },
  { key: 'source-zaria', label: 'الذریعه', names: ['الذریعه', 'ذریعه'] },
  { key: 'source-esabah', label: 'الاصابة', names: ['الاصابة'] },
  { key: 'source-marased', label: 'مراصد الاطلاع', names: ['مراصد الاطلاع', 'مراصدالاطلاع', 'مراصد'] },
  { key: 'source-lobab-ansab', label: 'لباب الانساب', names: ['لباب الانساب'] },
  { key: 'source-lobab-tahzib', label: 'اللباب فی تهذیب الانساب', names: ['اللباب فی تهذیب الانساب'] },
  { key: 'source-kanz-lugha', label: 'کنز اللغة', names: ['کنز اللغة', 'کنزاللغة'] },
];
const sourceNames = new Map();
for (let id = 0; id < SOURCE_TAGS.length; id++) {
  const source = SOURCE_TAGS[id];
  source.id = id;
  source.group = 'source';
  source.names = [...new Set(source.names.map((name) => normalizeSpaced(name)))];
  for (const name of source.names) sourceNames.set(name, id);
}

export const hasSourceFilters = (filters = {}) => SOURCE_TAGS.some((tag) => filters[tag.key] === 1 || filters[tag.key] === -1);

// Accept explicit references and bibliography suffixes, not arbitrary mentions in
// prose. The unmodified citation stays in the entry; aliases affect metadata only.
function referenceSources(reference) {
  const label = normalizeSpaced(reference).replace(/^(?:به نقل از|نقل از|از روی|رجوع به|از) ?/, '');
  const exact = sourceNames.get(label);
  if (exact !== undefined) return [exact];
  // Longest known title first, so a title containing «و» is not split apart.
  // Lookup work depends on the reference length, not the size of the catalog.
  for (let at = label.lastIndexOf(' '); at > 0; at = label.lastIndexOf(' ', at - 1)) {
    const source = sourceNames.get(label.slice(0, at));
    if (source === undefined) continue;
    const tail = label.slice(at + 1);
    if (/^(?:\d|(?:ج|ص|چ|ورق)(?=\d| |$)|(?:جلد|صفحه|چاپ|ذیل|ماده|ایضا|همانجا|همان|خطی|نسخه|بخش)(?= |$))/.test(tail)) return [source];
    if (/^(?:و |از)/.test(tail)) {
      const rest = referenceSources(tail.replace(/^و /, ''));
      if (rest.length) return [source, ...rest];
    }
  }
  return [];
}

export function readSources(body) {
  const ids = new Set();
  for (const match of body.matchAll(/\(([^()\n]{1,300})\)|\x02([^\x03]{1,300})\x03/g)) {
    for (const field of (match[1] || match[2]).split(/[،,؛;]/)) {
      const found = referenceSources(field);
      for (const id of found.length ? found : field.split(' و ').flatMap(referenceSources)) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

// Owner 0 is the entry; positive owners are phrase ID + 1. Unindexed compounds
// retain owner -1 so their citations never become sources of the parent headword.
export function sourceOwners(body, senses = splitSenses(body)) {
  const owners = new Map();
  for (const sense of senses) {
    const ids = readSources(body.slice(sense.start, sense.end));
    if (!ids.length) continue;
    if (!owners.has(sense.phrase)) owners.set(sense.phrase, new Set());
    for (const id of ids) owners.get(sense.phrase).add(id);
  }
  return owners;
}

// One file per source: varint count followed by sorted, delta-varint owner IDs.
// Entry owners precede phrase owners (entry count + phrase ID).
export function decodeSourceOwners(bytes, ownerCount, expectedCount) {
  let at = 0;
  const read = () => {
    let value = 0;
    for (let shift = 0; shift <= 28 && at < bytes.length; shift += 7) {
      const byte = bytes[at++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    return NaN;
  };
  const count = read();
  if (!Number.isInteger(count) || count !== expectedCount || count > ownerCount) return null;
  const owners = new Uint32Array(count);
  let owner = 0;
  for (let i = 0; i < count; i++) {
    const delta = read();
    if (!Number.isInteger(delta) || i > 0 && delta === 0) return null;
    owner += delta;
    if (owner >= ownerCount) return null;
    owners[i] = owner;
  }
  return at === bytes.length ? owners : null;
}

export function planSourceFilters(postings, filters, ownerCount, mode = 'any') {
  const selected = SOURCE_TAGS.filter((tag) => filters[tag.key] === 1);
  const allowed = new Uint8Array(ownerCount).fill(selected.length ? 0 : 1);
  for (const tag of selected) {
    for (const owner of postings.get(tag.id)) {
      if (mode === 'all') allowed[owner]++;
      else allowed[owner] = 1;
    }
  }
  if (mode === 'all' && selected.length) {
    for (let owner = 0; owner < ownerCount; owner++) allowed[owner] = allowed[owner] === selected.length ? 1 : 0;
  }
  for (const tag of SOURCE_TAGS) {
    if (filters[tag.key] === -1) for (const owner of postings.get(tag.id)) allowed[owner] = 0;
  }
  return allowed;
}
