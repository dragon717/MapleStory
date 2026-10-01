// Exercise the actual production Phaser initialization without logging in or touching saved characters.
// Run client npm run dev, then node scripts/check_game_renderer.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'client/node_modules/typescript'));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const source = ts.createSourceFile('main.ts', fs.readFileSync(path.join(root, 'client/src/app/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
let call;
function visit(node) {
  if (ts.isNewExpression(node) && node.expression.getText(source) === 'Phaser.Game') {
    assert(!call, 'Each production Game constructor needs its own initialization check');
    call = node;
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert(call, 'Production Game constructor missing');
let block = call.parent;
while (!ts.isBlock(block)) block = block.parent;
const setup = block.statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(d => ['canvas', 'context'].includes(d.name.getText(source))));
assert.equal(setup.length, 2, 'Exercise production canvas/context creation too');
const code = ts.transpileModule(`function create(Phaser, world, el) { ${setup.map(s => s.getText(source)).join('\n')} return ${call.getText(source)}; }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
(async () => {
  const browser = await chromium.launch({headless:false, executablePath:process.env.PLAYWRIGHT_EXECUTABLE || path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), args:['--use-angle=metal']});
  try {
    const page = await browser.newPage({viewport:{width:800,height:600}});
    await page.goto(process.env.MAPLE_RENDER_URL || 'http://127.0.0.1:5173/');
    const result = await page.evaluate(async code => {
      const Phaser = await import('/node_modules/phaser/dist/phaser.esm.js');
      const existing = document.getElementById('game'); existing?.remove();
      const host = document.createElement('div'); host.id = 'game'; host.style.cssText = 'width:640px;height:480px'; document.body.append(host);
      const scene = new Phaser.Scene('renderer-check');
      let ready;
      const boot = new Promise(resolve => { ready = resolve; });
      scene.create = () => ready();
      const create = new Function(`${code}; return create;`)();
      const game = create(Phaser, scene, () => host);
      await Promise.race([boot,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`Production renderer did not boot: ${JSON.stringify({booted:game.isBooted,running:game.isRunning,scenes:game.scene.scenes.map(s=>s.sys.settings.status)})}`)),10000))]);
      const result = {webgl:game.renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer,webgl2:game.renderer.gl instanceof WebGL2RenderingContext,active:scene.sys.isActive(),contextAlive:!game.renderer.gl.isContextLost()};
      game.destroy(true); host.remove(); return result;
    }, code);
    assert.deepEqual(result,{webgl:true,webgl2:true,active:true,contextAlive:true});
    console.log('PASS: actual production canvas/context/Game config boots WebGL2 and an active scene.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
