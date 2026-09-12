// Which portals get a visible effect?  One rule, shared by the assembler that
// writes `manifest.portals` and the runtime check that guards it.
//
// `Map.wz/MapHelper.img/portal` ships two namespaces in TMS273.7:
//   portal/game/{pv,ph,psh,ps}      everything the *client* draws in a map
//   portal/editor/<code>            map-editor markers, one per portal type
// Verified against the shipped WZ (`客户端/TMS273.7/Data`): `editor` holds all
// 19 type codes and its art is diagnostic (editor/pc = green square outline,
// editor/sp = yellow arrow, editor/ps = wooden frame, editor/ph = cyan oval),
// while `game` holds exactly the four families above.
//
// The client resolves a portal's in-game sprite as
// `portal/game/<code(pt)>/<image|default>` and has no fallback, so a type whose
// code is not one of pv/ph/psh/ps draws nothing at all.  Type 3 (Collision) is
// the case that matters here: its code is `pc`, which exists only under
// `editor`, so collision gates are invisible in game and merely marked in the
// map editor.  Type 7 (Script) is the one special case — the client forces it
// onto the visible `pv` art, which is why scripted doorways (楓之港 `east00` →
// 碼頭 …) must stay beamed.
//
// Cross-checked against two independent client reimplementations that encode
// the same resolution order:
//   WzComparerR2 MapRender  `MapData.cs::PreloadResource` — `switch (pt) { case
//     7: typeName = PortalTypes[2]; default: PortalTypes[pt]; }` then
//     `game/{typeName}/{image||default}` with no fallback on a missing node.
//   PharaohStory            `gameplay/maplemap/Portal.lua` — only 2/7 (pv) and
//     10 (ph) get animations in game; type 3 gets one in editor mode only.
//
// KEEP THIS THE ONLY PLACE THAT DECIDES.  The shared `pv/default` beam is added
// by `assemble_tms273.cjs` for exactly the gates this module approves, and
// `check_tms273_runtime.cjs` fails if a beam shows up on any other type (the
// 2026-09-13 bug: 六條岔道's rope-top pair `top00`/`top01`, both `pt: 3`, drew
// two stacked beams on the tree trunk).
const PORTAL_TYPE_CODES = Object.freeze({
  0: 'sp', 1: 'pi', 2: 'pv', 3: 'pc', 4: 'pg', 5: 'pgi', 6: 'tp',
  7: 'ps', 8: 'psi', 9: 'pcs', 10: 'ph', 11: 'psh', 12: 'pcj',
});

// Portal types the client draws with the shared `pv` beam.
const BEAM_TYPES = new Set([2, 7]);

function portalTypeCode(pt) {
  return PORTAL_TYPE_CODES[pt] ?? `pt${pt}`;
}

/**
 * `'pv'` when the client renders this portal type with the visible-portal beam,
 * otherwise `null`.  A `null` result means "no beam in this build": either the
 * client draws that type with a different family (ph/psh proximity effects, not
 * implemented) or it draws nothing at all (collision, invisible, script-hidden,
 * town anchors).
 */
function beamSpriteForType(pt) {
  return BEAM_TYPES.has(pt) ? 'pv' : null;
}

module.exports = { PORTAL_TYPE_CODES, BEAM_TYPES, portalTypeCode, beamSpriteForType };
