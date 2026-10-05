// Focused offline WebGL acceptance for the authored upper platform, bow path,
// and outboard ramp. view.check.mjs owns the browser/login fixture; this
// module starts after that fixture has reached the real channel stage.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const sampleRoute = route => {
  const candidates = [
    ['roof-upper-platform', point => point.z > 60 && point.y > 15],
    ['bow-narrow-platform', point => point.z < -65],
    ['outboard-ramp', point => Math.abs(point.x) > 16 && Math.abs(point.y - 12) < 1],
  ];
  return candidates.map(([label, predicate]) => {
    const index = route.findIndex(predicate);
    assert(index >= 0, label + ': shared route point is missing');
    const point = route[index];
    return { label, index, point: [point.x, point.y, point.z] };
  });
};

const renderProductionFrame = async page => {
  await page.evaluate(() => {
    const voyage = window.__entry?.voyage;
    if (!voyage) throw new Error('voyage instance is unavailable');
    // draw is private in TypeScript but remains the production frame entry
    // point in the browser bundle. Calling it keeps camera follow, carrier
    // placement, and the real cloud pass together; no cloud pass is stubbed.
    if (typeof voyage.draw === 'function') {
      const start = performance.now();
      for (let index = 0; index < 6; index++) voyage.draw(start + index * 32);
      return;
    }
    voyage.updateActivity();
    voyage.ship?.updateWorldMatrix(true, true);
    voyage.camera.updateMatrixWorld(true);
    voyage.clouds.render(
      voyage.renderer,
      voyage.scene,
      voyage.camera,
      voyage.sun,
      voyage.cabinShown ? voyage.windowLight : undefined,
    );
  });
  await page.waitForTimeout(120);
};

const frameState = page => page.evaluate(() => {
  const voyage = window.__entry.voyage;
  const deck = voyage.deck;
  const T = window.__three;
  const doll = voyage.passengers.root.getObjectByName('SV3_Passenger_preview-swap');
  if (!doll) throw new Error('selected preview passenger carrier is missing');
  let visible = true;
  for (let parent = doll; parent; parent = parent.parent) visible &&= parent.visible;

  const box = new T.Box3().setFromObject(doll);
  const corners = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) corners.push(new T.Vector3(x, y, z).project(voyage.camera));
    }
  }
  const screenVisible = visible && corners.some(point =>
    point.x >= -1 && point.x <= 1 &&
    point.y >= -1 && point.y <= 1 &&
    point.z >= -1 && point.z <= 1,
  );

  const supportY = typeof deck.ground === 'function'
    ? deck.ground(deck.position.x, deck.position.z, deck.position.y + .4, .8)
    : undefined;
  const supported = Number.isFinite(supportY) &&
    typeof deck.canStand === 'function' &&
    deck.canStand(deck.position.clone(), supportY);

  const eye = voyage.camera.position.clone();
  const ray = voyage.cameraRay;
  let nearEye = Infinity;
  const obstacles = voyage.cameraObstacles.filter(mesh => {
    for (let parent = mesh; parent; parent = parent.parent) if (!parent.visible) return false;
    return true;
  });
  for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    ray.set(eye, new T.Vector3(...direction));
    ray.far = .30;
    nearEye = Math.min(nearEye, ray.intersectObjects(obstacles, false)[0]?.distance ?? Infinity);
  }

  const footWorld = voyage.ship.localToWorld(deck.position.clone());
  const dollWorld = doll.getWorldPosition(new T.Vector3());
  return {
    position: deck.position.toArray(),
    routeDistance: deck.routeDistance,
    supportY: Number.isFinite(supportY) ? supportY : null,
    supported,
    screenVisible,
    nearEye: Number.isFinite(nearEye) ? nearEye : null,
    carrierError: footWorld.distanceTo(dollWorld),
    deckCarrierError: deck.position.distanceTo(voyage.passengers.deckPosition),
    camera: voyage.camera.position.toArray(),
    aim: voyage.aim.toArray(),
  };
});

