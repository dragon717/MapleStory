const assert = require('node:assert/strict');

// Validate the same choices that character creation persists, before publishing.
module.exports = function checkCreationCatalog(creation, items, label) {
  const slots = { coat: ['Ma', 'MaPn'], pants: ['Pn'], shoes: ['So'], weapon: ['Wp', 'WpSi', 'WpSp'] };
  for (const gender of creation.genders) for (const [part, allowed] of Object.entries(slots)) {
    for (const id of gender[part]) {
      if (id === 0) continue; // No pants when the selected outfit is a longcoat.
      const item = items[id];
      assert(item, `${label}: missing creation equipment ${id} (${part})`);
      assert.equal(item.inventoryType, 1, `${label}: creation equipment ${id} inventoryType`);
      assert(allowed.includes(item.info?.islot), `${label}: creation equipment ${id} slot mismatch (${part})`);
    }
  }
};
