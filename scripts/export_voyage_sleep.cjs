// Closed eyes from the same TMS273 face as each entry paper doll; retain origin/brow anchors.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const avatar = require('./export_tms273_avatar.cjs');
const root = path.resolve(__dirname, '..'), directory = path.join(root, 'resources/tms273-export');
async function main() {
  const appearance = JSON.parse(fs.readFileSync(path.join(directory, 'appearance.json'), 'utf8'));
  const faces = {};
  for (const key of Object.keys(appearance.layers).filter(key => key.startsWith('face:'))) {
    const id = key.slice(5), frame = await avatar.sourceFrame(`Character/Face/${id.padStart(8, '0')}.img/blink/1/face`);
    assert(frame.map?.brow && frame.origin && frame.width > 0, `closed face needs its brow anchor: ${id}`);
    faces[id] = frame;
  }
  fs.writeFileSync(path.join(directory, 'voyage-sleep.json'), JSON.stringify({ sourceVersion: 'TMS273.7', faces }) + '\n', 'utf8');
  console.log(`Exported ${Object.keys(faces).length} source closed-eye faces`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => avatar.reader.close());
