const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publish } = require('./publish-package.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maple-package-'));
const read = slot => fs.readFileSync(path.join(root, `build/${slot}/packages/resources/data.zip`), 'utf8');
try {
  for (const version of ['one', 'two', 'three']) {
    const candidate = path.join(root, 'build/tmp/candidate');
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(candidate, 'data.zip'), version);
    publish(root, 'resources', candidate);
  }
  assert.equal(read('current'), 'three');
  assert.equal(read('previous'), 'two');
  const empty = path.join(root, 'build/tmp/empty');
  fs.mkdirSync(empty);
  assert.throws(() => publish(root, 'resources', empty), /Missing ZIP/);
  assert.equal(read('current'), 'three');
  assert.equal(read('previous'), 'two');
  assert(!fs.existsSync(path.join(root, 'build/tmp/retired-resources')));
  console.log('PASS package rotation: newest two, invalid candidate preserves both');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
