// README screenshots: npx electron tools/store-assets.cjs docs/screenshots.config.cjs
const { scenes } = require('../store/assets.config.cjs');
const scene = (name) => scenes.find((s) => s.name === name);
const desktop = { width: 1280, height: 800, scale: 1, mobile: false };
const phone = { width: 360, height: 740, scale: 2 };

module.exports = {
  out: 'docs/screenshots',
  shots: [
    { ...scene('entry'), ...desktop, name: 'desktop' },
    { ...scene('search'), ...phone, name: 'mobile-search' },
    { ...scene('entry'), ...phone, name: 'mobile-entry' },
    { ...scene('meaning-search'), ...phone, name: 'mobile-dark' },
  ],
};
