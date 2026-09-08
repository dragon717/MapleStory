// Project source exports into the small client-facing skill view contract.
// This does not grant skills or infer the still-unverified SP group mapping.
const assert = require('node:assert/strict');
const { evaluate } = require('./tms273_skill_formulas.cjs');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENGLISH_UNITS = new Set(['MP', 'HP']);

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
  if (template === undefined || template === null) return undefined;
  assert(typeof template === 'string', `invalid description template: ${entry.id}`);
  return Array.from({ length: maxLevel }, (_, index) => renderLevelDescription(template, entry.common, index + 1));
}

function skillManifest(windowExport, skillExport) {
  assert.equal(windowExport.sourceVersion, 'TMS273.7');
  assert.equal(skillExport.sourceVersion, 'TMS273.7');
  assert(skillExport.catalog, 'skill catalog export is missing');
  const skillBooks = {};
  for (const [id, book] of Object.entries(skillExport.catalog.books)) {
    assert(['200', '220'].includes(id), `unmapped skill book: ${id}`);
    skillBooks[id] = { name: book.name, tabIndex: id === '200' ? 1 : 2 };
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
    const invisible = entry.displayFlags.source.invisible;
    assert(invisible === null || ['0', '1'].includes(String(invisible)), `unknown invisible flag: ${id}`);
    const descriptions = levelDescriptions(entry, maxLevel);
    skillCatalog[id] = {
      id, bookId: entry.book, name: entry.name, description: entry.description ?? '',
      maxLevel, prerequisites, hidden: Number(invisible) === 1,
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
  for (const entry of Object.values(skillExport.catalog.skills).filter(entry => ['200', '220'].includes(entry.book))) {
    const maxLevel = Number(entry.maxLevel);
    assert(Number.isSafeInteger(maxLevel) && maxLevel > 0 && maxLevel <= 100);
    const levels = Array.from({ length: maxLevel }, (_, i) => Object.fromEntries(
      Object.entries(entry.common).filter(([key]) => key !== 'maxLevel').map(([key, value]) => {
        if (typeof value === 'object') return [key, value];
        const result = typeof value === 'number' ? value : evaluate(value, i + 1);
        assert(Number.isFinite(result), `invalid mage field ${entry.id}/${key}`);
        return [key, result];
      }),
    ));
    skills[entry.id] = { name: entry.name, bookId: Number(entry.book), maxLevel,
      fixedLevel: Number(entry.displayFlags.source.fixLevel) === 1,
      boosterActionSpeed: entry.displayFlags.source.psdWeaponBooster?.actionSpeed === undefined ? null : Number(entry.displayFlags.source.psdWeaponBooster.actionSpeed),
      prerequisites: Object.fromEntries(
      Object.entries(entry.req ?? {}).map(([id, level]) => [id, Number(level)])),
      hidden: Number(entry.displayFlags.source.invisible) === 1, levels,
      source: `Skill/${entry.book}.img/skill/${entry.id}`, rawCommon: entry.common };
  }
  assert.equal(Object.keys(skills).length, 17);
  return { sourceVersion: 'TMS273.7', bookId: 200, skills };
}

module.exports = { skillManifest, mageRules };
