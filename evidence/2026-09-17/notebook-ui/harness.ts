// 由 scripts/check_tms273_notebook_ui.mjs 生成（该脚本会覆盖本文件）。
// 离线挂载真 NotebookView：目录与私有状态都在 ./data.json 里，PNG 走 ./assets。
import { NotebookView } from '../../../client/src/features/notebook/view';
import '../../../client/src/features/notebook/style.css';

const data = await (await fetch('./data.json')).json();
const host = document.querySelector('#ui-windows');
const sent = [];
const states = [];

const directory = data.directory;
const reply = message => {
  if (message.type !== 'notebookQuery') return;
  const last = states.at(-1);
  const samePage = last && last.section === message.section && last.page === message.page;
  const base = {
    type: 'notebookState',
    requestId: message.requestId,
    section: message.section,
    catalogVersion: directory.catalogVersion,
    scope: message.section === 'monster' ? 'account' : 'character',
    revision: samePage ? last.revision + 1 : 1,
    page: message.page,
    serverNowMs: 1,
  };
  const state = message.section === 'monster'
    ? { ...base, pageCount: 15, rows: data.monsterRows, summary: data.summary.monster, blockedReason: '本构建尚未接入收藏登记（该登记规则尚未核定），因此怪物页暂时没有已登记的条目。' }
    : { ...base, pageCount: signal.pageCount, rows: message.page === 0 ? data.equipmentRows : [], summary: data.summary.equipment };
  states.push(state);
  window.__sentCount = sent.length;
  setTimeout(() => view.receiveState(state), 0);
};
const signal = { pageCount: 29 };

const view = new NotebookView(host, data.manifest, {
  send: message => { sent.push(message); reply(message); return true; },
  status: message => { window.__status = (window.__status ?? []).concat(message); },
  loadDirectory: async () => directory,
});
window.__view = view;
window.__data = data;
view.open();
document.body.dataset.ready = 'true';
