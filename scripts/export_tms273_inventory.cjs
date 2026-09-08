// Export the TMS273 inventory and equipment windows from their authored WZ
// layout.  This deliberately keeps the gameplay operation surface small: the
// client consumes the background, slot positions, and button states while the
// server remains authoritative for inventory capacity and mutations.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const wz = require('@tybys/wz');
const { createReader } = require('./tms273_wz.cjs');

const root = path.resolve(__dirname, '..');
const data = path.join(root, '参考/273/TMS273少爷一键端/客户端/TMS273.7/Data');
const output = path.join(root, 'resources/tms273-export');
const assets = path.join(output, 'assets/tms273');
const reader = createReader(data, path.join(output, 'ms'));

const children = node => [...(node?.wzProperties || [])];
const value = (node, key, fallback = undefined) => node?.at?.(key)?.wzValue ?? fallback;
const point = (node, key) => {
  const valueAtKey = value(node, key);
  return valueAtKey && Number.isFinite(valueAtKey.x) && Number.isFinite(valueAtKey.y)
    ? { x: Number(valueAtKey.x), y: Number(valueAtKey.y) }
    : null;
};
const numeric = node => children(node)
  .filter(child => /^\d+$/.test(child.name))
  .sort((left, right) => Number(left.name) - Number(right.name));

async function get(source) {
  const node = await reader.get(source);
  if (node instanceof wz.WzImage) assert(await node.parseImage(), source);
  return node;
}

const exported = new Map();
async function frame(source) {
  if (!exported.has(source)) {
    const result = await reader.frame(source, assets);
    assert(result.url && result.width > 0 && result.height > 0, source);
    assert(Number.isFinite(result.delay) && result.delay > 0, `${source}: invalid delay`);
    exported.set(source, {
      ...result,
      url: '/assets/tms273/' + result.url,
    });
  }
  return exported.get(source);
}

function buttonPosition(asset) {
  assert(asset && Number.isFinite(asset.x) && Number.isFinite(asset.y), 'button frame position missing');
  return { x: asset.x, y: asset.y };
}

async function exportButtonStates(target, base, sourceBase) {
  for (const state of ['normal', 'pressed', 'disabled', 'mouseOver']) {
    target[`${base}/${state}/0`] = await frame(`${sourceBase}/${state}/0`);
  }
}

async function exportTabs(target, mode, sourceBase, count) {
  for (const state of ['selected', 'normal']) {
    for (let index = 0; index < count; index++) {
      target[`${mode}/tab:category/${state}/${index}`] = await frame(`${sourceBase}/${state}/${index}`);
    }
  }
}

function layoutMode({ background, autoBuild, tabs, buttons, mesos, slots }) {
  return { width: background.width, height: background.height, slots, tabs, buttons, mesos };
}

