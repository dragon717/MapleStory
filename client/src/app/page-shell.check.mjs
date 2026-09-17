#!/usr/bin/env node
// page-shell.check.mjs — 页面 shell 的 DOM stub 检查（计划 §10.3）。
// 钉扎：模板关键 DOM ID、语言切换（localStorage + URL lang）、新闻弹窗
// 开关与回调、setPlayLayout 的 game-mode 与信息区块搬移、弹窗复位。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// i18n 在模块顶层读取 window.location，stub 必须先于模块装载。
globalThis.window = { location: { search: '?lang=zh', href: 'http://localhost:3010/?lang=zh', assign: () => {} } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const i18nCode = ts.transpileModule(await readFile(new URL('./i18n.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace("import OpenCC from 'opencc-js/t2cn';", 'const OpenCC = { Converter: () => text => text };');
globalThis.__RELEASE_VERSION__ = '9.9.9-check';
globalThis.__RELEASE_TIME__ = '2026-09-12';
// 页面身份（v3 §8）：dev（serve）＝DEV_SOURCE，构建＝BUILT_PACKAGE。
// 构建产物页的发布徽章带构建时间，源码开发页不带（配置求值时间不是「最后一次
// 成功应用源码的时间」），所以这里按构建产物一侧钉住。
globalThis.__CODE_MODE__ = 'BUILT_PACKAGE';
const shellCode = ts.transpileModule(await readFile(new URL('./page-shell.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replaceAll("from './i18n'", `from 'data:text/javascript;base64,${Buffer.from(i18nCode).toString('base64')}'`);
const { PageShell } = await import(`data:text/javascript;base64,${Buffer.from(shellCode).toString('base64')}`);

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.hidden = false;
    this.value = '';
    this.open = false;
    this.listeners = new Map();
    this.onclick = null;
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: (...names) => { for (const name of names) this.classes.delete(name); },
      toggle: (name, force) => {
        const want = force === undefined ? !this.classes.has(name) : force;
        if (want) this.classes.add(name); else this.classes.delete(name);
        return want;
      },
      contains: name => this.classes.has(name),
    };
    this.dataset = {};
    this.textContent = '';
    this.innerHTMLValue = '';
  }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  before(node) { this.beforeNodes = [...(this.beforeNodes ?? []), node]; }
  after(node) { this.afterNodes = [...(this.afterNodes ?? []), node]; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type) { for (const fn of this.listeners.get(type) ?? []) fn(); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  querySelector() { return new FakeNode(); }
  set innerHTML(value) { this.innerHTMLValue = value; }
  get innerHTML() { return this.innerHTMLValue; }
}

const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, new FakeNode(id === 'maple-news' ? 'dialog' : 'div'));
  return elements.get(id);
};
const app = new FakeNode();
const header = new FakeNode('header');
const footer = new FakeNode('footer');
const body = new FakeNode('body');
const storage = new Map();
const assignments = [];
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
globalThis.window = { location: { search: '?lang=zh', href: 'http://localhost:3010/?lang=zh', assign: url => assignments.push(url) } };
globalThis.document = {
  documentElement: {},
  title: '',
  body,
  getElementById: id => element(id),
  querySelector: selector => (selector === '#app > header' ? header : selector === '#app > footer' ? footer : null),
  createComment: text => {
    const marker = { comment: text, calls: 0, before() {}, after() { marker.calls += 1; } };
    return marker;
  },
  addEventListener() {},
  removeEventListener() {},
};
element('language').value = 'en';
element('maple-news').open = false;

const events = { show: 0, closed: 0 };
const shell = new PageShell(app, {
  onShowNews: () => { events.show += 1; },
  onNewsClosed: () => { events.closed += 1; },
});

// 模板：关键 DOM ID 与双语结构注入 app。
assert.ok(app.innerHTML.includes('id="connection"'), '连接状态区');
assert.ok(app.innerHTML.includes('id="game"'), '游戏画布宿主');
assert.ok(app.innerHTML.includes('id="ui-windows"'), '窗口层');
assert.ok(app.innerHTML.includes('id="maple-news"'), '新闻弹窗');
assert.ok(app.innerHTML.includes('9.9.9-check'), '发布徽章带版本');
assert.equal(document.title.includes('冒险启程'), true, 'zh 标题');
assert.ok(shell.language, '语言选择器暴露');

// 语言切换：写 localStorage 并带 lang 参数跳转。
element('language').onchange();
assert.equal(storage.get('maple-ui-locale'), 'en');
assert.match(assignments[0], /lang=en/);

// showNews：打开弹窗并触发 onShowNews；已打开不重复 showModal。
shell.showNews();
assert.equal(shell.news.open, true);
assert.equal(events.show, 1);
shell.showNews();
assert.equal(events.show, 2, '回调仍触发（输入复位语义）');

// setPlayLayout(true)：game-mode + 信息区块搬进弹窗内容区。
shell.setPlayLayout(true);
assert.ok(document.body.classList.contains('game-mode'));
assert.ok(element('news-content').children.includes(header), 'header 搬进新闻内容区');
assert.ok(element('news-content').children.includes(footer), 'footer 搬进新闻内容区');

// setPlayLayout(false)：搬回原位 + 弹窗关闭复位 + 触发 news close 回调。
const closedBefore = events.closed;
shell.setPlayLayout(false);
assert.ok(!document.body.classList.contains('game-mode'));
assert.equal(header.beforeNodes?.[0]?.calls, 1, 'header 经 marker.after 放回页面');
assert.equal(element('game-alert').hidden, true, '弹窗提示按钮复位');
assert.equal(element('news-log').children.length, 0, '消息日志清空');
assert.equal(events.closed, closedBefore + 1, 'setPlayLayout(false) 关闭弹窗并触发回调');

// news-close 按钮点击关闭弹窗。
element('news-close').onclick();
assert.equal(shell.news.open, false);

console.log('app page-shell: template ids, language switch, news dialog, play layout toggling passed.');
