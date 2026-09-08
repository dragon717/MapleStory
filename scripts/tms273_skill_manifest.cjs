// Project source exports into the small client-facing skill view contract.
// This does not grant skills or infer the still-unverified SP group mapping.
const assert = require('node:assert/strict');
const { evaluate } = require('./tms273_skill_formulas.cjs');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENGLISH_UNITS = new Set(['MP', 'HP']);
const BEGINNER_LEVEL_FIELDS = new Set(['mpCon', 'fixdamage', 'x', 'time', 'speed', 'cooltime']);

function scalarFields(common) {
  return Object.keys(common ?? {})
    .filter(field => IDENTIFIER.test(field))
    .filter(field => typeof common[field] === 'string'
      || typeof common[field] === 'number')
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function levelFieldValue(common, field, level) {
  const source = common[field];
  const value = typeof source === 'string' ? evaluate(source, level) : source;
  assert(Number.isFinite(value), `non-finite description value: ${field} at level ${level}`);
  return value;
}

function renderLevelDescription(template, common, level) {
  const fields = scalarFields(common);
  return template.replace(/#([A-Za-z_][A-Za-z0-9_]*)/g, (marker, token) => {
    const field = fields.find(candidate => token === candidate
      || (token.startsWith(candidate) && ENGLISH_UNITS.has(token.slice(candidate.length))));
    if (!field) return marker;
    return `${levelFieldValue(common, field, level)}${token.slice(field.length)}`;
  });
}

function levelDescriptions(entry, maxLevel) {
  const template = entry.string?.h;
  if (template !== undefined && template !== null) {
    assert(typeof template === 'string', `invalid description template: ${entry.id}`);
    return Array.from({ length: maxLevel }, (_, index) => renderLevelDescription(template, entry.common, index + 1));
  }
  // Skill/000.img's three beginner skills already provide one source-backed
  // String row per level (h1/h2/h3). Keep the wording verbatim; these rows
  // describe fixed damage/healing/speed values and must not be interpreted as
  // the mage four-field levelValues schema.
  const explicit = Array.from({ length: maxLevel }, (_, index) => entry.string?.[`h${index + 1}`]);
  if (explicit.some(value => value !== undefined && value !== null)) {
    assert(explicit.every(value => typeof value === 'string'), `incomplete level descriptions: ${entry.id}`);
    return explicit;
  }
  return undefined;
}

function skillManifest(windowExport, skillExport) {
  assert.equal(windowExport.sourceVersion, 'TMS273.7');
  assert.equal(skillExport.sourceVersion, 'TMS273.7');
  assert(skillExport.catalog, 'skill catalog export is missing');
  const skillBooks = {};
  for (const [id, book] of Object.entries(skillExport.catalog.books)) {
    assert(['0', '200', '220', '221', '222'].includes(id), `unmapped skill book: ${id}`);
    const tabIndex = { '0': 0, '200': 1, '220': 2, '221': 3, '222': 4 }[id];
    skillBooks[id] = { name: book.name, tabIndex };
  }
  const skillCatalog = {};
  for (const [id, entry] of Object.entries(skillExport.catalog.skills)) {
    assert(skillBooks[entry.book], `unknown book for ${id}`);
    const maxLevel = Number(entry.maxLevel);
    assert(Number.isSafeInteger(maxLevel) && maxLevel > 0 && maxLevel <= 100, `invalid maxLevel: ${id}`);
    const prerequisites = {};
    for (const [requiredId, rawLevel] of Object.entries(entry.req ?? {})) {
      const level = Number(rawLevel);
      assert(/^\d+$/.test(requiredId) && Number.isSafeInteger(level) && level > 0, `invalid prerequisite: ${id}`);
      prerequisites[requiredId] = level;
    }
    const hyper = Number(entry.sourceFields?.hyper ?? 0);
    const requiredLevel = Number(entry.sourceFields?.reqLev ?? 0);
    assert([0, 1, 2].includes(hyper), `unknown Hyper pool: ${id}`);
    assert(Number.isSafeInteger(requiredLevel) && requiredLevel >= 0 && requiredLevel <= 200, `invalid skill level gate: ${id}`);
    assert(!hyper || (entry.book === '222' && maxLevel === 1 && requiredLevel >= 140), `invalid Hyper source: ${id}`);
    const invisible = entry.displayFlags.source.invisible;
    assert(invisible === null || ['0', '1'].includes(String(invisible)), `unknown invisible flag: ${id}`);
    const descriptions = levelDescriptions(entry, maxLevel);
    skillCatalog[id] = {
      id, bookId: entry.book, name: entry.name, description: entry.description ?? '',
      maxLevel, prerequisites, hidden: Number(invisible) === 1,
      hyper, requiredLevel,
      icons: Object.fromEntries(Object.entries(entry.icons).filter(([, frame]) => frame !== null)),
      ...(descriptions ? { levelDescriptions: descriptions } : {}),
      ...(skillExport.skills[id]?.levelValues ? { levelValues: skillExport.skills[id].levelValues } : {}),
    };
  }
  return { skillWindow: windowExport.window, skillBooks, skillCatalog };
}

