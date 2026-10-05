// Continuous keyboard traversal of the production fixed curves.  This check
// deliberately does not call deck.place for the milestones: every point is
// reached by held direction keys through the actual route projection,
// authored floor probes and body-clearance tests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const distanceXZ = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

const login = async page => {
  await page.locator('#username').fill('entry_check');
  await page.locator('#password').fill('entry-check-password');
  await page.locator('#submit').click();
  await page.locator('.entry-stage-channel').waitFor();
};

const routeState = page => page.evaluate(() => {
  const v = window.__entry.voyage;
  const deck = v.deck;
  const position = deck.position.toArray();
  const route = deck.route.map(point => point.toArray());
  const index = route.reduce((best, point, candidate) =>
    Math.hypot(point[0] - position[0], point[2] - position[2]) <
      Math.hypot(route[best][0] - position[0], route[best][2] - position[2]) ? candidate : best, 0);
  return { position, route, index, distance: deck.routeDistance, moving: deck.moving, activeMainDeck: deck === v.mainDeck, activeBowDeck: deck === v.bowDeck };
});

const openRouteKey = (page, deckProperty, targetIndex) => page.evaluate(({ property, target }) => {
  const v = window.__entry.voyage, deck = v[property];
  if (!deck) throw new Error(`missing ${property} for open-route probe`);
  const route = deck.route;
  const position = deck.position;
  const current = route.reduce((best, point, index) =>
    Math.hypot(point.x - position.x, point.z - position.z) < Math.hypot(route[best].x - position.x, route[best].z - position.z) ? index : best, 0);
  const wantedSign = target >= current ? 1 : -1;
  const total = route.slice(1).reduce((sum, point, index) => sum + point.distanceTo(route[index]), 0);
  const pointAt = distance => {
    let remaining = Math.max(0, Math.min(total, distance));
    for (let index = 1; index < route.length; index++) {
      const start = route[index - 1], end = route[index], size = start.distanceTo(end);
      if (remaining <= size || index === route.length - 1) return start.clone().lerp(end, size ? remaining / size : 0);
      remaining -= size;
    }
    return route.at(-1).clone();
  };
  const distances = [0];
  for (let index = 1; index < route.length; index++) distances[index] = distances[index - 1] + route[index - 1].distanceTo(route[index]);
  const probe = Math.min(.35, Math.max(.05, total / 100));
  const distance = distances[target];
  const tangent = pointAt(Math.max(0, Math.min(total, distance + wantedSign * probe)))
    .sub(pointAt(Math.max(0, Math.min(total, distance - wantedSign * probe))));
  tangent.y = 0; tangent.normalize();
  const inverse = v.ship.getWorldQuaternion(new window.__three.Quaternion()).invert();
  const forward = v.camera.getWorldDirection(new window.__three.Vector3()).applyQuaternion(inverse);
  forward.y = 0; forward.normalize();
  const right = forward.clone().cross(new window.__three.Vector3(0, 1, 0));
  const choices = [
    ['ArrowLeft', -1, 0], ['ArrowRight', 1, 0],
    ['ArrowUp', 0, -1], ['ArrowDown', 0, 1],
  ];
  const ranked = choices.map(([key, horizontal, vertical]) => ({
    key,
    dot: right.clone().multiplyScalar(horizontal).addScaledVector(forward, -vertical).normalize().dot(tangent),
  })).sort((a, b) => b.dot - a.dot);
  window.__openRouteChoice = { property, target, current, wantedSign, targetPoint: route[target].toArray(), tangent: tangent.toArray(), ranked };
  return ranked[0].key;
}, { property: deckProperty, target: targetIndex });

const assertExteriorRoute = state => {
  assert.equal(state.activeMainDeck, true, 'exterior loop uses the independent main deck');
  assert.equal(state.activeBowDeck, false, 'main-deck loop does not activate the bow deck');
  assert.equal(state.route.length, 6, 'exterior route is the six-point original main-deck loop');
  assert.deepEqual(state.route[0], state.route.at(-1), 'exterior route closes at the boarding node');
};

