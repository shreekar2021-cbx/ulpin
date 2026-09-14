const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 960}});
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ulpin-visual-review-'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const capture = async name => {
    const stats = await page.evaluate(() => {
      renderStillFrame();
      const gl = renderer.getContext();
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 40) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      return {colors: colors.size, calls: renderer.info.render.calls, memory: {...renderer.info.memory},
        floors: floorMeshes.length, aspect: perspectiveCamera.aspect,
        viewportAspect: $('viewport').clientWidth / $('viewport').clientHeight};
    });
    assert(stats.colors > 100, `${name}: blank scene`);
    assert(stats.calls < 650, `${name}: excessive draw calls: ${stats.calls}`);
    assert(Math.abs(stats.aspect - stats.viewportAspect) < .01, `${name}: incorrect projection`);
    await page.locator('#viewport').screenshot({path: path.join(output, `${name}.png`)});
    return stats;
  };
  try {
    await page.goto(process.env.ULPIN_URL || 'http://127.0.0.1:8013/login');
    await page.locator('#loginUsername').fill(process.env.ULPIN_TEST_USERNAME || 'visual_test');
    await page.locator('#loginPassword').fill(process.env.ULPIN_TEST_PASSWORD || 'visual_test_password');
    await page.locator('#loginForm [type="submit"]').click();
    await page.waitForURL('**/user');
    await page.waitForFunction(() => state.sceneReady && land.summary);
    await page.evaluate(() => { motion.enabled = false; motion.orbit = false; resetCamera(true); });
    const overview = await capture('overview');
    const legendTotal = await page.locator('#legendClasses b').allTextContents();
    assert.equal(legendTotal.reduce((sum, n) => sum + Number(n), 0), 12);
    const selectionBeforeLegend = await page.evaluate(() => state.selectedParcel.id);
    await page.locator('[data-legend-class="Residential"]').click();
    assert(await page.evaluate(() => state.legendClass === 'Residential' && floorMeshes
      .filter(m => state.parcelById.get(m.userData.parcelId).land_use === 'Commercial')
      .every(m => m.material.opacity < .3)));
    assert.equal(await page.evaluate(() => state.selectedParcel.id), selectionBeforeLegend);
    await capture('legend-residential');
    await page.locator('[data-legend-class="Residential"]').click();
    assert.equal(await page.evaluate(() => state.legendClass), null);
    assert(await page.evaluate(() => terrainGroup.children.some(mesh => mesh.userData.kind === 'illustrative-surroundings')));
    const building = await page.evaluate(() => {
      const parcel = state.sceneParcels.reduce((best, p) => p.floors.length > best.floors.length ? p : best);
      const floor = parcel.floors[Math.floor(parcel.floors.length / 2)];
      selectFloor(parcel.id, floor.id, true);
      return {parcel: parcel.id, floor: floor.id};
    });
    await page.waitForFunction(() => !cameraTween);
    const detail = await capture('selected-floor');
    assert(await page.evaluate(() => floorMeshes.filter(m => m.userData.kind === 'floor').every(m =>
      m.material.opacity >= .95 && m.children.some(c => c.userData.kind === 'facade' && c.isMesh))));

    // Hit a real floor surface through the existing raycaster, then right-click it.
    const hit = await page.evaluate(() => {
      const target = getFloorMesh(state.selectedParcel.id, state.selectedFloor.id);
      const rect = renderer.domElement.getBoundingClientRect();
      for (let y = .15; y < .85; y += .025) for (let x = .1; x < .9; x += .025) {
        raycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), activeCamera);
        if (raycaster.intersectObjects(buildingPickMeshes, false)[0]?.object === target)
          return {x: rect.left + x * rect.width, y: rect.top + y * rect.height};
      }
      return null;
    });
    assert(hit, 'selected floor must remain raycastable');
    await page.mouse.click(hit.x, hit.y, {button: 'right'});
    await page.locator('#viewBlueprintAction').click();
    await page.waitForFunction(() => state.blueprint.open);
    assert(await page.evaluate(() => state.blueprint.plan.rooms.length > 0));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !state.blueprint.open);
    await page.evaluate(() => { clearIsolation(); resetCamera(true); });

    const beforeOrbit = await page.evaluate(() => perspectiveCamera.position.toArray());
    const rect = await page.locator('#viewport').boundingBox();
    await page.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .5);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * .6, rect.y + rect.height * .55, {steps: 8});
    await page.mouse.up();
    assert.notDeepEqual(await page.evaluate(() => perspectiveCamera.position.toArray()), beforeOrbit);
    await page.locator('[data-layer="buildings"]').click();
    assert.equal(await page.evaluate(() => buildingGroup.visible), false);
    await page.locator('[data-layer="buildings"]').click();

    const memories = [];
    for (let i = 0; i < 3; i++) {
      await page.locator('#landArea').selectOption('JOD');
      await page.waitForFunction(() => state.activeAreaId === 'JOD');
      await page.locator('#landArea').selectOption('HYD');
      await page.waitForFunction(() => state.activeAreaId === 'HYD');
      memories.push((await capture(`reload-${i}`)).memory);
    }
    assert.deepEqual(memories[1], memories[0], 'GPU resources grew across location changes');
    assert.deepEqual(memories[2], memories[0], 'GPU resources grew across location changes');
    await page.locator('#landArea').selectOption('JOD');
    await page.waitForFunction(() => state.activeAreaId === 'JOD');
    const rural = await capture('rural');
    await page.locator('[data-legend-class="Agricultural"]').click();
    assert.equal(await page.locator('[data-legend-class="Agricultural"] b').textContent(), '8');
    assert(await page.evaluate(() => fieldPickMeshes.every(mesh => mesh.children.some(child => child.userData.kind === 'crop-beds'))));
    await page.locator('[data-legend-class="Agricultural"]').click();
    await page.evaluate(() => {
      const field = state.sceneParcels.find(p => p.agriculture?.cultivation_status === 'Growing') || state.sceneParcels.find(p => p.agriculture);
      selectParcelById(field.id, true);
    });
    await page.waitForFunction(() => !cameraTween);
    await capture('crop-detail');
    await page.locator('#landArea').selectOption('NAS');
    await page.waitForFunction(() => state.activeAreaId === 'NAS');
    assert(await page.evaluate(() => fieldPickMeshes.some(mesh => mesh.children.some(child => child.userData.kind === 'orchard'))));
    await capture('orchards');
    await page.locator('#landArea').selectOption('NIL');
    await page.waitForFunction(() => state.activeAreaId === 'NIL');
    await capture('terraces');
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#landArea').selectOption('HYD');
    await page.locator('#viewport').scrollIntoViewIfNeeded();
    await page.evaluate(() => { onResize3D(); resetCamera(true); });
    const mobile = await capture('mobile');
    await page.locator('#spatialLegend summary').click();
    await page.locator('[data-legend-class="Residential"]').click();
    assert.equal(await page.evaluate(() => state.legendClass), 'Residential');
    await page.locator('[data-legend-class="Residential"]').click();
    await page.locator('#spatialLegend summary').click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({status: 'passed', output, building, overview, detail, rural, mobile, memories}));
  } catch (error) {
    await page.screenshot({path: path.join(output, 'failure.png')});
    console.error(error, errors, output);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
