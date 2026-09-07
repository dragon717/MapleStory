#!/usr/bin/env node

// Export the source-backed in-game chat surface from StatusBar3.img.  The
// normalized aliases make the small ChatView consumer independent of the
// WZ tree while the four original chat section names remain traceable.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const OUTPUT = path.join(ROOT, 'resources/tms273-export');
const ASSETS = path.join(OUTPUT, 'assets/tms273');
const CHAT = 'UI/StatusBar3.img/chat';
const STATE_NAMES = new Set(['normal', 'pressed', 'disabled', 'mouseOver', 'checked']);

const reader = createReader(DATA);
const exported = new Map();

function children(node) {
  return [...(node?.wzProperties || [])];
}

function value(node, name) {
  return node?.at?.(name)?.wzValue;
}

function scalar(node, name) {
  const result = value(node, name);
  if (typeof result === 'bigint') return Number(result);
  if (['string', 'number', 'boolean'].includes(typeof result)) return result;
  if (result && typeof result === 'object' && ('x' in result || 'y' in result)) {
    return { x: Number(result.x), y: Number(result.y) };
  }
  return undefined;
}

function scalarRecord(node, names) {
  const result = {};
  for (const name of names) {
    const item = scalar(node, name);
    if (item !== undefined) result[name] = item;
  }
  return result;
}

async function get(source) {
  try {
    const node = await reader.get(source);
    if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
    return node;
  } catch (error) {
    throw new Error(`${source}: ${error.message}`, { cause: error });
  }
}

function resolved(node) {
  const seen = new Set();
  let current = node;
  while (current instanceof wz.WzUOLProperty) {
    assert(!seen.has(current), `UOL cycle at ${node?.name || '<unnamed>'}`);
    seen.add(current);
    current = current.linkValue;
  }
  return current;
}

async function frame(source) {
  if (!exported.has(source)) {
    const result = await reader.frame(source, ASSETS);
    assert(result.url && result.width > 0 && result.height > 0, `invalid Canvas: ${source}`);
    exported.set(source, { ...result, url: `/assets/tms273/${result.url}` });
  }
  return exported.get(source);
}

// Export every direct Canvas in a source container.  This is used for the
// nine-slice backgrounds and the common scrollbar pieces.
async function canvasChildren(source) {
  const node = resolved(await get(source));
  const result = {};
  for (const child of children(node)) {
    if (resolved(child) instanceof wz.WzCanvasProperty) {
      result[child.name] = await frame(`${source}/${child.name}`);
    }
  }
  assert(Object.keys(result).length, `no Canvas children: ${source}`);
  return result;
}

async function stateFrame(source, state) {
  const stateSource = `${source}/${state}`;
  const node = resolved(await get(stateSource));
  if (node instanceof wz.WzCanvasProperty) return frame(stateSource);
  const directCanvas = children(node).find(child => resolved(child) instanceof wz.WzCanvasProperty);
  assert(directCanvas, `state has no Canvas: ${stateSource}`);
  return frame(`${stateSource}/${directCanvas.name}`);
}

async function stateChildren(source) {
  const node = resolved(await get(source));
  const result = {};
  for (const child of children(node).filter(child => STATE_NAMES.has(child.name))) {
    result[child.name] = await stateFrame(source, child.name);
  }
  assert(Object.keys(result).length, `no states: ${source}`);
  return result;
}