function mageRules(skillExport) {
  assert.equal(skillExport.sourceVersion, 'TMS273.7');
  const skills = {};
  for (const entry of Object.values(skillExport.catalog.skills).filter(entry => ['0', '200', '220', '221', '222'].includes(entry.book))) {
    const maxLevel = Number(entry.maxLevel);
    assert(Number.isSafeInteger(maxLevel) && maxLevel > 0 && maxLevel <= 100);
    const levels = entry.book === '0'
      ? Array.from({ length: maxLevel }, (_, i) => {
        const row = entry.sourceFields?.level?.[String(i + 1)];
        assert(row && typeof row === 'object', `missing beginner level row ${entry.id}/${i + 1}`);
        return Object.fromEntries(Object.entries(row)
          .filter(([key]) => BEGINNER_LEVEL_FIELDS.has(key))
          .map(([key, value]) => {
          if (value && typeof value === 'object') return [key, value];
          if (typeof value === 'number') return [key, value];
          if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return [key, Number(value)];
          return [key, value];
        }));
      })
      : Array.from({ length: maxLevel }, (_, i) => Object.fromEntries(
        Object.entries(entry.common).filter(([key]) => key !== 'maxLevel').map(([key, value]) => {
          if (typeof value === 'object') return [key, value];
          const result = typeof value === 'number' ? value : evaluate(value, i + 1);
          assert(Number.isFinite(result), `invalid mage field ${entry.id}/${key}`);
          return [key, result];
        }),
      ));
    skills[entry.id] = { name: entry.name, bookId: Number(entry.book), maxLevel,
      elemAttr: entry.sourceFields?.elemAttr ?? null,
      fixedLevel: Number(entry.displayFlags.source.fixLevel) === 1,
      boosterActionSpeed: entry.displayFlags.source.psdWeaponBooster?.actionSpeed === undefined ? null : Number(entry.displayFlags.source.psdWeaponBooster.actionSpeed),
      prerequisites: Object.fromEntries(
      Object.entries(entry.req ?? {}).map(([id, level]) => [id, Number(level)])),
      hidden: Number(entry.displayFlags.source.invisible) === 1, levels,
      hyper: Number(entry.sourceFields?.hyper ?? 0),
      requiredLevel: Number(entry.sourceFields?.reqLev ?? 0),
      source: entry.source?.skillImage ?? `Skill/${entry.book}.img/skill/${entry.id}`,
      rawCommon: entry.common,
      rawLevels: entry.sourceFields?.level ?? null,
      // Preserve source-only fields such as summon.attack1.info, changeSkill,
      // cooldown and hidden variant markers for the runtime owner.  This is
      // metadata, not an execution decision or an SP grant.
      sourceMetadata: entry.sourceFields ?? {},
    };
  }
  assert.equal(Object.keys(skills).length, 56);
  return { sourceVersion: 'TMS273.7', bookId: 200, skills };
}

module.exports = { skillManifest, mageRules };
