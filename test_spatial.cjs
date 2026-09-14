const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404 (Not Found)')) errors.push(message.text()); });
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ulpin-spatial-'));

  async function sceneState(area) {
    await page.waitForFunction(id => state.activeAreaId === id && state.sceneReady, area);
    const result = await page.evaluate(() => {
      // Upload normally hidden scanners once so lazy GPU allocation cannot skew comparisons.
      const hidden = [];
      scene.traverse(obj => { if (!obj.visible) { hidden.push(obj); obj.visible = true; } });
      renderer.render(scene, activeCamera);
      hidden.forEach(obj => { obj.visible = false; });
      renderStillFrame();
      const ids = new Set(), foreign = [], resources = [];
      scene.traverse(obj => {
        if (obj.userData.parcelId) {
          ids.add(obj.userData.parcelId);
          if (!state.sceneParcels.some(p => p.id === obj.userData.parcelId)) foreign.push(obj.userData.parcelId);
        }
        // Three.js sprites share a library-owned quad across all instances.
        if (obj.geometry && !obj.isSprite) resources.push(obj.geometry.uuid);
      });
      const gl = renderer.getContext(), pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 16) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      const outside = [];
      floorMeshes.forEach(mesh => {
        const p = mesh.position.clone().project(activeCamera);
        if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || Math.abs(p.z) > 1) outside.push(mesh.userData.parcelId);
      });
      return {ids: [...ids], foreign, resources, colors: colors.size, outside,
        floors: floorMeshes.length, expectedFloors: state.sceneParcels.reduce((sum, p) => sum + p.floors.length, 0),
        memory: {...renderer.info.memory}, calls: renderer.info.render.calls,
        shapes: state.sceneParcels.map(p => [p.position, p.boundary, p.building]),
        selected: state.selectedParcel?.area_id, conflicts: riskGroup.children.length};
    });
    assert.deepEqual(result.foreign, []);
    assert.equal(result.ids.length, 12);
    assert.equal(result.floors, result.expectedFloors);
    assert.equal(result.selected, area);
    assert(result.colors > 100, `Blank canvas: ${result.colors}`);
    assert.deepEqual(result.outside, [], 'Camera must contain the location');
    assert(result.calls < 650, `Too many draw calls: ${result.calls}`);
    return result;
  }

  async function selectArea(area) {
    await page.locator('#landArea').selectOption(area);
    return sceneState(area);
  }

  try {
    await page.goto(process.env.ULPIN_URL || 'http://127.0.0.1:8001', {waitUntil: 'networkidle'});
    await page.waitForFunction(() => state.sceneReady && land.summary);
    const apiParcels = await (await page.request.get(new URL('/api/search?land_use=Agricultural', page.url()).href)).json();
    assert.equal(apiParcels.count, 48);
    assert(apiParcels.items.every(p => p.land_use === 'Agricultural' && p.buildings.length === 0));
    const hyd = await sceneState('HYD');
    await page.screenshot({path: path.join(output, 'hyderabad.png')});
    assert(hyd.memory.geometries < 250, 'Shared building geometry was not reused');
    assert(hyd.calls < 494, 'Instanced rooftop panels did not reduce draw calls');
    const reuse = await page.evaluate(async () => {
      const uuids = () => floorMeshes.map(m => m.uuid).join(',');
      const before = uuids(), control = controls;
      selectParcelById('P-TS-002', false);
      selectFloor('P-TS-002', 'F2', false);
      set3DView(false);
      await refreshLand();
      return {sameMeshes: before === uuids(), sameControls: controls === control,
        shared: floorMeshes.filter(m => m.userData.parcelId === 'P-TS-002').every(m => m.geometry === getFloorMesh('P-TS-002', 'F0').geometry),
        tooltip: $('selectionChip').textContent};
    });
    assert(reuse.sameMeshes && reuse.sameControls && reuse.shared);
    assert(reuse.tooltip.includes('Residential building'));

    await page.evaluate(() => {
      window.disposal = {expected: 0, actual: 0};
      const seen = new Set();
      [terrainGroup, parcelGroup, buildingGroup, riskGroup, conflictGroup].forEach(group => group.traverse(obj => {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        const resources = [obj.geometry, ...materials, obj.isInstancedMesh ? obj : null];
        materials.filter(Boolean).forEach(m => Object.values(m).forEach(v => { if (v?.isTexture) resources.push(v); }));
        resources.filter(Boolean).forEach(resource => {
          if (seen.has(resource.uuid)) return;
          seen.add(resource.uuid); window.disposal.expected++;
          resource.addEventListener('dispose', () => window.disposal.actual++);
        });
      }));
    });
    const jod = await selectArea('JOD');
    assert.notDeepEqual(jod.shapes, hyd.shapes);
    assert.equal(jod.conflicts, 0);
    assert(!jod.resources.some(id => hyd.resources.includes(id)), 'Old geometry retained');
    const disposed = await page.evaluate(() => window.disposal);
    assert.equal(disposed.actual, disposed.expected, 'Every geometry, material and texture must be disposed once');
    await page.waitForFunction(() => land.summary?.parcel_ids.every(id => id.startsWith('P-RJ-')));
    assert((await page.locator('#parcelWeatherTitle').innerText()).includes('P-RJ-'));
    assert(!(await page.locator('#analyticsCharts').innerText()).includes('P-TS-'));
    await page.screenshot({path: path.join(output, 'jodhpur.png')});
    assert.equal(await page.evaluate(() => floorMeshes.filter(m => m.userData.kind === 'land-record').length), 8);
    assert.equal(await page.evaluate(() => floorMeshes.filter(m => m.userData.buildingId).length), 12);
    assert(await page.evaluate(() => fieldPickMeshes.every(m => m.parent === parcelGroup) && buildingPickMeshes.every(m => m.parent === buildingGroup)));

    const target = await page.evaluate(() => {
      setOrbit(false);
      const mesh = floorMeshes.find(m => m.userData.parcelId === 'P-RJ-509' && m.userData.floorId === 'F2');
      const point = mesh.position.clone().project(activeCamera), rect = renderer.domElement.getBoundingClientRect();
      return {x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2};
    });
    const motionBefore = await page.evaluate(() => motion.time);
    await page.mouse.move(target.x, target.y);
    await page.waitForFunction(t => motion.time > t, motionBefore);
    assert(await page.evaluate(() => (hoveredFloor || hoveredParcel)?.userData.parcelId.startsWith('P-RJ-')));
    assert((await page.locator('#selectionChip').innerText()).includes('P-RJ-'));
    assert((await page.locator('#selectionChip').innerText()).includes('building'));
    const mutations = await page.evaluate(async position => {
      let count = 0;
      const observer = new MutationObserver(records => { count += records.length; });
      observer.observe($('selectionChip'), {childList: true, subtree: true});
      observer.observe($('parcelWeatherDetails'), {childList: true, subtree: true});
      for (let i = 0; i < 30; i++) onPointerMove({clientX: position.x, clientY: position.y});
      await Promise.resolve(); observer.disconnect();
      return count;
    }, target);
    assert.equal(mutations, 0, 'Unchanged hover rebuilt tooltip/weather DOM');
    await page.mouse.click(target.x, target.y);
    assert.equal(await page.evaluate(() => state.selectedParcel.area_id), 'JOD');
    await page.locator('#landArea').hover();

    for (let i = 0; i < 8; i++) {
      const back = await selectArea('HYD');
      assert.deepEqual(back.memory, hyd.memory, 'Hyderabad GPU resource count grew');
      const next = await selectArea('JOD');
      assert.deepEqual(next.memory, jod.memory, 'Jodhpur GPU resource count grew');
    }
    for (const id of ['WAR', 'LUD', 'NAS', 'ALP', 'NIL']) await selectArea(id);
    await selectArea('NAS');
    assert(await page.evaluate(() => { let count = 0; parcelGroup.traverse(o => { if (o.isInstancedMesh && o.userData.kind === 'orchard') count++; }); return count > 0; }));

    await selectArea('JOD');
    const agriculturalBuilding = await page.evaluate(() => {
      const p = state.sceneParcels.find(p => p.agriculture);
      const originalArea = p.area_ha;
      const floor = {...p.floors[0], id: 'B1-F0', name: 'Storage floor', usage: 'Storage'};
      const b = {id: `${p.id}-B1`, parcel_id: p.id, type: 'Farm storage building', floors: [floor],
        position: {...p.position, y: .3}, height: 1.5, floor_h: 1.5, w: 2, d: 2,
        footprint: [{x: -1, z: -1}, {x: 1, z: -1}, {x: 1, z: 1}, {x: -1, z: 1}]};
      p.buildings.push(b); p.floors.push(floor);
      replaceLocationScene();
      selectFloor(p.id, floor.id, false);
      const result = {field: floorMeshes.some(m => m.userData.parcelId === p.id && m.userData.kind === 'land-record'),
        building: floorMeshes.some(m => m.userData.buildingId === b.id),
        tooltip: $('selectionChip').textContent, landUse: p.land_use, sameArea: originalArea === p.area_ha};
      p.buildings.pop(); p.floors.pop();
      state.selectedFloor = p.floors[0]; replaceLocationScene();
      return result;
    });
    assert(agriculturalBuilding.field && agriculturalBuilding.building && agriculturalBuilding.sameArea);
    assert.equal(agriculturalBuilding.landUse, 'Agricultural');
    assert(agriculturalBuilding.tooltip.includes('Farm storage building'));

    await page.locator('#landArea').selectOption('');
    await page.locator('#landQuery').fill('Hyderabad');
    await sceneState('HYD');
    await page.locator('#landQuery').fill('Jodhpur');
    await sceneState('JOD');
    await page.locator('#landQuery').fill('No-such-location');
    assert.equal(await page.evaluate(() => floorMeshes.length), 0);
    assert.equal(await page.evaluate(() => state.selectedParcel), null);
    assert.equal(await page.locator('#floorMetrics').innerText(), '');
    await page.locator('#landQuery').fill('');

    await page.locator('[data-tab="search"]').click();
    await page.locator('#districtFilter').selectOption('Hyderabad');
    await page.locator('#searchBtn').click();
    await sceneState('HYD');
    await page.locator('#districtFilter').selectOption('Jodhpur');
    await page.locator('#searchBtn').click();
    await sceneState('JOD');
    await page.locator('#clearSearchBtn').click();
    await sceneState('HYD');

    // A delayed search response must not overwrite a newer search.
    await page.route('**/api/search?**', async route => {
      const response = await route.fetch();
      if (route.request().url().includes('district=Hyderabad')) await new Promise(resolve => setTimeout(resolve, 600));
      await route.fulfill({response});
    });
    const delayedSearch = page.waitForResponse(r => r.url().includes('district=Hyderabad'));
    await page.locator('#districtFilter').selectOption('Hyderabad');
    await page.locator('#searchBtn').click();
    await page.locator('#districtFilter').selectOption('Jodhpur');
    await page.locator('#searchBtn').click();
    await sceneState('JOD');
    await delayedSearch;
    assert.equal(await page.evaluate(() => state.activeAreaId), 'JOD');
    await page.unroute('**/api/search?**');

    await page.locator('[data-tab="land"]').click();
    await page.locator('#view2D').click();
    await selectArea('HYD');
    await selectArea('JOD');
    assert.equal(await page.evaluate(() => state.activeView), '2d');
    await page.locator('#view3D').click();
    await page.locator('#landArea').hover();
    await page.setViewportSize({width: 390, height: 844});
    const resizedArea = await page.evaluate(() => {
      setSceneLocation('HYD');
      perspectiveCamera.aspect = 2; // Simulate resize arriving during the location replacement.
      setSceneLocation('JOD');
      return state.activeAreaId;
    });
    assert.equal(resizedArea, 'JOD', 'Resize fitting restored the previous location');
    await page.locator('#viewport').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => viewportVisible);
    await page.evaluate(() => { onResize3D(); resetCamera(true); });
    await sceneState('JOD');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: path.join(output, 'jodhpur-mobile.png'), fullPage: true});
    await page.locator('#viewport').screenshot({path: path.join(output, 'jodhpur-mobile-canvas.png')});
    await page.locator('#landArea').selectOption('HYD');
    await page.locator('#viewport').scrollIntoViewIfNeeded();
    await page.evaluate(() => resetCamera(true));
    await sceneState('HYD');
    await page.screenshot({path: path.join(output, 'hyderabad-mobile.png'), fullPage: true});
    assert.equal(navigations, 1, 'Location changes reloaded the page');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({status: 'passed', output, disposed, hyd: {memory: hyd.memory, calls: hyd.calls, colors: hyd.colors}, jod: {memory: jod.memory, calls: jod.calls, colors: jod.colors}, navigations, errors}));
  } catch (error) {
    console.error(error, errors);
    console.error('Screenshots:', output);
    await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true});
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