async function exportInventoryWindow() {
  const source = 'UI/UIInventory.img/Inventory';
  const inventoryUi = {};
  const background = await frame(`${source}/backgrnd`);
  const fullBackground = await frame(`${source}/FullBackgrnd`);
  inventoryUi.backgrnd = background;
  inventoryUi.FullBackgrnd = fullBackground;
  inventoryUi.disabled = await frame(`${source}/disabled`);

  const pos = await get(`${source}/pos`);
  const slotWidth = Number(value(pos, 'slot_width'));
  const slotHeight = Number(value(pos, 'slot_height'));
  const spacingX = Number(value(pos, 'slot_space_x'));
  const spacingY = Number(value(pos, 'slot_space_y'));
  const slotOrigin = point(pos, 'slot_pos');
  const itemOffset = point(pos, 'item_pos');
  const itemCountOffset = point(pos, 'item_count_pos');
  const smallColumns = Number(value(pos, 'slot_col'));
  const rows = Number(value(pos, 'slot_row'));
  assert([slotWidth, slotHeight, spacingX, spacingY, smallColumns, rows].every(Number.isFinite));
  assert(slotOrigin && itemOffset && itemCountOffset && smallColumns > 0 && rows > 0);
  const fullColumns = Math.floor((fullBackground.width - slotOrigin.x + spacingX) / (slotWidth + spacingX));
  assert(fullColumns >= smallColumns, 'FullBackgrnd has fewer columns than Inventory');
  const makeSlots = columns => ({
    columns,
    rows,
    slotWidth,
    slotHeight,
    spacingX,
    spacingY,
    origin: slotOrigin,
    itemOffset,
    itemCountOffset,
    itemCount: columns * rows,
  });

  const modeSpecs = [
    { name: 'AutoBuild', background, columns: smallColumns },
    { name: 'FullAutoBuild', background: fullBackground, columns: fullColumns },
  ];
  const modeLayouts = {};
  for (const mode of modeSpecs) {
    const modeSource = `${source}/${mode.name}`;
    const modeNode = await get(modeSource);
    const tab = await get(`${modeSource}/tab:category`);
    const tabNormal = await frame(`${modeSource}/tab:category/normal/0`);
    const tabNext = await frame(`${modeSource}/tab:category/normal/1`);
    const tabLT = point(tab, 'lt');
    const tabRB = point(tab, 'rb');
    assert(tabLT && tabRB, `${modeSource}/tab:category bounds missing`);
    const tabCount = 5;
    await exportTabs(inventoryUi, mode.name, modeSource + '/tab:category', tabCount);
    for (const button of ['close', 'full', 'min', 'sort', 'meso']) {
      await exportButtonStates(inventoryUi, `${mode.name}/button:${button}`, `${modeSource}/button:${button}`);
    }
    const buttonFrame = name => inventoryUi[`${mode.name}/button:${name}/normal/0`];
    const autoMeso = await get(`${modeSource}/tooltip:Meso`);
    const mesoLT = point(autoMeso, 'lt');
    const mesoRB = point(autoMeso, 'rb');
    assert(mesoLT && mesoRB, `${modeSource}/tooltip:Meso bounds missing`);
    modeLayouts[mode.name] = layoutMode({
      background: mode.background,
      autoBuild: modeNode,
      tabs: {
        left: tabNormal.x,
        top: tabNormal.y,
        stepX: tabNext.x - tabNormal.x,
        width: tabNormal.width,
        height: tabNormal.height,
        viewportWidth: tabRB.x - tabLT.x,
        viewportHeight: tabRB.y - tabLT.y,
        count: tabCount,
      },
      buttons: {
        close: buttonPosition(buttonFrame('close')),
        size: buttonPosition(buttonFrame(mode.name === 'AutoBuild' ? 'full' : 'min')),
        sort: buttonPosition(buttonFrame('sort')),
        coin: buttonPosition(buttonFrame('meso')),
      },
      mesos: { x: mesoLT.x, y: mesoLT.y, width: mesoRB.x - mesoLT.x, height: mesoRB.y - mesoLT.y },
      slots: makeSlots(mode.columns),
    });
  }

  // The modern source has a sixth decoration-related tab.  The current
  // protocol exposes five ordinary inventory types, so export the five tabs
  // used by the runtime and leave the unsupported sixth tab dormant.
  const layout = {
    source,
    categoryCount: 5,
    backendSlotLimit: 24,
    small: modeLayouts.AutoBuild,
    full: modeLayouts.FullAutoBuild,
  };
  return { inventoryUi, inventoryLayout: layout };
}

async function exportEquipmentWindow() {
  const source = 'UI/UIEquip.img/Equip';
  const equipmentUi = {};
  const background = await frame(`${source}/main/backgrnd`);
  equipmentUi.backgrnd = background;
  for (const state of ['normal', 'pressed', 'disabled', 'mouseOver']) {
    equipmentUi[`main/button:close/${state}/0`] = await frame(`${source}/main/button:close/${state}/0`);
  }
  const equipCanvas = await frame(`${source}/EquipTab/canvas:equip`);
  equipmentUi['EquipTab/canvas:equip'] = equipCanvas;
  const equipTab = await get(`${source}/EquipTab`);
  const slotSize = Number(value(equipTab, 'SlotSize'));
  assert(Number.isFinite(slotSize) && slotSize > 0);
  const slots = {};
  const slotNodes = numeric(await get(`${source}/EquipTab/Slots`));
  for (const node of slotNodes) {
    const slotNumber = Number(node.name);
    if (slots[String(slotNumber)]) continue;
    const asset = await frame(`${source}/EquipTab/Slots/${node.name}`);
    slots[String(slotNumber)] = { x: asset.x, y: asset.y, width: asset.width, height: asset.height };
    equipmentUi[`EquipTab/Slots/${slotNumber}`] = asset;
  }
  const close = equipmentUi['main/button:close/normal/0'];
  return {
    equipmentUi,
    equipmentLayout: {
      source,
      width: background.width,
      height: background.height,
      tabOrigin: { x: equipCanvas.x, y: equipCanvas.y },
      slotSize,
      close: buttonPosition(close),
      itemOffset: itemOffsetForEquipment(equipTab),
      slots,
    },
  };
}

function itemOffsetForEquipment() {
  // EquipTab uses the same 42px slot and 32px item canvas convention as the
  // Inventory `item_pos` entry.  This is a layout fact of the 273 source, not
  // an inventory operation default.
  return { x: 5, y: 5 };
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(assets, { recursive: true });
  const inventory = await exportInventoryWindow();
  const equipment = await exportEquipmentWindow();
  for (const part of ['top', 'mid', 'btm']) {
    inventory.inventoryUi[`tooltip:${part}`] = await frame(`UI/UIToolTipNew.img/Item/Equip/frame/common/${part}`);
  }
  const result = { ...inventory, ...equipment };
  fs.writeFileSync(path.join(output, 'windows-inventory.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({
    file: 'resources/tms273-export/windows-inventory.json',
    frames: exported.size,
    inventory: { small: result.inventoryLayout.small.slots, full: result.inventoryLayout.full.slots },
    equipmentSlots: Object.keys(result.equipmentLayout.slots).length,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => reader.close());
