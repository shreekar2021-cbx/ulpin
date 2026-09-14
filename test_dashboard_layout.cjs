const { chromium } = require("playwright");
const assert = require("node:assert/strict");

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  try {
    await page.goto(process.env.ULPIN_URL || "http://127.0.0.1:8012/login", { waitUntil: "networkidle" });
    await page.locator("#loginUsername").fill(process.env.ULPIN_TEST_USERNAME || "dashboard_ui");
    await page.locator("#loginPassword").fill(process.env.ULPIN_TEST_PASSWORD || "dashboard_ui_password");
    await page.locator("#loginForm [type=submit]").click();
    await page.waitForURL("**/user");
    await page.waitForFunction(() => state.sceneReady && land.summary);

    const initial = await page.evaluate(() => {
      const left = document.querySelector(".left-panel").getBoundingClientRect();
      const viewport = document.querySelector("#viewport").getBoundingClientRect();
      const splitter = document.querySelector("#panelSplitter").getBoundingClientRect();
      return { left: left.width, viewport: viewport.width, splitter: splitter.width };
    });
    assert(initial.splitter >= 12, "divider should remain discoverable");

    await page.locator("#splitToggle").click();
    await page.waitForTimeout(450);
    const collapsed = await page.evaluate(() => {
      const left = document.querySelector(".left-panel").getBoundingClientRect();
      const viewport = document.querySelector("#viewport").getBoundingClientRect();
      const canvas = document.querySelector("#viewport canvas").getBoundingClientRect();
      return { rail: left.width, viewport: viewport.width, canvas: canvas.width, active: document.querySelector(".workspace").classList.contains("list-collapsed") };
    });
    assert(collapsed.active && collapsed.rail <= 50, "list should become a compact rail");
    assert(collapsed.viewport > initial.viewport, "3D viewport should expand after collapse");
    assert(Math.abs(collapsed.canvas - collapsed.viewport) < 2, "renderer should track collapsed viewport width");

    await page.locator("#splitToggle").click();
    await page.waitForTimeout(450);
    const splitter = await page.locator("#panelSplitter").boundingBox();
    await page.mouse.move(splitter.x + 7, splitter.y + 180);
    await page.mouse.down();
    await page.mouse.move(splitter.x + 160, splitter.y + 180, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const dragged = await page.evaluate(() => {
      const left = document.querySelector(".left-panel").getBoundingClientRect();
      const viewport = document.querySelector("#viewport").getBoundingClientRect();
      const canvas = document.querySelector("#viewport canvas").getBoundingClientRect();
      return { left: left.width, viewport: viewport.width, canvas: canvas.width };
    });
    assert(dragged.left > initial.left, "dragging should change the list width");
    assert(Math.abs(dragged.canvas - dragged.viewport) < 2, "renderer should track dragged viewport width");

    await page.locator("[data-inspect-land='P-TS-002']").click();
    await page.waitForFunction(() => state.selectedParcel?.id === "P-TS-002" && state.selectedFloor);
    const context = await page.evaluate(() => {
      const canvas = document.querySelector("#viewport canvas");
      const bounds = document.querySelector("#viewport").getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: bounds.right - 4, clientY: bounds.bottom - 4
      }));
      const menu = document.querySelector("#floorContextMenu").getBoundingClientRect();
      return menu.left >= bounds.left && menu.right <= bounds.right && menu.top >= bounds.top && menu.bottom <= bounds.bottom;
    });
    assert(context, "context action must stay inside the resized 3D viewport");

    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(120);
    const responsive = await page.evaluate(() => ({
      contained: document.documentElement.scrollWidth <= innerWidth,
      viewport: document.querySelector("#viewport").getBoundingClientRect().width
    }));
    assert(responsive.contained && responsive.viewport > 0, "narrow layout should stack without horizontal overflow");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: "passed", initial, collapsed, dragged, responsive }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
