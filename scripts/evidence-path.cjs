const path = require('node:path');
// New runs write dated evidence; historical indexes continue pointing at old runs.
function evidencePath(task) {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  return path.resolve(__dirname, '..', 'evidence', day, task);
}
module.exports = { evidencePath };
