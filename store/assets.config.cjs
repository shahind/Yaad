// Scenes for the Google Play screenshots and feature graphic (run tools/store-assets.cjs).
const lists = {
  lists: [
    {
      id: 'fav',
      name: 'برگزیده‌ها',
      items: [
        { id: 104248, w: 'خاطره' },
        { id: 166949, w: 'شوق' },
        { id: 258217, w: 'نسیم' },
        { id: 157302, w: 'سپیده' },
        { id: 986, w: 'آرامش' },
        { id: 62016, w: 'بهار' },
      ],
    },
    { id: 'l1', name: 'واژه‌های زیبا', items: [{ id: 1423, w: 'آسمان' }, { id: 121978, w: 'دریا' }] },
  ],
  history: [
    { id: 309391, w: 'یاد' },
    { id: 104248, w: 'خاطره' },
    { id: 183617, w: 'عشق' },
    { id: 248176, w: 'مهر' },
    { id: 48915, w: 'باران' },
    { id: 166949, w: 'شوق' },
    { id: 1423, w: 'آسمان' },
    { id: 121978, w: 'دریا' },
    { id: 258217, w: 'نسیم' },
  ],
  settings: { theme: 'system', font: 1 },
};

module.exports = {
  out: 'store/play',
  brand: {
    font: 'Vazirmatn',
    fonts: [['Vazirmatn', 'Vazirmatn.woff2', '100 900']],
    background: 'linear-gradient(160deg, #00427f, #1d68b0)',
  },
  scenes: [
    { name: 'home', hash: '#/', storage: { 'yaad.v1': lists }, caption: 'لغت‌نامهٔ دهخدا، همیشه همراه', sub: 'سریع، سبک و کاملاً بی‌نیاز از اینترنت' },
    {
      name: 'search',
      hash: '#/',
      storage: { 'yaad.v1': lists },
      setup: "const q = document.querySelector('#q'); q.value = 'یاد'; q.dispatchEvent(new Event('input'));",
      caption: 'جستجوی آنی در ۳۱۲٬۰۰۰ مدخل',
      sub: 'واژه‌ها، ترکیب‌ها و حتی متن معنی‌ها',
    },
    { name: 'entry', hash: '#/e/183617', storage: { 'yaad.v1': lists }, wait: 3000, caption: 'معنی کامل، با شاهد از شاعران', sub: 'رونوشت و هم‌رسانی با یک لمس' },
    {
      name: 'meaning-search',
      hash: '#/e/104248?t=' + encodeURIComponent('یادگار'),
      storage: { 'yaad.v1': lists },
      theme: 'dark',
      wait: 3000,
      caption: 'جستجو در متن معنی‌ها',
      sub: '«یاد» را در معنی «خاطره» هم پیدا می‌کند · پوستهٔ تیره',
    },
    { name: 'lists', hash: '#/lists/fav', storage: { 'yaad.v1': lists }, caption: 'برگزیده‌ها و فهرست‌های شخصی', sub: 'واژه‌های دلخواهتان را نگه دارید' },
  ],
  feature: {
    css: `html,body{margin:0;width:1024px;height:500px;overflow:hidden}
      body{background:linear-gradient(135deg,#00427f,#1d68b0);font-family:'Vazirmatn';color:#fff;display:flex;align-items:center;gap:56px;padding:0 90px;box-sizing:border-box}
      .tile{width:250px;height:250px;border-radius:56px;background:#fff;display:grid;place-items:center;box-shadow:0 24px 60px rgba(0,0,0,.3);flex:none}
      .tile img{width:190px}
      h1{margin:0;font-size:120px;line-height:1.2;font-weight:800}
      p{margin:6px 0 0;font-size:34px;font-weight:500;opacity:.92}
      small{display:block;margin-top:18px;font-size:22px;opacity:.75}`,
    html: `<div class="tile"><img src="/icons/mark.png"></div><div><h1>یاد</h1><p>لغت‌نامهٔ دهخدا</p><small>سریع · سبک · کاملاً آفلاین</small></div>`,
  },
};
