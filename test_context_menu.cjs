const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  try {
    await page.goto(process.env.ULPIN_URL || 'http://127.0.0.1:8011/login', { waitUntil: 'networkidle' });
    await page.locator('#loginUsername').fill(process.env.ULPIN_TEST_USERNAME);
    await page.locator('#loginPassword').fill(process.env.ULPIN_TEST_PASSWORD);
    await page.locator('#loginForm [type="submit"]').click();
    await page.waitForURL('**/user');
    await page.waitForFunction(() => state.sceneReady && land.summary);
    await page.locator('[data-inspect-land="P-TS-002"]').click();
    await page.waitForFunction(() => state.selectedParcel?.id === 'P-TS-002' && state.selectedFloor);

    const verifyAnchors = async label => {
      const results = await page.evaluate(() => {
        const viewport = document.querySelector('#viewport');
        const canvas = viewport.querySelector('canvas');
        const bounds = viewport.getBoundingClientRect();
        const inset = 12;
        const anchors = {
          center: [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2],
          left: [bounds.left + inset, bounds.top + bounds.height / 2],
          right: [bounds.right - inset, bounds.top + bounds.height / 2],
          top: [bounds.left + bounds.width / 2, bounds.top + inset],
          bottom: [bounds.left + bounds.width / 2, bounds.bottom - inset],
          topLeft: [bounds.left + inset, bounds.top + inset],
          topRight: [bounds.right - inset, bounds.top + inset],
          bottomLeft: [bounds.left + inset, bounds.bottom - inset],
          bottomRight: [bounds.right - inset, bounds.bottom - inset],
        };
        return Object.entries(anchors).map(([name, [clientX, clientY]]) => {
          canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
          const menu = document.querySelector('#floorContextMenu').getBoundingClientRect();
          return { name, bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }, menu: { left: menu.left, top: menu.top, right: menu.right, bottom: menu.bottom } };
        });
      });
      for (const result of results) {
        assert(result.menu.left >= result.bounds.left, `${label}/${result.name}: menu crossed left viewport edge`);
        assert(result.menu.right <= result.bounds.right, `${label}/${result.name}: menu crossed right viewport edge`);
        assert(result.menu.top >= result.bounds.top, `${label}/${result.name}: menu crossed top viewport edge`);
        assert(result.menu.bottom <= result.bounds.bottom, `${label}/${result.name}: menu crossed bottom viewport edge`);
      }
      return results.length;
    };

    const desktopCases = await verifyAnchors('desktop');
    await page.setViewportSize({ width: 960, height: 720 });
    await page.waitForFunction(() => document.querySelector('#viewport').getBoundingClientRect().width > 0);
    const resizedCases = await verifyAnchors('resized');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', desktopCases, resizedCases }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