const chooseExteriorKey = (page, wantedSign) => page.evaluate(sign => {
  const v = window.__entry.voyage, d = v.deck;
  const slots = d.ringChoices(v.camera, v.ship).map(slot => ({ index: slot.index, direction: slot.direction, sign: slot.sign }));
  const selected = slots.find(slot => slot.sign === sign) ?? slots[0];
  if (!selected) throw new Error(`outer route has no projected direction slot: ${JSON.stringify({ sign, slots, position: d.position.toArray(), routeDistance: d.routeDistance })}`);
  const key = ({ up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' })[selected.direction];
  window.__outerDirectionChoice = { requestedSign: sign, selected, slots, position: d.position.toArray(), routeDistance: d.routeDistance };
  return { ...window.__outerDirectionChoice, key };
}, wantedSign);

const chooseCabinKey = page => page.evaluate(() => {
  const v = window.__entry.voyage;
  const deck = v.cabinDeck;
  const route = deck.route;
  const target = window.__routeTarget;
  const position = deck.position;
  const current = route.reduce((best, point, index) => Math.hypot(point.x - position.x, point.z - position.z) < Math.hypot(route[best].x - position.x, route[best].z - position.z) ? index : best, 0);
  const wantedSign = target >= current ? 1 : -1;
  const total = route.slice(1).reduce((sum, point, index) => sum + point.distanceTo(route[index]), 0);
  const currentDistance = deck.routeDistance;
  const probe = Math.min(.35, Math.max(.05, total / 100));
  const pointAt = distance => {
    let remaining = Math.max(0, Math.min(total, distance));
    for (let index = 1; index < route.length; index++) {
      const start = route[index - 1], end = route[index], size = start.distanceTo(end);
      if (remaining <= size || index === route.length - 1) return start.clone().lerp(end, size ? remaining / size : 0);
      remaining -= size;
    }
    return route.at(-1).clone();
  };
  const tangent = pointAt(Math.max(0, Math.min(total, currentDistance + wantedSign * probe)))
    .sub(pointAt(Math.max(0, Math.min(total, currentDistance - wantedSign * probe))));
  tangent.y = 0; tangent.normalize();
  const inverse = v.ship.getWorldQuaternion(new window.__three.Quaternion()).invert();
  const forward = v.camera.getWorldDirection(new window.__three.Vector3()).applyQuaternion(inverse);
  forward.y = 0; forward.normalize();
  const right = forward.clone().cross(new window.__three.Vector3(0, 1, 0));
  const choices = [
    ['ArrowLeft', -1, 0], ['ArrowRight', 1, 0],
    ['ArrowUp', 0, -1], ['ArrowDown', 0, 1],
  ];
  const ranked = choices.map(([key, horizontal, vertical]) => ({
    key,
    dot: right.clone().multiplyScalar(horizontal).addScaledVector(forward, -vertical).normalize().dot(tangent),
  })).sort((a, b) => b.dot - a.dot);
  window.__routeChoice = { target, current, wantedSign, position: position.toArray(), targetPoint: route[target].toArray(), forward: forward.toArray(), right: right.toArray(), tangent: tangent.toArray(), ranked };
  return ranked[0].key;
});

// Hold one keyboard direction for an entire monotonic arc.  Milestones only
// pause the deck's update method while the key remains down, so the route
// cursor, tangent sign and collision checks are exercised continuously by the
// real WebGL update loop rather than by repeatedly selecting a new segment.
const walkCabinArc = async (page, target, directionLabel, milestones, evidence, output) => {
  await page.evaluate(targetIndex => { window.__routeTarget = targetIndex; }, target);
  const key = await chooseCabinKey(page);
  await page.evaluate(inputKey => { window.__routeKey = inputKey; }, key);
  const expectedSign = await page.evaluate(() => window.__routeChoice.wantedSign);
  const targetDistance = await page.evaluate(targetIndex => {
    const route = window.__entry.voyage.cabinDeck.route;
    return route.slice(1, targetIndex + 1).reduce((sum, point, index) => sum + point.distanceTo(route[index]), 0);
  }, target);
  const waitAtTarget = async (targetIndex, label, capture) => {
    const targetTolerance = targetIndex === target ? .2 : 1.1;
    const routeTolerance = targetIndex === target ? .25 : 1.15;
    const distance = await page.evaluate(index => {
      const route = window.__entry.voyage.cabinDeck.route;
      return route.slice(1, index + 1).reduce((sum, point, cursor) => sum + point.distanceTo(route[cursor]), 0);
    }, targetIndex);
    try {
      await page.waitForFunction(({ index, targetDistance: wanted, sign, targetTolerance: tolerance, routeTolerance: distanceTolerance }) => {
        const d = window.__entry.voyage.cabinDeck;
        const point = d.route[index];
        const position = d.position;
        const reached = Math.hypot(position.x - point.x, position.z - point.z) < tolerance && Math.abs(position.y - point.y) < .65;
        const passed = sign > 0 ? d.routeDistance >= wanted - distanceTolerance : d.routeDistance <= wanted + distanceTolerance;
        return reached && passed && d.routeSign === sign;
      }, { index: targetIndex, targetDistance: distance, sign: expectedSign, targetTolerance, routeTolerance }, { timeout: 45000 });
    } catch (error) {
      console.log(`Cabin route milestone diagnostic ${label}:`, await page.evaluate(({ index, wanted, sign, tolerance, distanceTolerance }) => {
        const v = window.__entry.voyage, d = v.cabinDeck, point = d.route[index];
        return {
          targetIndex: index,
          target: point?.toArray(),
          position: d.position.toArray(),
          routeSign: d.routeSign,
          expectedSign: sign,
          routeDistance: d.routeDistance,
          targetDistance: wanted,
          targetTolerance: tolerance,
          routeTolerance: distanceTolerance,
          moving: d.moving,
          keys: [...v.keys ?? []],
        };
      }, { index: targetIndex, wanted: distance, sign: expectedSign, tolerance: targetTolerance, distanceTolerance: routeTolerance }));
      throw error;
    }
    const state = await page.evaluate(({ index, labelName, arc, arcSign }) => {
      const v = window.__entry.voyage, d = v.cabinDeck, targetPoint = d.route[index];
      return {
        label: labelName,
        arc,
        key: window.__routeKey,
        routeSign: d.routeSign,
        expectedSign: arcSign,
        routeDistance: d.routeDistance,
        position: d.position.toArray(),
        target: targetPoint.toArray(),
        distance: Math.hypot(d.position.x - targetPoint.x, d.position.z - targetPoint.z),
        heightError: Math.abs(d.position.y - targetPoint.y),
        supported: d.ground(d.position.x, d.position.z, d.position.y + .45, 1.4) !== undefined,
        cabinExteriorMode: Boolean(v.cabinExteriorMode),
      };
    }, { index: targetIndex, labelName: label, arc: directionLabel, arcSign: expectedSign });
    assert(state.routeSign === expectedSign, `${label}: route sign changed during held ${key} arc`);
    assert(state.distance < targetTolerance && state.heightError < .65 && state.supported, `${label}: held ${key} input did not reach a supported route point ${JSON.stringify(state)}`);
    if (!capture) return state;

    // Freeze only the movement update for the screenshot. The browser key is
    // intentionally still held, and the original update function is restored
    // before the next milestone on the same arc.
    await page.evaluate(() => {
      const d = window.__entry.voyage.cabinDeck;
      window.__savedCabinUpdate = d.update;
      d.update = () => {};
    });
    try {
      await page.evaluate(() => {
        const v = window.__entry.voyage;
        v.clouds.render = window.__routeCloudRender;
        if (v.reveal && window.__routeRevealUpdate) {
          v.reveal.update = window.__routeRevealUpdate;
          v.reveal.setPaused = window.__routeRevealSetPaused;
        }
        if (window.__routePassengersUpdate) v.passengers.update = window.__routePassengersUpdate;
        v.updateActivity();
      });
      await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(output, `${label}.png`) });
      evidence.push(state);
    } finally {
      await page.evaluate(() => {
        const v = window.__entry.voyage, d = v.cabinDeck;
        if (window.__savedCabinUpdate) d.update = window.__savedCabinUpdate;
        delete window.__savedCabinUpdate;
        v.clouds.render = () => {};
        if (v.reveal) {
          v.reveal.update = () => false;
          v.reveal.setPaused = () => {};
        }
        v.passengers.update = () => {};
        v.updateActivity();
      });
    }
    return state;
  };

  await page.keyboard.down(key);
  try {
    for (const [targetIndex, label] of milestones) await waitAtTarget(targetIndex, label, true);
    // Preparation arcs intentionally have no milestones; the actual evidence
    // arcs above/below are the continuous movement acceptance paths.
    if (!milestones.length) await waitAtTarget(target, `${directionLabel}-end`, false);
  } finally {
    await page.keyboard.up(key);
  }
  return { key, expectedSign, targetDistance };
};

