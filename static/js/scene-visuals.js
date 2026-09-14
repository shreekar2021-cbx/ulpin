"use strict";

// Presentation-only builders. Every resource belongs to the returned scene objects
// and is released by the existing disposeGroup lifecycle on location changes.
window.ULPINSceneVisuals = (() => {
  const palette = Object.freeze({
    walls: [0x697778, 0x8d938f, 0x657478, 0x97978d],
    concrete: 0x939990,
    roof: 0x505b59,
    cyan: 0x58ddf4,
    asphalt: 0x303a3b,
    ground: 0x34443d
  });

  function random(seed) {
    const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function surface(options) {
    const material = new THREE.MeshStandardMaterial(options);
    material.color.convertSRGBToLinear();
    return material;
  }

  const classifications = Object.freeze([
    {id: "Commercial", label: "Commercial", color: 0x39c8f2},
    {id: "Residential", label: "Residential", color: 0x42d98f},
    {id: "Industrial", label: "Industrial", color: 0xff9f43},
    {id: "Mixed-Use", label: "Mixed use", color: 0x8e7dff},
    {id: "Public", label: "Public", color: 0xf472b6},
    {id: "Institutional", label: "Institutional", color: 0x55d6be},
    {id: "Agricultural", label: "Agricultural", color: 0x84cc16}
  ]);

  function classification(parcel) {
    return parcel.land_use;
  }

  function cropColor(parcel) {
    if (parcel.agriculture.cultivation_status === "Fallow") return 0x80765b;
    if (parcel.agriculture.cultivation_status === "Sown") return 0x6e7845;
    return {Rice: 0x629449, Wheat: 0xb8a75d, Maize: 0x508046, Cotton: 0x76916c,
      Grapes: 0x456f4c, Tea: 0x386d4f, Coconut: 0x497951, Millet: 0x969756,
      Mustard: 0xaaa654, Onion: 0x798355, Potato: 0x648453}[parcel.agriculture.crop] || 0x688b4b;
  }

  function groundColor(areaId) {
    return {HYD: palette.ground, WAR: 0x556347, LUD: 0x62694a, NAS: 0x646c49,
      JOD: 0x827556, ALP: 0x3f6554, NIL: 0x4a6249}[areaId] || palette.ground;
  }

  function cropBeds(rows, parcel) {
    const positions = [];
    const halfWidth = parcel.cultivation_pattern.spacing * .25;
    for (let i = 0; i < rows.length; i += 2) {
      const a = rows[i], b = rows[i + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const dx = -(b.z - a.z) / length * halfWidth;
      const dz = (b.x - a.x) / length * halfWidth;
      const points = [[a.x + dx, .13, a.z + dz], [b.x + dx, .13, b.z + dz],
        [b.x - dx, .13, b.z - dz], [a.x - dx, .13, a.z - dz]];
      for (const n of [0, 2, 1, 0, 3, 2]) positions.push(...points[n]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = surface({color: cropColor(parcel), roughness: 1, side: THREE.DoubleSide, transparent: true});
    material.color.multiplyScalar(parcel.agriculture.cultivation_status === "Fallow" ? .8 : 1.22);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.kind = "crop-beds";
    return mesh;
  }

  function cropPlants(rows, parcel) {
    if (parcel.cultivation_pattern.kind === "orchard" || parcel.agriculture.cultivation_status === "Fallow") return null;
    const points = [], positions = [];
    let totalLength = 0;
    for (let i = 0; i < rows.length; i += 2) totalLength += rows[i].distanceTo(rows[i + 1]);
    const spacing = Math.max(.45, totalLength / 1200);
    for (let i = 0; i < rows.length; i += 2) {
      const a = rows[i], b = rows[i + 1];
      const length = a.distanceTo(b);
      for (let t = spacing / 2; t < length; t += spacing) {
        points.push({x: a.x + (b.x - a.x) * t / length, z: a.z + (b.z - a.z) * t / length});
      }
    }
    if (!points.length) return null;
    for (let i = 0; i < 3; i++) {
      const x = Math.cos(i * Math.PI / 3) * .12, z = Math.sin(i * Math.PI / 3) * .12;
      positions.push(-x, 0, -z, x, 0, z, 0, .4, 0);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const crop = new THREE.InstancedMesh(geometry,
      surface({color: cropColor(parcel), roughness: 1, side: THREE.DoubleSide, transparent: true}), points.length);
    const transform = new THREE.Object3D();
    points.forEach((point, i) => {
      transform.position.set(point.x, .14, point.z);
      const size = (parcel.agriculture.cultivation_status === "Sown" ? .25 : .7) + random(i) * .4;
      transform.scale.setScalar(size);
      transform.rotation.y = random(i + 7) * Math.PI;
      transform.updateMatrix();
      crop.setMatrixAt(i, transform.matrix);
    });
    crop.instanceMatrix.needsUpdate = true;
    crop.userData.kind = "crop-plants";
    return crop;
  }

  function surroundingLandscape(group, bounds, areaId, parcels) {
    const urban = areaId === "HYD";
    const center = bounds.getCenter(new THREE.Vector3());
    const blocks = [], roads = [], trees = [];
    const cell = urban ? 22 : 32;
    const span = cell * 18;
    const insideRegister = (x, z, margin) => parcels.some(parcel =>
      Math.abs(x - parcel.position.x) < parcel.size.w / 2 + margin &&
      Math.abs(z - parcel.position.z) < parcel.size.d / 2 + margin);
    for (let row = -8; row <= 8; row++) for (let column = -8; column <= 8; column++) {
      const x = center.x + column * cell, z = center.z + row * cell;
      const seed = (row + 9) * 31 + column + 9;
      if (urban) {
        for (let n = 0; n < 4; n++) {
          const bx = x + (n % 2 ? 5 : -5), bz = z + (n < 2 ? -5 : 5);
          if (!insideRegister(bx, bz, 7)) blocks.push({
            x: bx, z: bz, w: 5 + random(seed + n) * 3, d: 5 + random(seed + n + 2) * 3,
            h: 4 + random(seed * 3 + n) * 14
          });
        }
      } else if (!insideRegister(x, z, cell / 2 + 3)) {
        blocks.push({x, z, w: cell - 3, d: cell - 4, h: .08});
      }
      if (!insideRegister(x, z, cell / 2)) {
        roads.push({x: x + cell / 2, z, w: urban ? 2.4 : 1.1, d: cell});
        roads.push({x, z: z + cell / 2, w: cell, d: urban ? 2.4 : 1.1});
      }
      for (let n = 0; n < 4; n++) {
        const tx = x - 8 + n * 5, tz = z + cell * .38;
        if (!insideRegister(tx, tz, 2)) trees.push({x: tx, z: tz, w: 1.8, d: 1.8, h: 2.5});
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 256;
    const ctx = canvas.getContext("2d");
    const dry = areaId === "JOD";
    ctx.fillStyle = urban ? "#7a807c" : dry ? "#8d835d" : "#537044";
    ctx.fillRect(0, 0, 128, 256);
    if (urban) {
      for (let row = 0; row < 12; row++) for (let column = 0; column < 8; column++) {
        ctx.fillStyle = random(row * 17 + column) > .88 ? "#bfa27c" : ["#2e4249", "#3a5159", "#24383d"][column % 3];
        ctx.fillRect(column * 16 + 3, row * 21 + 5, 9, 13);
        ctx.fillStyle = "#9ba39e";
        ctx.fillRect(column * 16, row * 21, 16, 2);
      }
      ctx.fillStyle = "#777e77";
      ctx.fillRect(0, 250, 128, 6);
    } else {
      ctx.fillStyle = dry ? "#a69a6a" : "#76945a";
      for (let y = 0; y < 256; y += 8) ctx.fillRect(0, y, 128, 3);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // Box top and bottom sample the blank roof strip of the shared facade atlas.
    if (urban) for (let i = 8; i < 16; i++) geometry.attributes.uv.setXY(i, .5, .006);
    const material = surface({color: 0xb1b9b7, map: texture, roughness: .9});
    const buildings = new THREE.InstancedMesh(geometry, material, blocks.length);
    const streets = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), surface({color: urban ? 0x3b4444 : 0x827f66, roughness: 1}), roads.length);
    const canopy = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.6, 1), surface({color: 0x335440, roughness: 1}), trees.length);
    const transform = new THREE.Object3D();
    const tint = new THREE.Color();
    const place = (mesh, items) => {
      items.forEach((item, i) => {
        transform.position.set(item.x, item.h / 2 - .15, item.z);
        transform.scale.set(item.w, item.h, item.d);
        transform.updateMatrix();
        mesh.setMatrixAt(i, transform.matrix);
        if (mesh === buildings) {
          tint.setHSL(urban ? .11 : .19 + random(i) * .09, urban ? .06 : .2, .55 + random(i + 2) * .25);
          mesh.setColorAt(i, tint);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.userData.kind = "illustrative-surroundings";
    };
    place(buildings, blocks);
    place(streets, roads.map(road => ({...road, h: .04})));
    place(canopy, trees);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 6, span * 6), surface({color: groundColor(areaId), roughness: 1}));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, -.2, center.z);
    ground.userData.kind = "ground";
    group.add(ground, buildings, streets, canopy);
  }

  function facadeGeometry(building, variant) {
    const positions = [], colors = [];
    const glass = [0x274047, 0x36515a, 0x506771, 0x233238, 0xa58b62, 0xd5b783];
    const color = new THREE.Color();
    const height = building.floor_h;
    building.footprint.forEach((a, side, points) => {
      const b = points[(side + 1) % points.length];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const bays = Math.max(1, Math.floor(length / .9));
      const point = (t, y) => [
        (a.x + (b.x - a.x) * t) * 1.004, y,
        (a.z + (b.z - a.z) * t) * 1.004
      ];
      for (let bay = 0; bay < bays; bay++) {
        // Two panes per bay leave physical wall strips as mullions.
        for (let pane = 0; pane < 2; pane++) {
          const start = (bay + .12 + pane * .395) / bays;
          const end = start + .365 / bays;
          const lit = random(side * 37 + bay * 13 + variant * 19) > .84;
          const tint = lit ? 4 + (bay % 2) : (side + bay + variant) % 4;
          color.setHex(glass[tint]).convertSRGBToLinear();
          const quad = [point(start, -height * .32), point(end, -height * .32),
            point(end, height * .33), point(start, height * .33)];
          for (const index of [0, 1, 2, 0, 2, 3]) {
            positions.push(...quad[index]);
            const reflection = index >= 2 ? 1.18 : .62;
            colors.push(color.r * reflection, color.g * reflection, color.b * reflection);
          }
        }
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return geometry;
  }

  function rooftop(roof, building) {
    const material = surface({color: 0x7c8580, roughness: .85});
    const equipment = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, 3);
    const transform = new THREE.Object3D();
    for (let i = 0; i < 3; i++) {
      transform.position.set((i - 1) * building.w * .19, i === 1 ? .42 : .28, building.d * .22);
      transform.scale.set(building.w * (i === 1 ? .22 : .11), i === 1 ? .7 : .42, building.d * .18);
      transform.updateMatrix();
      equipment.setMatrixAt(i, transform.matrix);
    }
    equipment.instanceMatrix.needsUpdate = true;
    roof.add(equipment);
    const points = [];
    const height = .35;
    building.footprint.forEach((a, i, outline) => {
      const b = outline[(i + 1) % outline.length];
      points.push(new THREE.Vector3(a.x * .94, height, a.z * .94), new THREE.Vector3(b.x * .94, height, b.z * .94));
      const bays = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.2);
      for (let n = 0; n < bays; n++) {
        const x = (a.x + (b.x - a.x) * n / bays) * .94;
        const z = (a.z + (b.z - a.z) * n / bays) * .94;
        points.push(new THREE.Vector3(x, .08, z), new THREE.Vector3(x, height, z));
      }
    });
    const railing = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({color: 0x8d9b9b, transparent: true, opacity: .8}));
    roof.add(railing);
    return [equipment, railing];
  }

  function streets(group, roads) {
    const segments = [];
    for (const road of roads) {
      if (road.kind !== "road") continue;
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1], b = road.points[i];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
        for (let t = .5; t < length - .6; t += 1.8) {
          segments.push(new THREE.Vector3(a.x + dx * t, -.025, a.z + dz * t),
            new THREE.Vector3(a.x + dx * (t + .75), -.025, a.z + dz * (t + .75)));
        }
        for (const sign of [-1, 1]) {
          const offset = sign * road.width * .44;
          segments.push(new THREE.Vector3(a.x - dz * offset, -.025, a.z + dx * offset),
            new THREE.Vector3(b.x - dz * offset, -.025, b.z + dx * offset));
        }
      }
    }
    if (segments.length) group.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(segments),
      new THREE.LineBasicMaterial({color: 0xb5b8a7, transparent: true, opacity: .65})
    ));
  }

  function landscape(group, parcels) {
    const trees = [], paving = [];
    for (const parcel of parcels) {
      if (!parcel.buildings.length || parcel.agriculture) continue;
      // Use the parcel polygon, so landscaping respects clipped/rotated sites.
      const outline = parcel.boundary;
      for (let side = 0; side < outline.length; side++) {
        const a = outline[side], b = outline[(side + 1) % outline.length];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        for (let distance = 1.3; distance < length - 1; distance += 3.4) {
          const t = distance / length;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          trees.push({x: x * .9 + parcel.position.x * .1, z: z * .9 + parcel.position.z * .1});
        }
      }
      for (const b of parcel.buildings) paving.push(b);
    }
    if (!trees.length) return;
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.7, 1),
      new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 1}), trees.length);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(.075, .12, .9, 5),
      surface({color: 0x605c4a, roughness: 1}), trees.length);
    const transform = new THREE.Object3D();
    const color = new THREE.Color();
    trees.forEach((tree, i) => {
      transform.position.set(tree.x, .42, tree.z);
      transform.scale.set(1, 1, 1);
      transform.updateMatrix();
      trunks.setMatrixAt(i, transform.matrix);
      const scale = .8 + random(i) * .45;
      transform.position.y = 1.1;
      transform.scale.set(scale, scale * 1.15, scale);
      transform.rotation.y = random(i + 1) * Math.PI;
      transform.updateMatrix();
      crown.setMatrixAt(i, transform.matrix);
      color.setHex([0x3b6550, 0x54724b, 0x2e5647, 0x65805a][i % 4]).convertSRGBToLinear();
      crown.setColorAt(i, color);
    });
    crown.instanceMatrix.needsUpdate = trunks.instanceMatrix.needsUpdate = true;
    group.add(crown, trunks);

    // One shared soft contact-shadow texture avoids a per-frame shadow pass.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(32, 32, 5, 32, 32, 32);
    gradient.addColorStop(0, "rgba(0,0,0,.9)");
    gradient.addColorStop(.55, "rgba(0,0,0,.6)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const material = new THREE.MeshBasicMaterial({map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false});
    const geometry = new THREE.PlaneGeometry(1, 1);
    for (const b of paving) {
      const shadow = new THREE.Mesh(geometry, material);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(b.position.x + .65, -.055, b.position.z + .4);
      shadow.scale.set(b.w * 1.9, b.d * 1.9, 1);
      group.add(shadow);
    }
  }

  function undergroundColor(type) {
    return {water: 0x35c9f4, sewer: 0x8b6f47, gas: 0xffc857, electrical: 0xffe27a, telecom: 0xb995ff, drainage: 0x55d6be, chamber: 0xe7edf0, tunnel: 0x9ba8a4}[type] || 0x8fd3d8;
  }

  function tube(points, radius, color, metadata) {
    const curve = new THREE.CatmullRomCurve3(points);
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, points.length * 10), radius, 10, false), surface({color, roughness:.38, metalness:.18, emissive:color, emissiveIntensity:.12}));
    mesh.userData = {...metadata, kind:"underground-asset", baseColor:color};
    return mesh;
  }

  function undergroundNetwork(group, parcels) {
    const p = parcels[0]; if (!p) return {assets: []};
    const x = p.position.x, z = p.position.z, assets = [];
    const addTube = (id, type, label, pts, depth, diameter, extra={}) => {
      const asset = {assetId:id, infrastructureType:label, category:type, depth, dimensions:`${diameter} mm`, ownership:"Municipal utility", installationDate:"2019-06-18", status:"Operational", ...extra};
      assets.push(asset); group.add(tube(pts.map(v => new THREE.Vector3(v[0], -depth, v[1])), Math.max(.055, diameter/1200), undergroundColor(type), asset));
    };
    addTube("WTR-001", "water", "Water line", [[x-8,z+8],[x-2,z+3],[x+8,z+3]], 1.8, 450, {material:"Ductile iron", owner:"Water Works"});
    addTube("SWR-014", "sewer", "Sewer line", [[x-9,z+6],[x-3,z],[x+9,z]], 2.7, 600, {material:"HDPE", owner:"City Sewerage"});
    addTube("GAS-022", "gas", "Gas line", [[x-8,z-6],[x,z-2],[x+10,z-2]], 1.35, 250, {material:"PE100", owner:"Gas Utility"});
    addTube("ELC-109", "electrical", "Electrical cable", [[x-10,z-4],[x-1,z-4],[x+9,z+6]], .85, 90, {material:"XLPE", owner:"Power Distribution"});
    addTube("TEL-031", "telecom", "Fiber duct", [[x-10,z+10],[x,z+7],[x+11,z+8]], .65, 110, {material:"HDPE duct", owner:"Telecom Network"});
    addTube("DRN-006", "drainage", "Drainage", [[x-11,z+1],[x-4,z+1],[x+9,z+11]], 1.1, 300, {material:"Reinforced concrete", owner:"Stormwater Division"});
    const chamber = new THREE.Mesh(new THREE.BoxGeometry(1.25,.7,1.25), surface({color:undergroundColor("chamber"), roughness:.7}));
    chamber.position.set(x+1,-2.15,z+1); chamber.userData={kind:"underground-asset",assetId:"CHM-004",infrastructureType:"Utility chamber",category:"chamber",depth:2.15,dimensions:"1.25 x 1.25 x 0.70 m",ownership:"Municipal utility",installationDate:"2018-04-02",status:"Accessible"}; group.add(chamber); assets.push(chamber.userData);
    const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(1.0,1.0,7,16,1,false), surface({color:undergroundColor("tunnel"),transparent:true,opacity:.55,side:THREE.DoubleSide}));
    tunnel.rotation.z=Math.PI/2; tunnel.position.set(x+5,-3.8,z-8); tunnel.userData={kind:"underground-asset",assetId:"TUN-002",infrastructureType:"Service tunnel",category:"tunnel",depth:3.8,dimensions:"2 m diameter x 7 m",ownership:"Civic Works",installationDate:"2016-11-20",status:"Operational"}; group.add(tunnel); assets.push(tunnel.userData);
    return {assets};
  }

  return Object.freeze({palette, surface, facadeGeometry, rooftop, streets, landscape,
    classifications, classification, cropColor, cropBeds, cropPlants, groundColor, surroundingLandscape, undergroundNetwork, undergroundColor});
})();
