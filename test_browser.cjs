const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, acceptDownloads: true});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  fs.mkdirSync('artifacts', {recursive: true});
  try {
    await page.goto(process.env.ULPIN_URL || 'http://127.0.0.1:8001', {waitUntil: 'networkidle'});
    await page.waitForFunction(() => state.sceneReady && land.summary);
    assert.equal(await page.locator('.land-row').count(), 84);
    assert.equal(await page.evaluate(() => floorMeshes.length), 74);
    const pixels = await page.evaluate(() => {
      renderer.render(scene, activeCamera);
      const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const data = new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,data);
      const colors = new Set();
      for (let i=0;i<data.length;i+=16) colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);
      return colors.size;
    });
    assert(pixels > 100, `Canvas blank: ${pixels} colors`);
    const motionBefore = await page.evaluate(() => motion.time);
    await page.locator('#viewport').hover();
    await page.waitForFunction(t => motion.time > t + .1, motionBefore);
    await page.locator('#landArea').hover();
    await page.screenshot({path:'artifacts/desktop.png'});
    await page.locator('#landPackage').selectOption('PKG-LUD');
    await page.locator('#loadPackage').click();
    await page.waitForFunction(() => land.summary?.parcel_count === 8);
    assert.equal(await page.locator('[data-land-id]:checked').count(), 8);
    await page.locator('[data-land-id="P-PB-201"]').uncheck();
    await page.waitForFunction(() => land.summary?.parcel_count === 7);
    await page.locator('#packageName').fill('Browser test package');
    await page.locator('#savePackage').click();
    await page.waitForFunction(() => land.editingId);
    await page.locator('[data-land-id="P-PB-202"]').uncheck();
    await page.waitForFunction(() => land.summary?.parcel_count === 6);
    await page.locator('#updatePackage').click();
    await page.waitForFunction(() => land.packages.find(p => p.id === land.editingId)?.parcel_ids.length === 6);
    for (const view of ['agriculture', 'soil', 'weather', 'risks']) {
      await page.locator(`[data-intel="${view}"]`).click();
      assert((await page.locator('#landInsights').innerText()).includes('P-PB-203'));
    }
    await page.locator('[data-intel="compare"]').click();
    for (const id of ['LUD', 'ALP', 'JOD']) await page.locator(`[data-compare-package="PKG-${id}"]`).check();
    await page.locator('#compareLand').click();
    await page.locator('#comparisonResult tbody tr').first().waitFor();
    assert.equal(await page.locator('#comparisonResult tbody tr').count(), 3);
    await page.locator('#analysisQuestion').selectOption('highest_flood');
    await page.locator('#analyzeLand').click();
    await page.locator('#analysisResult tbody tr').first().waitFor();
    assert.equal(await page.locator('#analysisResult tbody tr').count(), 6);
    await page.locator('#landPackage').selectOption('PKG-ALP');
    await page.locator('#loadPackage').click();
    await page.waitForFunction(() => land.summary?.parcel_ids[0] === 'P-KL-401');
    await page.locator('#landLayer').selectOption('flood');
    assert.equal(await page.evaluate(() => parcelTracers.find(r=>r.parcel.id==='P-KL-401').fill.material.color.getHex()), 0xff6577);
    await page.locator('#landLayer').selectOption('land_use');
    await page.locator('[data-intel="risks"]').click();
    await page.screenshot({path:'artifacts/risks.png'});
    await page.locator('#landMulti').uncheck();
    await page.locator('[data-inspect-land="P-TS-002"]').click();
    await page.waitForFunction(() => land.summary?.parcel_ids[0] === 'P-TS-002');
    assert.equal(await page.evaluate(() => state.selectedFloor.machine_ulpin), await page.evaluate(() => state.selectedParcel.floors[0].machine_ulpin));
    await page.locator('[data-tab="registry"]').click();
    assert.equal(await page.locator('#registryRows .registry-row').count(), 84);
    for (const id of ['exportCsvBtn', 'exportJsonBtn']) {
      const download = page.waitForEvent('download');
      await page.locator('#'+id).click();
      assert((await download).suggestedFilename().includes('ulpin_registry'));
    }
    await page.locator('[data-tab="search"]').click();
    await page.locator('#stateFilter').selectOption('Punjab');
    await page.locator('#searchBtn').click();
    await page.waitForFunction(() => state.filteredParcels.length === 12);
    await page.locator('#clearSearchBtn').click();
    await page.waitForFunction(() => state.filteredParcels.length === 84);
    await page.locator('[data-tab="floors"]').click();
    await page.locator('#floorList [data-floor-id="F2"]').click();
    assert.equal(await page.evaluate(() => state.selectedFloor.id), 'F2');
    await page.locator('#explodeView').click();
    assert.equal(await page.evaluate(() => motion.exploded), true);
    await page.locator('#view2D').click();
    assert.equal(await page.evaluate(() => state.activeView), '2d');
    await page.locator('#view3D').click();
    await page.locator('[data-layer="buildings"]').click();
    assert.equal(await page.evaluate(() => buildingGroup.visible), false);
    await page.locator('[data-layer="buildings"]').click();
    await page.locator('[data-tab="spatial"]').click();
    await page.locator('#overlapBtn').click();
    await page.waitForFunction(() => state.overlap);
    assert(await page.locator('#overlapWarning').isVisible());
    await page.locator('[data-tab="verify"]').click();
    for (const id of ['flagBtn','resurveyBtn']) {
      await page.locator('#'+id).click();
      await page.waitForResponse(r=>r.url().includes('/api/audit') && r.status() === 200);
    }
    await page.locator('#approveBtn').click();
    await page.locator('#propertyModal.show').waitFor();
    assert((await page.locator('#cardMetrics').innerText()).includes(await page.evaluate(() => state.selectedParcel.id)));
    await page.locator('#closeModalBtn').click();
    await page.locator('[data-tab="analytics"]').click();
    assert(await page.locator('#analyticsCards').isVisible());
    await page.locator('#faqBtn').click();
    assert(await page.locator('#tab-faq').isVisible());
    await page.locator('[data-tab="land"]').click();
    await page.locator('[data-intel="overview"]').click();
    await page.locator('#landPackage').selectOption('PKG-LUD');
    await page.locator('#loadPackage').click();
    await page.waitForFunction(() => land.summary?.parcel_count === 8);
    await page.locator('#themeToggle').click();
    await page.screenshot({path:'artifacts/light.png', animations:'disabled'});
    await page.locator('#themeToggle').click();
    await page.setViewportSize({width:390,height:844});
    await page.locator('#landInsights').scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:'artifacts/mobile.png', fullPage:true, animations:'disabled'});
    const mobilePixels = await page.evaluate(() => {
      renderer.render(scene, activeCamera);
      const gl=renderer.getContext(), data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);
      return new Set(Array.from({length:Math.floor(data.length/40)},(_,i)=>data[i*40]+','+data[i*40+1]+','+data[i*40+2])).size;
    });
    assert(mobilePixels>100);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({status:'passed',desktopCanvasColors:pixels,mobileCanvasColors:mobilePixels,errors,screenshots:'artifacts/'}));
  } catch(e) {
    console.error(e);
    console.error('Page errors:',errors);
    await page.screenshot({path:'artifacts/failure.png',fullPage:true});
    process.exitCode=1;
  } finally { await browser.close(); }
})();