const diagnoseOcclusion = (page, label) => page.evaluate(label => {
  const voyage = window.__entry.voyage;
  const T = window.__three;
  const doll = voyage.passengers.root.getObjectByName('SV3_Passenger_preview-swap');
  const record = object => {
    if (!object) return null;
    const chain = [];
    for (let node = object; node; node = node.parent) chain.push(node.name || node.type);
    const box = new T.Box3().setFromObject(object);
    const geometry = object.geometry;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    return {
      name: object.name || null,
      type: object.type,
      parentChain: chain,
      parentMetadata: chain.map((_, index) => {
        let node = object;
        for (let i = 0; i < index && node; i++) node = node.parent;
        return node ? {
          name: node.name || node.type,
          userData: Object.fromEntries(Object.entries(node.userData ?? {}).filter(([key]) =>
            ['layer', 'lobby_walkable', 'walk_surface_source', 'walk_surface_height', 'structural_repair_child', 'original_source', 'source', 'role', 'kind'].includes(key))),
        } : null;
      }),
      material: material ? {
        name: material.name || null,
        type: material.type,
        transparent: Boolean(material.transparent),
        transmission: Number(material.transmission ?? 0),
        side: material.side,
      } : null,
      geometry: geometry ? {
        type: geometry.type,
        positionCount: geometry.attributes?.position?.count ?? null,
        indexCount: geometry.index?.count ?? null,
        localBox: geometry.boundingBox ? {
          min: geometry.boundingBox.min.toArray(),
          max: geometry.boundingBox.max.toArray(),
        } : null,
      } : null,
      worldBox: {
        min: box.min.toArray(),
        max: box.max.toArray(),
        size: box.getSize(new T.Vector3()).toArray(),
      },
      userData: Object.fromEntries(Object.entries(object.userData ?? {}).filter(([key]) =>
        ['layer', 'lobby_walkable', 'walk_surface_source', 'walk_surface_height', 'structural_repair_child', 'original_source', 'source', 'role', 'kind'].includes(key))),
    };
  };
  const visible = object => {
    for (let parent = object; parent; parent = parent.parent) if (!parent.visible) return false;
    return true;
  };
  const firstHits = (target, limit = 5) => {
    const origin = voyage.camera.position.clone();
    const direction = target.clone().sub(origin);
    const distance = direction.length();
    direction.normalize();
    const raycaster = new T.Raycaster(origin, direction, 0, Math.max(0, distance - .05));
    const all = raycaster.intersectObjects(voyage.cameraObstacles, true)
      .filter(hit => visible(hit.object))
      .filter(hit => !doll || !doll.getObjectById(hit.object.id));
    const seen = new Set();
    return all.filter(hit => {
      if (seen.has(hit.object.id)) return false;
      seen.add(hit.object.id);
      return true;
    }).slice(0, limit).map(hit => {
      const normal = hit.face?.normal?.clone();
      if (normal) normal.applyNormalMatrix(new T.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      const entry = record(hit.object);
      const position = hit.object.geometry?.attributes?.position;
      const index = hit.object.geometry?.index;
      const triangle = hit.faceIndex === undefined || !position ? null : [0, 1, 2].map(offset => {
        const vertex = new T.Vector3().fromBufferAttribute(position, index ? index.getX(hit.faceIndex * 3 + offset) : hit.faceIndex * 3 + offset);
        return vertex.applyMatrix4(hit.object.matrixWorld).toArray();
      });
      return {
        distance: hit.distance,
        point: hit.point.toArray(),
        faceIndex: hit.faceIndex ?? null,
        normal: normal?.toArray() ?? null,
        triangleWorld: triangle,
        ...entry,
      };
    });
  };
  if (!doll) throw new Error('selected preview passenger carrier is missing for occlusion diagnosis');
  voyage.camera.updateMatrixWorld(true);
  doll.updateWorldMatrix(true, true);
  const box = new T.Box3().setFromObject(doll);
  const foot = voyage.ship.localToWorld(voyage.deck.position.clone());
  const middle = box.getCenter(new T.Vector3());
  const head = new T.Vector3(middle.x, box.max.y - Math.min(.05, box.getSize(new T.Vector3()).y * .05), middle.z);
  const points = { foot, middle, head };
  const ray = Object.fromEntries(Object.entries(points).map(([name, point]) => [name, {
    target: point.toArray(),
    distance: voyage.camera.position.distanceTo(point),
    hits: firstHits(point),
  }]));
  const privateDoll = voyage.passengers.dolls?.get?.('preview-swap');
  const meshBox = new T.Box3().setFromObject(privateDoll?.mesh ?? doll);
  const canvas = privateDoll?.canvas;
  const mesh = privateDoll?.mesh;
  const mapImage = mesh?.material?.map?.image;
  // Mirror LocalReveal's four body samples with its public triangle ray helper
  // so a screen-space box cannot mask a failed reveal decision. This stays a
  // read-only diagnosis; the production reveal update already ran above.
  const reveal = voyage.reveal;
  const revealFoot = foot.clone();
  const revealHead = foot.clone().add(new T.Vector3(0, 2.2, 0));
  const revealMiddle = foot.clone().add(new T.Vector3(0, 1.1, 0));
  const revealSide = new T.Vector3().setFromMatrixColumn(voyage.camera.matrixWorld, 0).multiplyScalar(.3);
  const revealTargets = [
    ['foot', revealFoot.clone().add(new T.Vector3(0, .15, 0))],
    ['head', revealHead],
    ['middle-right', revealMiddle.clone().add(revealSide)],
    ['middle-left', revealMiddle.clone().sub(revealSide)],
  ];
  const revealSamples = reveal && Array.isArray(reveal.candidates) ? revealTargets.map(([name, target]) => {
    const direction = target.clone().sub(voyage.camera.position);
    const distance = direction.length() - .05;
    direction.normalize();
    const ray = new T.Ray(voyage.camera.position.clone(), direction);
    const hits = reveal.candidates.flatMap(item => {
      let parent = item.mesh;
      while (parent && parent.visible) parent = parent.parent;
      if (parent) return [];
      const entry = item.bounds?.clone?.();
      const boxHit = entry && ray.intersectBox(entry, new T.Vector3());
      const originInside = Boolean(entry?.containsPoint?.(voyage.camera.position));
      // Three's Ray.intersectBox returns the far exit when the camera starts
      // inside a broad sail box. LocalReveal deliberately treats that as a
      // candidate and lets the real triangle/morph ray decide the hit.
      if ((!boxHit && !originInside) || (!originInside && boxHit.distanceTo(voyage.camera.position) >= distance)) return [];
      const hitDistance = typeof reveal.surfaceDistance === 'function'
        ? reveal.surfaceDistance(item.mesh, voyage.camera.position, direction, distance)
        : undefined;
      if (!Number.isFinite(hitDistance) || hitDistance >= distance) return [];
      return [{ name: item.mesh.name || item.mesh.type, distance: hitDistance, instance: item.instance ?? null }];
    }).sort((a, b) => a.distance - b.distance);
    const debug = name === 'foot' ? reveal.candidates.filter(item => item.mesh.name === 'SV3_AftFan_2').map(item => {
      item.mesh.updateWorldMatrix(true, true);
      const box = item.bounds?.clone?.();
      const visibility = [];
      for (let parent = item.mesh; parent; parent = parent.parent) visibility.push({ name: parent.name || parent.type, visible: parent.visible });
      const direct = new T.Raycaster(voyage.camera.position.clone(), direction, 0, distance)
        .intersectObject(item.mesh, false)
        .slice(0, 3)
        .map(hit => ({ distance: hit.distance, point: hit.point.toArray(), faceIndex: hit.faceIndex ?? null }));
      const material = Array.isArray(item.mesh.material) ? item.mesh.material[0] : item.mesh.material;
      return {
        mesh: item.mesh.name,
        visible: item.mesh.visible,
        visibility,
        material: material ? { name: material.name, visible: material.visible, transparent: material.transparent, side: material.side } : null,
        morphTargets: Object.keys(item.mesh.geometry.morphAttributes ?? {}),
        bounds: box ? { min: box.min.toArray(), max: box.max.toArray() } : null,
        direct,
        surfaceDistance: typeof reveal.surfaceDistance === 'function'
          ? reveal.surfaceDistance(item.mesh, voyage.camera.position, direction, distance)
          : null,
      };
    }) : [];
    return { name, target: target.toArray(), distance, hits: hits.slice(0, 5), debug };
  }) : [];
  return {
    label,
    camera: {
      position: voyage.camera.position.toArray(),
      aim: voyage.aim.toArray(),
      fov: voyage.camera.fov,
      near: voyage.camera.near,
    },
    ray,
    localReveal: {
      blocked: voyage.reveal?.blocked ?? null,
      strength: voyage.reveal?.strength?.value ?? null,
      checkedAt: voyage.reveal?.checkedAt ?? null,
      candidateCount: voyage.reveal?.candidates?.length ?? null,
      hidden: voyage.reveal ? [...voyage.reveal.hidden.keys()].map(object => object.name || object.type) : [],
      window: voyage.reveal?.window?.value?.toArray?.() ?? null,
      depth: voyage.reveal?.depth?.value ?? null,
      samples: revealSamples,
      samplesFullyOccluded: revealSamples.length === revealTargets.length && revealSamples.every(sample => sample.hits.length > 0),
      candidateNames: reveal?.candidates?.filter(item => /AftFan|TimberSpars/.test(item.mesh.name || '')).map(item => item.mesh.name) ?? [],
    },
    sprite: {
      group: {
        name: doll.name,
        position: doll.position.toArray(),
        scale: doll.scale.toArray(),
        worldScale: doll.getWorldScale(new T.Vector3()).toArray(),
        quaternion: doll.quaternion.toArray(),
      },
      mesh: mesh ? {
        name: mesh.name || null,
        position: mesh.position.toArray(),
        scale: mesh.scale.toArray(),
        worldScale: mesh.getWorldScale(new T.Vector3()).toArray(),
        box: { min: meshBox.min.toArray(), max: meshBox.max.toArray(), size: meshBox.getSize(new T.Vector3()).toArray() },
        canvas: canvas ? [canvas.width, canvas.height] : null,
        texture: mapImage ? [mapImage.width ?? null, mapImage.height ?? null] : null,
        geometry: { positionCount: mesh.geometry.attributes.position.count, indexCount: mesh.geometry.index?.count ?? null },
      } : null,
      sourceBounds: privateDoll?.bounds ?? null,
      bodyCenter: privateDoll?.bodyCenter?.toArray?.() ?? null,
      headBottom: privateDoll?.headBottom ?? null,
      neckRows: privateDoll?.neckRows ?? null,
      worldBox: { min: box.min.toArray(), max: box.max.toArray(), size: box.getSize(new T.Vector3()).toArray() },
    },
  };
}, label);

const moveCarrierAndMeasure = page => page.evaluate(() => {
  const voyage = window.__entry.voyage;
  const T = window.__three;
  const deck = voyage.deck;
  const doll = voyage.passengers.root.getObjectByName('SV3_Passenger_preview-swap');
  if (!doll) throw new Error('selected preview passenger carrier is missing');
  const localFoot = deck.position.clone();
  const beforeFoot = voyage.ship.localToWorld(localFoot.clone());
  const beforeDoll = doll.getWorldPosition(new T.Vector3());
  const savedPosition = voyage.ship.position.clone();
  const shift = new T.Vector3(.37, .19, -.43);
  voyage.ship.position.add(shift);
  voyage.ship.updateWorldMatrix(true, true);
  const afterFoot = voyage.ship.localToWorld(localFoot.clone());
  const afterDoll = doll.getWorldPosition(new T.Vector3());
  const footDelta = afterFoot.clone().sub(beforeFoot);
  const dollDelta = afterDoll.clone().sub(beforeDoll);
  voyage.ship.position.copy(savedPosition);
  voyage.ship.updateWorldMatrix(true, true);
  return {
    localFoot: localFoot.toArray(),
    footDelta: footDelta.toArray(),
    dollDelta: dollDelta.toArray(),
    carrierError: afterFoot.distanceTo(afterDoll),
    deltaError: footDelta.distanceTo(dollDelta),
  };
});

const captureRoofCandidates = async (page, output, route) => {
  const roof = sampleRoute(route).find(sample => sample.label === 'roof-upper-platform');
  assert(roof, 'roof candidate experiment requires the authored upper-platform point');
  const candidates = [
    { id: 'baseline', yaw: 0, followYaw: 0, pitch: .24 },
    { id: 'side-right', yaw: Math.PI / 2, followYaw: 0, pitch: .24 },
    { id: 'side-left', yaw: -Math.PI / 2, followYaw: 0, pitch: .24 },
    { id: 'side-right-steep', yaw: Math.PI / 2, followYaw: 0, pitch: 1.08 },
    { id: 'side-left-steep', yaw: -Math.PI / 2, followYaw: 0, pitch: 1.08 },
    { id: 'front', yaw: Math.PI, followYaw: 0, pitch: .24 },
    { id: 'front-steep', yaw: Math.PI, followYaw: 0, pitch: 1.08 },
    { id: 'quarter-right', yaw: .55, followYaw: 0, pitch: .24 },
    { id: 'quarter-left', yaw: -.55, followYaw: 0, pitch: .24 },
    { id: 'baseline-far', yaw: 0, followYaw: 0, pitch: .24, zoom: 2 },
    { id: 'front-far', yaw: Math.PI, followYaw: 0, pitch: .24, zoom: 2 },
    { id: 'overhead', yaw: 0, followYaw: 0, pitch: 1.5 },
    { id: 'front-overhead', yaw: Math.PI, followYaw: 0, pitch: 1.5 },
    // Keep these positions relative to the real ship-local roof foot. They
    // intentionally bypass only the production follow-camera pitch clamp for
    // this read-only experiment; draw, passenger billboarding, and cloud
    // rendering still run with the actual scene/materials.
    { id: 'manual-low-aft-045', manualOffset: [0, 13.02, 23.4], manualAimOffset: [0, 1.65, 0], manualPitch: .45 },
    { id: 'manual-low-aft-060', manualOffset: [0, 16.42, 21.56], manualAimOffset: [0, 1.65, 0], manualPitch: .60 },
    { id: 'manual-foot-right', manualOffset: [18, 8, 0], manualAimOffset: [0, 1.65, 0] },
    { id: 'manual-foot-left', manualOffset: [-18, 8, 0], manualAimOffset: [0, 1.65, 0] },
    { id: 'manual-foot-front', manualOffset: [0, 8, -18], manualAimOffset: [0, 1.65, 0] },
    // The access route only samples the platform centre. Probe the two outer
    // x positions requested by the review against the real deck placer; a
    // rejection is recorded as evidence instead of changing the route.
    { id: 'alt-xp85-z65', point: [8.5, 15.25, 65], manualOffset: [18, 8, 0], manualAimOffset: [0, 1.65, 0] },
    { id: 'alt-xp85-z65-pitch034', point: [8.5, 15.25, 65], manualOffset: [17.9877590183, 8.0129337180, 0], manualAimOffset: [0, 1.65, 0], manualYaw: Math.PI / 2, manualPitch: .34, manualDistance: 19.08 },
    { id: 'alt-xm85-z65', point: [-8.5, 15.25, 65], manualOffset: [-18, 8, 0], manualAimOffset: [0, 1.65, 0] },
    { id: 'alt-xp85-z60', point: [8.5, 15.25, 60], manualOffset: [18, 8, 0], manualAimOffset: [0, 1.65, 0] },
    { id: 'alt-xm85-z60', point: [-8.5, 15.25, 60], manualOffset: [-18, 8, 0], manualAimOffset: [0, 1.65, 0] },
  ];
  const activeCandidates = process.env.MAPLE_ROOF_PITCH034_ONLY === '1'
    ? candidates.filter(candidate => candidate.id === 'alt-xp85-z65-pitch034')
    : process.env.MAPLE_ROOF_ALT_ONLY === '1'
      ? candidates.filter(candidate => candidate.id.startsWith('alt-') && candidate.id !== 'alt-xp85-z65-pitch034')
      : candidates;
  const evidence = [];
  try {
    for (const candidate of activeCandidates) {
      const placed = await page.evaluate(point => {
        const voyage = window.__entry.voyage;
        const ok = voyage.deck.place(voyage.deck.spawn.clone().fromArray(point));
        voyage.updateActivity();
        return { ok, position: voyage.deck.position.toArray() };
      }, candidate.point ?? roof.point);
      if (!placed.ok) {
        const freeStand = await page.evaluate(point => {
          const voyage = window.__entry.voyage;
          const T = window.__three;
          const deck = voyage.deck;
          const routeDistance = deck.routeDistance;
          const requested = new T.Vector3().fromArray(point);
          const supportY = typeof deck.ground === 'function'
            ? deck.ground(requested.x, requested.z, requested.y + .4, .8)
            : undefined;
          const canStand = Number.isFinite(supportY) && typeof deck.canStand === 'function'
            ? deck.canStand(requested, supportY)
            : false;
          if (canStand) {
            requested.y = supportY + .025;
            deck.position.copy(requested);
            voyage.updateActivity();
          }
          return {
            requested: point,
            supportY: Number.isFinite(supportY) ? supportY : null,
            canStand,
            position: deck.position.toArray(),
            routeDistanceBefore: routeDistance,
            routeDistanceAfter: deck.routeDistance,
          };
        }, candidate.point ?? roof.point);
        if (!freeStand.canStand) {
          evidence.push({ ...candidate, placed, freeStand, rejected: true });
          continue;
        }
        placed.freeStand = freeStand;
        placed.position = freeStand.position;
      }
      await page.evaluate(({ yaw, followYaw, pitch, zoom }) => {
        const voyage = window.__entry.voyage;
        voyage.yaw = yaw;
        voyage.followYaw = followYaw;
        voyage.pitch = pitch;
        voyage.zoom = zoom ?? 1.2;
        voyage.followEye = undefined;
        voyage.followAim = undefined;
        voyage.updateActivity();
      }, candidate);
      await renderProductionFrame(page);
      if (candidate.manualOffset) {
        await page.evaluate(({ manualOffset, manualAimOffset }) => {
          const voyage = window.__entry.voyage;
          const T = window.__three;
          // Stop the live rAF for the duration of the still capture. This is
          // restored by the normal production frame in the finally block.
          cancelAnimationFrame(voyage.frame);
          voyage.frame = 0;
          voyage.ship.updateWorldMatrix(true, true);
          const foot = voyage.ship.localToWorld(voyage.deck.position.clone());
          const camera = foot.clone().add(new T.Vector3(...manualOffset));
          const aim = foot.clone().add(new T.Vector3(...(manualAimOffset ?? [0, 1.65, 0])));
          voyage.camera.position.copy(camera);
          voyage.aim.copy(aim);
          voyage.camera.lookAt(aim);
          voyage.camera.updateMatrixWorld(true);
          voyage.passengers.update(0, false, voyage.ship, voyage.camera, performance.now());
          voyage.ship.updateWorldMatrix(true, true);
          voyage.camera.updateMatrixWorld(true);
          voyage.clouds.render(
            voyage.renderer,
            voyage.scene,
            voyage.camera,
            voyage.sun,
            voyage.cabinShown ? voyage.windowLight : undefined,
          );
        }, candidate);
      }
      const state = await page.evaluate(candidate => {
        const voyage = window.__entry.voyage;
        const doll = voyage.passengers.root.getObjectByName('SV3_Passenger_preview-swap');
        const box = new window.__three.Box3().setFromObject(doll);
        const center = box.getCenter(new window.__three.Vector3()).project(voyage.camera);
        return {
          camera: voyage.camera.position.toArray(),
          aim: voyage.aim.toArray(),
          yaw: voyage.yaw,
          followYaw: voyage.followYaw,
          pitch: voyage.pitch,
          distance: voyage.camera.position.distanceTo(voyage.aim),
          screenCenter: center.toArray(),
          spriteBox: { min: box.min.toArray(), max: box.max.toArray(), size: box.getSize(new window.__three.Vector3()).toArray() },
          cameraMode: candidate.manualOffset ? 'manual-foot-relative' : 'production-follow',
        };
      }, candidate);
      const screenshot = `roof-candidate-${candidate.id}.png`;
      await page.screenshot({ path: path.join(output, screenshot) });
      evidence.push({ ...candidate, placed, state, screenshot });
    }
  } finally {
    await page.evaluate(point => {
      const voyage = window.__entry.voyage;
      voyage.deck.place(voyage.deck.spawn.clone().fromArray(point));
      voyage.yaw = 0;
      voyage.followYaw = 0;
      voyage.pitch = .24;
      voyage.zoom = 1.2;
      voyage.followEye = undefined;
      voyage.followAim = undefined;
      voyage.updateActivity();
    }, await page.evaluate(() => window.__entry.voyage.deck.spawn.toArray()));
    await renderProductionFrame(page);
  }
  await fs.writeFile(path.join(output, 'roof-candidates.json'), JSON.stringify({
    mode: 'temporary real-browser camera candidates; production source unchanged',
    routePoint: roof.point,
    candidates: evidence,
  }, null, 2), 'utf8');
  return evidence;
};

const diagnoseRoofVertical = async (page, output) => {
  const result = await page.evaluate(() => {
    const voyage = window.__entry.voyage;
    const T = window.__three;
    const point = [5.5, 15.275, 65];
    const placed = voyage.deck.place(voyage.deck.spawn.clone().fromArray(point));
    voyage.updateActivity();
    voyage.ship.updateWorldMatrix(true, true);
    const foot = voyage.ship.localToWorld(voyage.deck.position.clone());
    const passengerRoot = voyage.passengers.root;
    const visible = object => {
      for (let parent = object; parent; parent = parent.parent) if (!parent.visible) return false;
      return true;
    };
    const meshes = [];
    voyage.ship.traverse(object => {
      if (!(object instanceof T.Mesh) || !visible(object)) return;
      for (let parent = object; parent; parent = parent.parent) if (parent === passengerRoot) return;
      meshes.push(object);
    });
    const record = hit => {
      const chain = [];
      for (let parent = hit.object; parent; parent = parent.parent) chain.push(parent.name || parent.type);
      const normal = hit.face?.normal?.clone();
      if (normal) normal.applyNormalMatrix(new T.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      const localPoint = voyage.ship.worldToLocal(hit.point.clone());
      return {
        distance: hit.distance,
        point: hit.point.toArray(),
        worldY: hit.point.y,
        shipLocalPoint: localPoint.toArray(),
        normal: normal?.toArray() ?? null,
        faceIndex: hit.faceIndex ?? null,
        object: hit.object.name || hit.object.type,
        parentChain: chain,
        userData: Object.fromEntries(Object.entries(hit.object.userData ?? {}).filter(([key]) => [
          'layer', 'lobby_walkable', 'walk_surface_source', 'walk_surface_height',
          'structural_repair_child', 'original_source', 'source', 'role', 'kind',
        ].includes(key))),
      };
    };
    const scan = (localPoint, far) => {
      const origin = voyage.ship.localToWorld(new T.Vector3(...localPoint));
      const ray = new T.Raycaster(origin, new T.Vector3(0, 1, 0), 0, far);
      const hits = ray.intersectObjects(meshes, false).filter(hit => hit.object !== passengerRoot);
      return { localOrigin: localPoint, worldOrigin: origin.toArray(), far, hits: hits.slice(0, 12).map(record) };
    };
    return {
      placed: Boolean(placed),
      deckPosition: voyage.deck.position.toArray(),
      foot: foot.toArray(),
      meshCount: meshes.length,
      scans: [
        scan([5.5, 15.275, 65], 4),
        scan([8.5, 15.25, 65], 4),
        scan([-8.5, 15.25, 65], 4),
        scan([5.5, 15.275, 65], 2),
      ],
    };
  });
  await fs.writeFile(path.join(output, 'roof-vertical-scan.json'), JSON.stringify({
    mode: 'temporary real-browser upward ray; visible ship meshes only; production source unchanged',
    ...result,
  }, null, 2), 'utf8');
  return result;
};

/**
 * Run after view.check.mjs has installed its in-memory routes and submitted
 * the fixture login. No server, account, or production source is touched.
 */
export async function checkVoyagePlatforms(page, output, errors) {
  await fs.mkdir(output, { recursive: true });
  await page.locator('.entry-stage-channel').waitFor({ state: 'attached', timeout: 15000 });

  const route = await page.evaluate(() => window.__entry.voyage.deck.route.map((point, index) => ({
    index,
    x: point.x,
    y: point.y,
    z: point.z,
  })));
  const samples = sampleRoute(route);
  const start = await page.evaluate(() => window.__entry.voyage.deck.position.toArray());
  const evidence = [];
  let roofRevealFailure;
  let failure;

  try {
    for (const sample of samples) {
      const placed = await page.evaluate(point => {
        const voyage = window.__entry.voyage;
        const ok = voyage.deck.place(voyage.deck.spawn.clone().fromArray(point));
        voyage.updateActivity();
        return { ok, position: voyage.deck.position.toArray() };
      }, sample.point);
      assert(placed.ok, sample.label + ': production deck.place rejected the real route point');

      await renderProductionFrame(page);
      const state = await frameState(page);
      const diagnosis = await diagnoseOcclusion(page, sample.label);
      assert(state.supported, sample.label + ': feet have no continuous floor support');
      assert(state.screenVisible, sample.label + ': passenger is outside the camera frame');
      assert.equal(state.nearEye, null, sample.label + ': camera is inside a nearby solid surface');
      assert(state.carrierError < .0001, sample.label + ': passenger foot carrier drifted from deck point');
      assert(state.deckCarrierError < .0001, sample.label + ': passenger deck carrier is stale');
      if (sample.label === 'roof-upper-platform' && diagnosis.localReveal.samplesFullyOccluded && diagnosis.localReveal.strength <= .9) {
        roofRevealFailure = `roof fully occluded four body samples but LocalReveal strength is only ${diagnosis.localReveal.strength}`;
      }

      const screenshot = 'platform-' + sample.label + '.png';
      await page.screenshot({ path: path.join(output, screenshot) });
      evidence.push({ ...sample, placed, state, diagnosis, screenshot });
    }

    const carrier = await moveCarrierAndMeasure(page);
    assert(carrier.carrierError < .0001, 'moving the ship root separates the passenger foot from its carrier');
    assert(carrier.deltaError < .0001, 'moving the ship root does not move the passenger foot with the carrier');
    evidence.push({ carrier });
    if (roofRevealFailure) assert.fail(roofRevealFailure);
  } catch (error) {
    failure = String(error?.stack ?? error);
    throw error;
  } finally {
    try {
      await page.evaluate(point => {
        const voyage = window.__entry.voyage;
        if (!voyage.deck.place(voyage.deck.spawn.clone().fromArray(point))) throw new Error('failed to restore the authored spawn');
        voyage.updateActivity();
      }, start);
      await renderProductionFrame(page);
    } catch (restoreError) {
      failure ??= String(restoreError?.stack ?? restoreError);
    }
    await fs.writeFile(
      path.join(output, 'platform-check.json'),
      JSON.stringify({
        passed: !failure && errors.length === 0,
        mode: 'offline production WebGL; in-memory login fixture; real deck.place/draw/cloud pass',
        route,
        evidence,
        errors,
        failure,
      }, null, 2),
      'utf8',
    );
  }

  if (failure) throw new Error(failure);
  assert.deepEqual(errors, []);
  if (process.env.MAPLE_ROOF_CANDIDATES === '1') {
    const candidates = await captureRoofCandidates(page, output, route);
    console.log('Roof camera candidates captured: ' + candidates.map(candidate => candidate.id).join(', '));
  }
  if (process.env.MAPLE_ROOF_DIAGNOSTICS === '1') {
    const vertical = await diagnoseRoofVertical(page, output);
    console.log('Roof upward ray scans: ' + vertical.scans.map(scan => scan.hits.length).join(', '));
  }
  console.log('Platform route checks passed: ' + samples.map(sample => sample.label).join(', '));
}
