// Publish a validated package without overwriting the last successful copy.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function publishUnlocked(root, kind, candidate) {
  assert(['windows', 'resources'].includes(kind), 'Unknown package kind');
  const current = path.join(root, 'build/current/packages', kind);
  const previous = path.join(root, 'build/previous/packages', kind);
  const retired = path.join(root, 'build/tmp', `retired-${kind}`);
  const relative = path.relative(path.join(root, 'build/tmp'), path.resolve(candidate));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Candidate must be inside build/tmp');
  assert(fs.lstatSync(candidate).isDirectory(), 'Missing candidate directory');
  assert(fs.readdirSync(candidate).some(n => n.endsWith('.zip')), 'Missing ZIP');
  // Never discard an interrupted publication's recovery copy automatically.
  assert(!fs.existsSync(retired), `Recover interrupted package publication: ${retired}`);
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  let movedPrevious = false;
  let movedCurrent = false;
  try {
    if (fs.existsSync(previous)) { fs.renameSync(previous, retired); movedPrevious = true; }
    if (fs.existsSync(current)) { fs.renameSync(current, previous); movedCurrent = true; }
    fs.renameSync(candidate, current);
  } catch (error) {
    if (movedCurrent) fs.renameSync(previous, current);
    if (movedPrevious) fs.renameSync(retired, previous);
    throw error;
  }
  fs.rmSync(retired, { recursive: true, force: true });
  return current;
}

function publish(root, kind, candidate) {
  assert(['windows', 'resources'].includes(kind), 'Unknown package kind');
  const lock = path.join(root, 'build', `.package-${kind}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const fd = fs.openSync(lock, 'wx', 0o600);
  try { return publishUnlocked(root, kind, candidate); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

module.exports = { publish };
if (require.main === module) {
  const [kind, candidate] = process.argv.slice(2);
  console.log(publish(path.resolve(__dirname, '..'), kind, path.resolve(candidate)));
}