async function section() {
  const commonScroll = {
    enabled: await canvasChildren(`${CHAT}/common/scroll/enabled`),
    disabled: await canvasChildren(`${CHAT}/common/scroll/disabled`),
  };

  const outside = {
    backgrnd: await frame(`${CHAT}/outside/backgrnd`),
    title: await frame(`${CHAT}/outside/title`),
    filter: { backgrnd: await frame(`${CHAT}/outside/filter/backgrnd`) },
    buttons: {},
    chatTarget: {
      base: await stateChildren(`${CHAT}/outside/chatTarget/base`),
      all: await stateChildren(`${CHAT}/outside/chatTarget/all`),
    },
    layout: {
      root: scalarRecord(await get(`${CHAT}/outside`), ['vector:chatTarget', 'vector:input', 'inputWidth', 'topMargin', 'bottomMargin', 'chatEndSpace', 'dragMargin']),
      filter: scalarRecord(await get(`${CHAT}/outside/filter`), ['inputPos', 'inputWidth']),
    },
  };
  for (const name of ['InChat', 'chat', 'link', 'chatCommand', 'chatEmoticon', 'setting']) {
    outside.buttons[name] = await stateChildren(`${CHAT}/outside/button:${name}`);
  }
  outside.buttons.Tap_outside = await stateChildren(`${CHAT}/outside/Tap_outside`);
  outside.buttons.BtAddTap_outside = await stateChildren(`${CHAT}/outside/BtAddTap_outside`);

  const viewSource = `${CHAT}/ingame/view`;
  const view = {
    backgrnd: await canvasChildren(`${viewSource}/backgrnd`),
    backgrnd_min: await canvasChildren(`${viewSource}/backgrnd_min`),
    tab: await stateChildren(`${viewSource}/tab`),
    tabDefaultAll: await stateChildren(`${viewSource}/tabDefaultAll`),
    tabDefaultEtc: await stateChildren(`${viewSource}/tabDefaultEtc`),
    scroll: {
      enabled: await canvasChildren(`${viewSource}/scroll/enabled`),
      disabled: await canvasChildren(`${viewSource}/scroll/disabled`),
    },
    btMin: await stateChildren(`${viewSource}/btMin`),
    btMax: await stateChildren(`${viewSource}/btMax`),
    btOutChat: await stateChildren(`${viewSource}/btOutChat`),
    layout: scalarRecord(await get(viewSource), [
      'dragMargin', 'vector:chat', 'topMargin', 'bottomMargin', 'chatEndSpace',
      'minWidth', 'maxWidth', 'btMaxMargin', 'minChatMargin', 'vector:minChatDrawAdjust',
      'tabMargin', 'captionMargin', 'tabSpace', 'chatLogBackMargin', 'scrollMargin',
      'scrollHeightMargin', 'scrollHeightAdjust',
    ]),
  };

  const inputSource = `${CHAT}/ingame/input`;
  const inputBackground = `${inputSource}/backgrnd`;
  const input = {
    backgrnd: await canvasChildren(inputBackground),
    chatTarget: {
      base: await stateChildren(`${inputSource}/chatTarget/base`),
      all: await stateChildren(`${inputSource}/chatTarget/all`),
    },
    buttons: {},
    layout: {
      input: scalarRecord(await get(inputSource), ['inputPos', 'borderThick']),
      backgrnd: scalarRecord(await get(inputBackground), ['vector:input', 'width', 'height']),
    },
  };
  for (const name of ['chat', 'link', 'chatCommand', 'chatEmoticon', 'setting']) {
    input.buttons[name] = await stateChildren(`${inputSource}/button:${name}`);
  }
  input.filter = {
    backgrnd: await frame(`${CHAT}/ingame/filter/backgrnd`),
  };

  const combo = scalarRecord(await get(`${CHAT}/combo:emoticon`), [
    'maxItemShown', 'alwayesDrawSelected', 'backColor', 'backFocusedColor', 'boxWidth',
    'emoticonLeftOffset', 'boxTestLeftOffset', 'design', 'drawType', 'fType', 'fTypeSelect',
    'fTypeSelectFouced', 'fTypeSelectHighlight', 'fTypeSelectHighlightFouced',
    'highlightEditBoxText', 'id', 'itemPosType', 'selectType', 'scrollID', 'toolTip',
    'lt', 'rb', 'sButtonUOL', 'buttonOnLeft', 'scrollUOL',
  ]);

  const normalized = {
    source: CHAT,
    panel: {
      background: view.backgrnd,
      collapsedBackground: view.backgrnd_min,
      collapseButton: view.btMin,
      expandButton: view.btMax,
      outsideButton: view.btOutChat,
    },
    input: {
      background: input.backgrnd,
      target: input.chatTarget.all,
      whisper: input.buttons.chat,
      buttons: input.buttons,
    },
    scroll: commonScroll,
    layout: {
      panel: view.layout,
      input: input.layout,
      outside: outside.layout,
    },
    common: { scroll: commonScroll },
    outside,
    ingame: { view, input },
    'combo:emoticon': combo,
  };
  return normalized;
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  try {
    const chatUi = await section();
    const output = {
      contentVersion: 'tms273-chat',
      source: 'TMS273.7 client WZ / UI/StatusBar3.img/chat',
      chatUi,
      layout: chatUi.layout,
    };
    const outputPath = path.join(OUTPUT, 'chat.json');
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      output: outputPath,
      source: CHAT,
      pngs: exported.size,
      sections: ['common', 'outside', 'ingame', 'combo:emoticon'],
      panel: chatUi.layout.panel,
      input: chatUi.layout.input,
    }, null, 2));
  } finally {
    reader.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { DATA, OUTPUT, ASSETS, CHAT, main };
