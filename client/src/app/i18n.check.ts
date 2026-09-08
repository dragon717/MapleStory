export {};
function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}`);
}
Object.defineProperty(globalThis, 'window', { value: { location: { search: '' }, localStorage: { getItem: () => null } } });
const { resolveLocale, displayText, mapText } = await import('./i18n.ts');
equal(resolveLocale(), 'zh');
equal(resolveLocale('en-US', 'zh'), 'en');
equal(resolveLocale('zh-CN', 'en'), 'zh');
equal(resolveLocale(null, 'en'), 'en');
equal(resolveLocale('invalid', 'invalid'), 'zh');
equal(displayText('楓葉山丘，裝備與任務'), '枫叶山丘，装备与任务');
equal(mapText('000010000', '楓葉山丘'), '枫叶山丘');
equal(displayText('Sword 1302000'), 'Sword 1302000');
console.log('Default Simplified Chinese, saved language and source text conversion passed.');