export async function checkVoyageRoute(page, output, errors) {
  await login(page);
  await page.waitForTimeout(450);
  // Keep the authored GLB, WebGL scene and collision probes live during the
  // long held-key traversal, while suspending only the expensive volumetric
  // cloud composite in software WebGL. Captures briefly restore it below.
  await page.evaluate(() => {
    const v = window.__entry.voyage;
    v.renderer.setPixelRatio(.5);
    v.resize();
    window.__routeCloudRender = v.clouds.render.bind(v.clouds);
    window.__routeRevealUpdate = v.reveal?.update?.bind(v.reveal);
    window.__routeRevealSetPaused = v.reveal?.setPaused?.bind(v.reveal);
    window.__routePassengersUpdate = v.passengers.update.bind(v.passengers);
    v.clouds.render = () => {};
    if (v.reveal) {
      v.reveal.update = () => false;
      v.reveal.setPaused = () => {};
    }
    v.passengers.update = () => {};
    v.updateActivity();
  });

  const cabinOnly = process.argv.includes('--cabin-only');
  let exteriorStart, exteriorForward, exteriorReverse;
  if (!cabinOnly) {
  exteriorStart = await routeState(page);
  assertExteriorRoute(exteriorStart);
  await page.evaluate(() => {
    const v = window.__entry.voyage, d = v.deck;
    window.__moveTrace = [];
    const update = d.update.bind(d);
    d.update = (...args) => {
      const before = d.position.toArray();
      update(...args);
      window.__moveTrace.push({ t: performance.now(), keys: [...v.keys ?? []], before, after: d.position.toArray(), moving: d.moving, frame: v.frame, previous: v.previous, hidden: v.host?.hidden, documentHidden: document.hidden, busy: v.host?.getAttribute('aria-busy') });
    };
    const cabinUpdate = v.cabinDeck.update.bind(v.cabinDeck);
    window.__cabinTrace = [];
    v.cabinDeck.update = (...args) => {
      const before = v.cabinDeck.position.toArray();
      cabinUpdate(...args);
      window.__cabinTrace.push({ t: performance.now(), keys: [...v.keys ?? []], before, after: v.cabinDeck.position.toArray(), moving: v.cabinDeck.moving, frame: v.frame, previous: v.previous });
    };
  });
  const forwardChoice = await chooseExteriorKey(page, 1);
  console.log('Exterior forward direction slots:', JSON.stringify(forwardChoice));
  await page.keyboard.down(forwardChoice.key);
  try {
    await page.waitForFunction(() => {
      const v = window.__entry.voyage, deck = v.deck, p = deck.position;
      const route = deck.route;
      const index = route.reduce((best, point, candidate) => Math.hypot(point.x - p.x, point.z - p.z) < Math.hypot(route[best].x - p.x, route[best].z - p.z) ? candidate : best, 0);
      (window.__outerVisited ??= []).push(index);
      return new Set(window.__outerVisited).size >= route.length - 1;
    }, undefined, { timeout: 180000 });
  } catch (error) {
    console.log('Outer route diagnostic:', await page.evaluate(() => {
      const d = window.__entry.voyage.deck;
      const samples = [];
      for (let z = 12; z <= 22; z += .25) {
        const height = d.ground(6.5, z, 6, 1.4);
        samples.push({ z, height: height ?? null, stand: height === undefined ? false : d.canStand(new window.__three.Vector3(6.5, height, z), height) });
      }
      const lane = [6.5, 6.8, 7.1, 7.4, 7.7, 8.0].map(x => {
        const height = d.ground(x, 12.75, 6, 1.4);
        const next = height === undefined ? null : new window.__three.Vector3(x, height, 12.75);
        return { x, height: height ?? null, stand: next ? d.canStand(next, height) : false, step: next ? d.tryFreeStep(next) : false };
      });
      return { position: d.position.toArray(), distance: d.routeDistance, moving: d.moving, keys: [...window.__entry.voyage.keys ?? []], routeSign: d.routeSign, directionChoice: window.__outerDirectionChoice, projectedSlots: d.ringChoices(window.__entry.voyage.camera, window.__entry.voyage.ship), visited: window.__outerVisited, samples, lane, trace: window.__moveTrace?.slice(-40) };
    }));
    throw error;
  } finally {
    await page.keyboard.up(forwardChoice.key);
  }
  exteriorForward = await routeState(page);
  assertExteriorRoute(exteriorForward);
  assert(Math.abs(exteriorForward.distance - exteriorStart.distance) > 20, 'held input crosses the outer route rather than stalling at the spawn node');

  const reverseStartDistance = exteriorForward.distance;
  await page.evaluate(() => { window.__outerVisitedReverse = []; });
  const reverseChoice = await chooseExteriorKey(page, -forwardChoice.selected.sign);
  console.log('Exterior reverse direction slots:', JSON.stringify(reverseChoice));
  await page.keyboard.down(reverseChoice.key);
  try {
    await page.waitForFunction(() => {
      const d = window.__entry.voyage.deck, p = d.position, route = d.route;
      const index = route.reduce((best, point, candidate) => Math.hypot(point.x - p.x, point.z - p.z) < Math.hypot(route[best].x - p.x, route[best].z - p.z) ? candidate : best, 0);
      (window.__outerVisitedReverse ??= []).push(index);
      return new Set(window.__outerVisitedReverse).size >= route.length - 1;
    }, undefined, { timeout: 180000 });
  } catch (error) {
    console.log('Reverse route diagnostic:', await page.evaluate(() => {
      const d = window.__entry.voyage.deck;
      return { position: d.position.toArray(), distance: d.routeDistance, moving: d.moving, routeSign: d.routeSign, directionChoice: window.__outerDirectionChoice, projectedSlots: d.ringChoices(window.__entry.voyage.camera, window.__entry.voyage.ship), visited: window.__outerVisitedReverse?.slice(-40), trace: window.__moveTrace?.slice(-10) };
    }));
    throw error;
  } finally {
    await page.keyboard.up(reverseChoice.key);
  }
  exteriorReverse = await routeState(page);
  assertExteriorRoute(exteriorReverse);
  assert(exteriorReverse.position[1] >= 5.4, 'reverse perimeter traversal keeps the character on an authored deck height');
  assert(Math.abs(exteriorReverse.distance - reverseStartDistance) > 20, 'opposite input traverses the same outer curve in reverse');
  if (process.argv.includes('--exterior-only')) {
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'exterior-result.json'), JSON.stringify({ passed: true, exteriorStart, exteriorForward, exteriorReverse, forwardChoice, reverseChoice, errors }, null, 2));
    console.log('PASS continuous exterior perimeter and bidirectional held-key route');
    return;
  }
  }

  await page.evaluate(() => window.__entry.go('characters'));
  await page.waitForFunction(() => window.__entry.voyage.cabinShown && !window.__entry.voyage.transition);
  await page.waitForTimeout(450);
  console.log('Cabin route setup:', await page.evaluate(() => {
    const d = window.__entry.voyage.cabinDeck;
    return { position: d.position.toArray(), spawn: d.spawn.toArray(), route: d.route.map(p => p.toArray()), routeDistance: d.routeDistance };
  }));
  const cabinStart = await page.evaluate(() => ({
    route: window.__entry.voyage.cabinDeck.route.map(point => point.toArray()),
    position: window.__entry.voyage.cabinDeck.position.toArray(),
    spawn: window.__entry.voyage.cabinDeck.spawn.toArray(),
    bedCount: Array.from({ length: 12 }, (_, i) => window.__entry.voyage.model.getObjectByName(`SV2_Bed_${i}_FootAnchor`)).filter(Boolean).length,
    windowCount: Array.from({ length: 4 }, (_, i) => window.__entry.voyage.model.getObjectByName(`SV2_CabinFrontWindow_0${i + 1}`)).filter(Boolean).length,
  }));
  assert.equal(cabinStart.route.length, 14, 'cabin route has 09, twelve bed-line points, and 17 only');
  assert.deepEqual([cabinStart.bedCount, cabinStart.windowCount], [12, 4], 'selection cabin keeps twelve beds and four windows');

  // VoyageDeck builds the open route as [09, twelve bed-line points, 17].
  // Derive these indices from the live bed count while rejecting any returned
  // door, slope, landing, or external corridor segment.
  const cabinIndices = {
    stern09: 0,
    bedStart: 1,
    bedEnd: cabinStart.bedCount,
    deck17: cabinStart.bedCount + 1,
  };
  assert.equal(cabinIndices.deck17, cabinStart.route.length - 1, 'cabin route ends at the original side-wall opening 17');
  const nearPoint = (actual, expected, label, tolerance = .12) => {
    assert.equal(actual.length, expected.length, `${label} has three coordinates`);
    assert(actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance), `${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  };
  nearPoint(cabinStart.spawn, [5.4, .05, 40], 'cabin center spawn');
  nearPoint(cabinStart.route[cabinIndices.stern09], [5.4, .05, 53.1], '09 stern opening');
  nearPoint(cabinStart.route[cabinIndices.deck17], [5.4, .05, 26.9], '17 deck opening');

  const cabinFeatures = await page.evaluate(() => {
    const model = window.__entry.voyage.model;
    const names = [
      'SV2_CabinSideWalls', 'SV3_WindowWallRestored_Base',
      'SV3_WindowWallRestored_Crown', 'SV3_WindowWallRestored_EndPier',
      'SV3_RouteAnchor_09', 'SV3_RouteAnchor_17', 'SV3_RouteAnchor_18',
      'SV3_CabinToDeckLanding', 'SV3_BowCabinPortal',
      'SV3_BowPlatform_Deck', 'SV3_BowPlatform_Rails',
    ];
    const present = Object.fromEntries(names.map(name => [name, Boolean(model.getObjectByName(name))]));
    const legacy = [];
    model.traverse(node => {
      if (/^(Legacy_|SV2_CabinAftWalk|SV3_CabinPierDetail_|SV3_Repaired_SternRoofDeck|SV3_GlassWall_(Base|Crown|Pier_End)|SV3_MainDeck_Surface|SV3_Route_CabinAisle_02|SV3_Route_SternRoom_09|SV3_Route_(DoorLanding_17|Slope_15|DeckLanding_16)|SV3_CabinDoor17_)/.test(node.name ?? '')) legacy.push(node.name);
    });
    return { present, legacy };
  });
  assert(Object.values(cabinFeatures.present).every(Boolean), `cabin openings and restored window wall are present: ${JSON.stringify(cabinFeatures.present)}`);
  assert.equal(cabinFeatures.legacy.length, 0, `retired corridor/slope/platform objects are absent: ${cabinFeatures.legacy.join(',')}`);

  // Regression for the selected preview avatar lifecycle.  The three passes
  // deliberately use existing fixture roles and a real held key: after each
  // A→B→A selection, wait through the wake gate, walk to an interior knot,
  // and prove that the doll texture commits more than one actual walk frame.
  const roleWalkRegression = [];
  await page.evaluate(() => {
    const v = window.__entry.voyage;
    // Let the production passenger clock drive wake completion while this
    // regression runs. The route case normally suspends this visual update
    // during long collision traversals, but a synthetic finishWake() here
    // would hide a switch-to-walk lifecycle regression.
    if (window.__routePassengersUpdate) v.passengers.update = window.__routePassengersUpdate;
    window.__roleFrameTrace = [];
    if (!window.__roleFrameCaptureInstalled) {
      const original = v.setPassengerFrame.bind(v);
      v.setPassengerFrame = (id, parts, bounds) => {
        if (id === 'preview-swap' || id === 'passenger-0') window.__roleFrameTrace.push({ id, action: v.passengerAction(id), urls: parts.map(part => part.url), at: performance.now() });
        return original(id, parts, bounds);
      };
      window.__roleFrameCaptureInstalled = true;
    }
  });
  for (const [passengerId, targetIndex] of [['preview-swap', 1], ['passenger-0', 7], ['preview-swap', 1]]) {
    await page.evaluate(id => {
      const v = window.__entry.voyage;
      v.onCharacter?.(id);
      v.closeRoleDetails();
      v.updateActivity();
    }, passengerId);
    await page.waitForFunction(id => {
      const v = window.__entry.voyage;
      return v.stage === 'characters' && window.__entry.selected === id && !v.passengers.waking;
    }, passengerId, { timeout: 15000 });
    const before = await page.evaluate(id => {
      const v = window.__entry.voyage, d = v.cabinDeck, doll = v.passengers.dolls?.get(id);
      return { id, position: d.position.toArray(), routeDistance: d.routeDistance, textureVersion: doll?.texture?.version ?? 0, action: v.passengerAction(id) };
    }, passengerId);
    await page.evaluate(index => { window.__routeTarget = index; }, targetIndex);
    const key = await chooseCabinKey(page);
    await page.keyboard.down(key);
    try {
      await page.waitForFunction(({ id, startDistance }) => {
        const v = window.__entry.voyage, d = v.cabinDeck;
        return v.passengerAction(id) === 'walk' && d.moving && Math.abs(d.routeDistance - startDistance) > .08;
      }, { id: passengerId, startDistance: before.routeDistance }, { timeout: 15000 });
      await page.waitForTimeout(1200);
    } finally {
      await page.keyboard.up(key);
    }
    await page.waitForTimeout(120);
    const after = await page.evaluate(id => {
      const v = window.__entry.voyage, d = v.cabinDeck, doll = v.passengers.dolls?.get(id);
      const frames = (window.__roleFrameTrace ?? []).filter(item => item.id === id && item.action === 'walk');
      return {
        id, position: d.position.toArray(), routeDistance: d.routeDistance,
        textureVersion: doll?.texture?.version ?? 0, action: v.passengerAction(id),
        frames: frames.length, uniqueWalkFrames: new Set(frames.map(item => item.urls.join('|'))).size,
      };
    }, passengerId);
    const moved = Math.abs(after.routeDistance - before.routeDistance);
    assert(moved > .3, `${passengerId}: held walk did not move the cabin route ${JSON.stringify({ before, after, key })}`);
    assert(after.textureVersion > before.textureVersion, `${passengerId}: walk did not commit a new doll texture ${JSON.stringify({ before, after, key })}`);
    assert(after.frames >= 2 && after.uniqueWalkFrames >= 2, `${passengerId}: walk texture did not cycle through real frames ${JSON.stringify({ before, after, key })}`);
    roleWalkRegression.push({ before, after, key, moved });
  }
  await page.evaluate(() => {
    const v = window.__entry.voyage;
    v.passengers.update = () => {};
    v.updateActivity();
  });

  if (process.argv.includes('--cabin-probe')) {
    const probe = await page.evaluate(indices => {
      const d = window.__entry.voyage.cabinDeck;
      const distances = [0];
      for (let index = 1; index < d.route.length; index++) {
        distances[index] = distances[index - 1] + d.route[index - 1].distanceTo(d.route[index]);
      }
      const saved = { position: d.position.clone(), routeDistance: d.routeDistance, routeSign: d.routeSign };
      const runRange = (fromIndex, toIndex) => {
        const startDistance = distances[fromIndex], endDistance = distances[toIndex];
        const checks = [];
        // .05m probes cover both cut end walls and every bed-line seam. The
        // route checker never calls place() or moves the live player to a
        // milestone; it only evaluates the authored one-step collision data.
        for (let distance = startDistance; distance < endDistance - 1e-6;) {
          const nextDistance = Math.min(endDistance, distance + .05);
          const current = d.openRoutePoint(distance), next = d.openRoutePoint(nextDistance);
          d.position.copy(current); d.routeDistance = distance;
          checks.push({ offset: distance - startDistance, distance, nextDistance, detail: d.debugStep(next) });
          if (nextDistance >= endDistance - 1e-6) break;
          distance = nextDistance;
        }
        return { fromIndex, toIndex, startDistance, segmentLength: endDistance - startDistance, checks };
      };
      try {
        const summarize = segment => ({
          ...segment,
          failed: segment.checks.filter(item => !item.detail.step || item.detail.supports.some(support => !support.ok) || item.detail.horizontalHits.length > 0),
          maxHeightJump: Math.max(...segment.checks.map(item => item.detail.heightDelta ?? 0), 0),
          maxSupportDelta: Math.max(...segment.checks.flatMap(item => item.detail.supports.map(support => support.delta ?? Infinity)), 0),
          maxHorizontalHits: Math.max(...segment.checks.map(item => item.detail.horizontalHits.length), 0),
        });
        return { bedLine: summarize(runRange(indices.stern09, indices.deck17)) };
      } finally {
        d.position.copy(saved.position); d.routeDistance = saved.routeDistance; d.routeSign = saved.routeSign;
      }
    }, cabinIndices);
    const bedLine = probe.bedLine;
    assert.equal(bedLine.failed.length, 0, `bed-line end-wall probes have failed support checks: ${JSON.stringify(bedLine.failed[0])}`);
    assert(bedLine.maxHeightJump <= .45, `bed-line has a height jump above the step limit: ${bedLine.maxHeightJump}`);
    assert(bedLine.maxSupportDelta <= .25, `bed-line has a support delta above the canStand limit: ${bedLine.maxSupportDelta}`);
    assert.equal(bedLine.maxHorizontalHits, 0, `bed-line intersects a physical blocker: ${JSON.stringify(bedLine.failed[0])}`);
    await fs.writeFile(path.join(output, 'cabin-probe.json'), JSON.stringify({ passed: true, probe, cabinFeatures }, null, 2));
    console.log('Cabin bed-line dense probe:', JSON.stringify({ passed: true, fromIndex: bedLine.fromIndex, toIndex: bedLine.toIndex, samples: bedLine.checks.length, maxHeightJump: bedLine.maxHeightJump, maxSupportDelta: bedLine.maxSupportDelta, maxHorizontalHits: bedLine.maxHorizontalHits }));
    return;
  }

  const setCabinHandoff = async (enabled) => page.evaluate(allow => {
    const v = window.__entry.voyage;
    if (!Object.prototype.hasOwnProperty.call(window, '__savedCabinOnDeck')) window.__savedCabinOnDeck = v.onDeck;
    v.onDeck = allow ? window.__savedCabinOnDeck : undefined;
    window.__cabinHandoffEnabled = allow;
  }, enabled);

  const resetCabin = async () => {
    // EntryView.go() intentionally does not reset when the requested stage is
    // already active. Bounce through the channel stage so the normal
    // go('characters') path resets the authored cabin spawn.
    await page.evaluate(() => window.__entry.go('channel'));
    await page.evaluate(() => window.__entry.go('characters'));
    await page.waitForFunction(() => {
      const v = window.__entry.voyage;
      return v.stage === 'characters' && v.cabinShown && !v.transition &&
        Math.abs(v.cabinDeck.position.x - 5.4) < .1 &&
        Math.abs(v.cabinDeck.position.z - 40) < .1;
    }, undefined, { timeout: 30000 });
    await page.waitForTimeout(120);
  };

  const cabinEvidence = [];
  let handoff;
  // Pure route evidence must reach both openings while the stage remains the
  // character cabin. The callback is restored in finally before the real
  // 17→original-deck handoff below.
  await setCabinHandoff(false);
  try {
    await walkCabinArc(page, cabinIndices.stern09, 'reverse-from-center-to-09', [], cabinEvidence, output);
    await walkCabinArc(page, cabinIndices.deck17, 'forward-09-to-17', [
      [cabinIndices.bedStart, 'cabin-bed-line-start'],
      [cabinIndices.bedEnd, 'cabin-bed-line-end'],
      [cabinIndices.deck17, 'cabin-17-side-opening-sealed-window'],
    ], cabinEvidence, output);
    await walkCabinArc(page, cabinIndices.stern09, 'reverse-17-to-09', [
      [cabinIndices.bedEnd, 'cabin-reverse-bed-line-end'],
      [cabinIndices.bedStart, 'cabin-reverse-bed-line-start'],
      [cabinIndices.stern09, 'cabin-reverse-09-opening'],
    ], cabinEvidence, output);
    const stern = await page.evaluate(() => {
      const v = window.__entry.voyage, d = v.cabinDeck;
      return { stage: v.stage, cabinExteriorMode: Boolean(v.cabinExteriorMode), position: d.position.toArray(), routeDistance: d.routeDistance };
    });
    assert.equal(stern.stage, 'characters', 'stern opening stays in the character stage during pure route traversal');
    assert.equal(stern.cabinExteriorMode, true, '09 stern opening restores the outdoor presentation while staying in characters');
  } finally {
    await setCabinHandoff(true);
  }

  // Reset through the normal EntryView path, then hold one real direction
  // through every bed point with the original callback restored. The runtime
  // callback itself must perform the stage transfer; no place() shortcut is
  // allowed for this acceptance path.
  await resetCabin();
  const handoffTarget = cabinIndices.deck17;
  await page.evaluate(targetIndex => { window.__routeTarget = targetIndex; }, handoffTarget);
  const handoffKey = await chooseCabinKey(page);
  const handoffSign = await page.evaluate(() => window.__routeChoice.wantedSign);
  await page.keyboard.down(handoffKey);
  try {
    await page.waitForFunction(() => {
      const v = window.__entry.voyage, d = v.deck;
      const marker = v.model.getObjectByName('SV3_CabinToDeckLanding');
      const landing = marker && v.ship.worldToLocal(marker.getWorldPosition(new window.__three.Vector3())).toArray();
      return v.stage === 'channel' &&
        d === v.bowDeck &&
        Math.hypot(d.position.x - 0, d.position.z + 42.4) < .3 &&
        Math.abs(d.position.y - 6.8) < .65 &&
        Array.isArray(landing) && landing.length === 3 &&
        Math.hypot(landing[0] - 0, landing[2] + 42.4) < .3 && Math.abs(landing[1] - 6.8) < .65;
    }, undefined, { timeout: 45000 });
  } catch (error) {
    console.log('Cabin 17 automatic handoff diagnostic:', await page.evaluate(() => {
      const v = window.__entry.voyage, cabin = v.cabinDeck, deck = v.deck;
      return {
        stage: v.stage,
        transition: Boolean(v.transition),
        onDeckEnabled: window.__cabinHandoffEnabled,
        key: window.__routeKey,
        handoffKey: window.__routeChoice,
        cabinPosition: cabin?.position.toArray(),
        cabinRouteDistance: cabin?.routeDistance,
        cabinRouteSign: cabin?.routeSign,
        deckPosition: deck?.position.toArray(),
        deckRouteDistance: deck?.routeDistance,
        keys: [...v.keys ?? []],
      };
    }));
    throw error;
  } finally {
    await page.keyboard.up(handoffKey);
  }
  await page.waitForTimeout(120);
  handoff = await page.evaluate(({ key, sign }) => {
    const v = window.__entry.voyage, d = v.deck;
    const marker = v.model.getObjectByName('SV3_CabinToDeckLanding');
    const sourceLanding = marker && v.ship.worldToLocal(marker.getWorldPosition(new window.__three.Vector3())).toArray();
    return {
      key, expectedSign: sign, stage: v.stage,
      activeBowDeck: d === v.bowDeck,
      position: d.position.toArray(), target: [0, 6.8, -42.4],
      distance: Math.hypot(d.position.x, d.position.z + 42.4),
      heightError: Math.abs(d.position.y - 6.8),
      sourceLanding,
      sourceLandingDistance: Array.isArray(sourceLanding) ? Math.hypot(sourceLanding[0], sourceLanding[2] + 42.4) : Infinity,
      sourceLandingHeightError: Array.isArray(sourceLanding) ? Math.abs(sourceLanding[1] - 6.8) : Infinity,
      moving: d.moving,
      cabinPosition: v.cabinDeck.position.toArray(),
    };
  }, { key: handoffKey, sign: handoffSign });
  assert.equal(handoff.stage, 'channel', `17 handoff enters channel: ${JSON.stringify(handoff)}`);
  assert.equal(handoff.activeBowDeck, true, `17 handoff activates the independent bow deck: ${JSON.stringify(handoff)}`);
  assert(handoff.distance < .3 && handoff.heightError < .65, `17 handoff lands at the bow slope lower end: ${JSON.stringify(handoff)}`);
  assert(handoff.sourceLandingDistance < .3 && handoff.sourceLandingHeightError < .65, `17 handoff records the bow source landing: ${JSON.stringify(handoff)}`);

  const bowStart = await page.evaluate(() => {
    const v = window.__entry.voyage, d = v.bowDeck;
    return {
      active: v.deck === d,
      position: d.position.toArray(),
      spawn: d.spawn.toArray(),
      route: d.route.map(point => point.toArray()),
      routeDistance: d.routeDistance,
    };
  });
  assert.equal(bowStart.active, true, `bow deck remains the active channel deck: ${JSON.stringify(bowStart)}`);
  assert.equal(bowStart.route.length, 4, 'bow route has lower slope, raised platform, and narrow tip knots');
  nearPoint(bowStart.position, [0, 6.8, -42.4], 'bow route transfer spawn', .35);
  nearPoint(bowStart.spawn, [0, 6.8, -42.4], 'bow route authored spawn', .35);
  nearPoint(bowStart.route[0], [0, 6.8, -42.4], 'bow route lower slope', .35);
  nearPoint(bowStart.route[1], [0, 7.65, -48], 'bow route raised platform entry', .35);
  nearPoint(bowStart.route[2], [0, 7.65, -62], 'bow route narrow platform', .35);
  nearPoint(bowStart.route[3], [0, 7.65, -69], 'bow route railing endpoint', .35);

  const bowEvidence = [];
  const walkBowArc = async (target, label) => {
    const key = await openRouteKey(page, 'bowDeck', target);
    const choice = await page.evaluate(() => window.__openRouteChoice);
    const targetDistance = await page.evaluate(targetIndex => {
      const route = window.__entry.voyage.bowDeck.route;
      return route.slice(1, targetIndex + 1).reduce((sum, point, index) => sum + point.distanceTo(route[index]), 0);
    }, target);
    const targetPoint = await page.evaluate(targetIndex => window.__entry.voyage.bowDeck.route[targetIndex].toArray(), target);
    await page.keyboard.down(key);
    try {
      await page.waitForFunction(({ targetIndex, wanted, sign, targetPoint: expected }) => {
        const v = window.__entry.voyage, d = v.bowDeck, p = d.position;
        return v.stage === 'channel' && v.deck === d && d.routeSign === sign &&
          Math.hypot(p.x - expected[0], p.z - expected[2]) < .65 &&
          Math.abs(p.y - expected[1]) < .65 &&
          (sign > 0 ? d.routeDistance >= wanted - .75 : d.routeDistance <= wanted + .75);
      }, { targetIndex: target, wanted: targetDistance, sign: choice.wantedSign, targetPoint }, { timeout: 90000 });
    } catch (error) {
      console.log(`Bow route diagnostic ${label}:`, await page.evaluate(({ targetIndex, wanted, sign }) => {
        const v = window.__entry.voyage, d = v.bowDeck;
        return {
          targetIndex, target: d.route[targetIndex]?.toArray(), position: d.position.toArray(),
          routeSign: d.routeSign, expectedSign: sign, routeDistance: d.routeDistance,
          targetDistance: wanted, moving: d.moving, active: v.deck === d, stage: v.stage,
          keys: [...v.keys ?? []], choice: window.__openRouteChoice,
        };
      }, { targetIndex: target, wanted: targetDistance, sign: choice.wantedSign }));
      throw error;
    } finally {
      await page.keyboard.up(key);
    }
    const state = await page.evaluate(({ targetIndex, labelName, expectedSign }) => {
      const v = window.__entry.voyage, d = v.bowDeck, targetPoint = d.route[targetIndex];
      return {
        label: labelName, key: window.__openRouteChoice?.ranked?.[0]?.key,
        stage: v.stage, active: v.deck === d, routeSign: d.routeSign,
        expectedSign, routeDistance: d.routeDistance, position: d.position.toArray(),
        target: targetPoint.toArray(), distance: Math.hypot(d.position.x - targetPoint.x, d.position.z - targetPoint.z),
        heightError: Math.abs(d.position.y - targetPoint.y), moving: d.moving,
      };
    }, { targetIndex: target, labelName: label, expectedSign: choice.wantedSign });
    assert.equal(state.stage, 'channel', `${label}: bow traversal stays in channel`);
    assert.equal(state.active, true, `${label}: bow traversal never switches to the main deck`);
    assert(state.distance < .65 && state.heightError < .65, `${label}: held input did not reach the bow knot ${JSON.stringify(state)}`);
    bowEvidence.push(state);
    return state;
  };
  const bowForward = await walkBowArc(3, 'bow-slope-platform-railing-forward');
  const bowReverse = await walkBowArc(0, 'bow-railing-platform-slope-reverse');
  assert(Math.abs(bowForward.routeDistance - bowStart.routeDistance) > 20, 'held input traverses the complete independent bow route');
  assert(Math.abs(bowReverse.routeDistance - bowForward.routeDistance) > 20, 'opposite input traverses the independent bow route in reverse');

  const final = await page.evaluate(({ states, cabinStartState, featureState, handoffState }) => {
    const v = window.__entry.voyage;
    return {
      exteriorStart: states.exteriorStart,
      exteriorForward: states.exteriorForward,
      exteriorReverse: states.exteriorReverse,
      cabinStart: cabinStartState,
      cabinFeatures: featureState,
      cabinEnd: v.cabinDeck.position.toArray(),
      handoff: handoffState,
      bow: {
        active: v.deck === v.bowDeck,
        position: v.bowDeck.position.toArray(),
        route: v.bowDeck.route.map(point => point.toArray()),
      },
      retiredRouteObjects: ['SV3_MainDeck_Surface', 'SV3_Route_CabinAisle_02', 'SV3_Route_SternRoom_09', 'SV3_Route_DoorLanding_17', 'SV3_Route_Slope_15', 'SV3_Route_DeckLanding_16'].map(name => Boolean(v.model.getObjectByName(name))),
    };
  }, { states: { exteriorStart, exteriorForward, exteriorReverse }, cabinStartState: cabinStart, featureState: cabinFeatures, handoffState: handoff });
  final.bowEvidence = bowEvidence;
  final.roleWalkRegression = roleWalkRegression;
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'route-result.json'), JSON.stringify({ passed: true, final, cabinEvidence, errors }, null, 2));
  console.log('PASS continuous exterior perimeter and bidirectional 09→bed line→17 cabin route with automatic bow-slope handoff');

}
