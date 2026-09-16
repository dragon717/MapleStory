export {};
function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}`);
}
Object.defineProperty(globalThis, 'window', { value: { location: { search: '' }, localStorage: { getItem: () => null } } });
const { resolveLocale, displayText, mapText, protocolText, hasProtocolError, menuEntryText } = await import('./i18n.ts');
equal(resolveLocale(), 'zh');
equal(resolveLocale('en-US', 'zh'), 'en');
equal(resolveLocale('zh-CN', 'en'), 'zh');
equal(resolveLocale(null, 'en'), 'en');
equal(resolveLocale('invalid', 'invalid'), 'zh');
equal(displayText('楓葉山丘，裝備與任務'), '枫叶山丘，装备与任务');
equal(mapText('000010000', '楓葉山丘'), '枫叶山丘');
equal(displayText('Sword 1302000'), 'Sword 1302000');

// T04：高频操作被拒时玩家看到的是人话，不是服务端英文诊断。`invalid_state`
// 故意没有通用条目 —— 它的原因由各调用点自带（"死亡角色不能加点。"），一条通用
// 文案会把这些原因抹平，所以这里断言它**不**在表里，其余高频码必须在。
for (const code of ['attack_while_climbing', 'attack_while_dead', 'attack_while_channeling', 'cooldown', 'reactor_spent', 'map_unavailable']) {
  if (!hasProtocolError(code)) throw new Error(`${code} 缺少中文文案`);
  if (protocolText(code, 'fallback') === 'fallback') throw new Error(`${code} 的文案为空`);
}
if (hasProtocolError('invalid_state')) throw new Error('invalid_state 不该有通用文案：原因由各调用点自带');
if (protocolText('invalid_state', '死亡角色不能加点。') !== '死亡角色不能加点。') {
  throw new Error('没有文案时必须回退到服务端给出的中文原因');
}
// 旧菜单可见改名：源按钮上写的是 怪物收藏，本构建复用这个入口开冒险笔记窗口，
// 所以可见名称由本地化层决定。没登记过的入口必须原样返回源标签 —— 改名不能
// 退化成「运行时按中文模糊匹配」。
equal(menuEntryText('menu/buttonInfo/3/6', '怪物收藏'), '冒險筆記（圖鑑）');
equal(displayText(menuEntryText('menu/buttonInfo/3/6', '怪物收藏')), '冒险笔记（图鉴）');
equal(menuEntryText('menu/buttonInfo/3/1', '任務'), '任務');
equal(displayText(menuEntryText('menu/buttonInfo/3/1', '任務')), '任务');
console.log('Default Simplified Chinese, saved language and source text conversion passed.');
