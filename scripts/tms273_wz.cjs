#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const wz = require('@tybys/wz');

const PATCH = 273;
const IV = wz.WzMapleVersion.BMS;
const META = new WeakMap();
let initialized;
let rawDataCompatInstalled = false;

class WzRawDataProperty extends wz.WzImageProperty {
  constructor(name, reader, offset, endOfBlock) {
    super();
    this.name = name;
    this.parent = null;
    this.offset = offset;
    this.length = endOfBlock - offset;
    this.endOfBlock = endOfBlock;
    this.source = reader?._path ?? null;
    this.reader = reader;
  }

  get propertyType() {
    return 'RawData';
  }

  get value() {
    return this;
  }

  get wzValue() {
    return this;
  }

  async getBytes() {
    if (!this.reader) return null;
    const current = this.reader.pos;
    this.reader.pos = this.offset;
    const bytes = await this.reader.read(this.length);
    this.reader.pos = current;
    return bytes;
  }

  getBitmap() {
    throw new Error(`RawData 节点不可绘制: ${this.fullPath}`);
  }

  dispose() {
    if (this._disposed) return;
    this.reader = null;
    this._disposed = true;
  }
}

function installRawDataCompat() {
  if (rawDataCompatInstalled) return;
  const original = wz.WzImageProperty.extractMore;
  wz.WzImageProperty.extractMore = async function extractMoreCompat(reader, offset, endOfBlock, name, iname, parent, imgParent) {
    if (iname === '') iname = await reader.readWzString();
      if (iname === 'RawData') {
      const payloadOffset = reader.pos;
      const boundary = Number(endOfBlock);
      if (!Number.isSafeInteger(payloadOffset) || !Number.isSafeInteger(boundary) || boundary < payloadOffset || boundary > reader.size) {
        throw new Error(`RawData 区块边界无效: ${reader._path ?? '<WZ>'} ${payloadOffset}..${endOfBlock}`);
      }
      reader.pos = boundary;
      const rawData = new WzRawDataProperty(name, reader, payloadOffset, boundary);
      rawData.parent = parent;
      return rawData;
    }
    return original.call(this, reader, offset, endOfBlock, name, iname, parent, imgParent);
  };
  rawDataCompatInstalled = true;
}

function splitPath(value) {
  const parts = String(value).split('/');
  if (parts.some(part => part.length === 0)) throw new Error(`WZ路径包含空片段: ${value}`);
  return parts;
}

function resourcePath(value) {
  const parts = splitPath(value);
  const imageIndex = parts.findIndex(segment => /\.img$/i.test(segment));
  const directory = imageIndex < 0 ? parts : parts.slice(0, imageIndex);
  if (directory.some(part => part === '.' || part === '..')) throw new Error(`WZ路径不允许相对目录: ${value}`);
  return parts;
}

function splitLinkPath(value) {
  const parts = String(value).split(/[\\/]/);
  if (parts.some(part => part.length === 0)) throw new Error(`WZ链接包含空片段: ${value}`);
  return parts;
}

async function openWz(filePath) {
  installRawDataCompat();
  const file = new wz.WzFile(path.resolve(filePath), IV, PATCH);
  const status = await file.parseWzFile();
  if (status !== wz.WzFileParseStatus.SUCCESS) {
    file.dispose();
    throw new Error(`无法解析 ${filePath}: ${wz.getErrorDescription(status)}`);
  }
  return file;
}

function ensureInit() {
  initialized ||= wz.init();
  return initialized;
}

async function getObject(file, objectPath) {
  let current = file instanceof wz.WzImage ? file : file.wzDirectory;
  if (objectPath == null || objectPath === '') return current;
  for (const segment of splitPath(objectPath)) {
    if (current instanceof wz.WzImage && !current.parsed) await current.parseImage();
    current = current?.at(segment) ?? null;
    if (current == null) return null;
  }
  return current;
}

function linkedPath(object) {
  return linkString(object, '_outlink');
}

function inlinkedPath(object) {
  return linkString(object, '_inlink');
}

function linkString(object, name) {
  const property = object?.at?.(name);
  if (!property) return null;
  const result = property.value ?? property.wzValue;
  return typeof result === 'string' && result.length > 0 ? result : null;
}

function parentImage(object) {
  let current = object;
  while (current) {
    if (current instanceof wz.WzImage) return current;
    current = current.parent;
  }
  return null;
}

function uolTarget(object) {
  if (!(object instanceof wz.WzUOLProperty)) return null;
  try {
    return object.linkValue;
  } catch {
    return null;
  }
}

function localPath(object, image) {
  const parts = [];
  let current = object;
  while (current && current !== image) {
    if (current.name) parts.unshift(current.name);
    current = current.parent;
  }
  return current === image ? parts : [];
}

function imagePrefix(source) {
  const parts = splitPath(source);
  const imageIndex = parts.findIndex(segment => /\.img$/i.test(segment));
  return imageIndex < 0 ? [] : parts.slice(0, imageIndex + 1);
}

function pngInfo(object) {
  const png = object?.pngProperty;
  if (!png) return null;
  return { width: png.width, height: png.height, format: png.format };
}

function value(object, name) {
  return object?.at?.(name)?.wzValue;
}

function vector(object, name) {
  const point = name ? value(object, name) : object?.wzValue;
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
}

function mapValue(object) {
  const map = object?.at?.('map');
  if (!map?.wzProperties) return {};
  return Object.fromEntries([...map.wzProperties].map(item => [item.name, vector(item, '')]).filter(([, point]) => point));
}

function alphaFields(chain) {
  const fields = {};
  for (const [property, output] of [['a', 'alpha'], ['a0', 'a0'], ['a1', 'a1']]) {
    const item = chain.map(entry => value(entry.object, property)).find(entry => entry != null);
    if (item != null) fields[output] = item;
  }
  return fields;
}

function sourceName(source) {
  const safe = source.replace(/[^A-Za-z0-9_.-]/g, '_');
  const hash = crypto.createHash('sha1').update(source, 'utf8').digest('hex').slice(0, 10);
  return `${safe}-${hash}.png`;
}

class ResourceReader {
  constructor(dataRoot, imageRoot = null) {
    this.dataRoot = path.resolve(dataRoot);
    this.imageRoot = imageRoot ? path.resolve(imageRoot) : null;
    this.files = new Map();
    this.images = new Map();
    this.nodes = new Map();
    this.candidateCache = new Map();
    this.pngBuffers = new Map();
    this.pngOutputs = new Map();
  }

  async file(filePath) {
    const absolute = path.resolve(filePath);
    if (!this.files.has(absolute)) this.files.set(absolute, await openWz(absolute));
    return this.files.get(absolute);
  }

  async image(filePath) {
    const absolute = path.resolve(filePath);
    if (!this.images.has(absolute)) {
      installRawDataCompat();
      this.images.set(absolute, wz.WzImage.createFromFile(absolute, IV));
    }
    return this.images.get(absolute);
  }

  candidates(logicalPath) {
    const parts = resourcePath(logicalPath);
    const source = parts.join('/');
    const cached = this.candidateCache.get(source);
    if (cached) return cached;
    const imageIndex = parts.findIndex(segment => /\.img$/i.test(segment));
    if (imageIndex < 0) throw new Error(`路径缺少 .img: ${logicalPath}`);
    const dir = path.join(this.dataRoot, ...parts.slice(0, imageIndex));
    const stem = parts[imageIndex - 1] || path.basename(dir);
    if (!fs.existsSync(dir)) {
      const empty = { targetPath: parts.slice(imageIndex).join('/'), paths: [] };
      this.candidateCache.set(source, empty);
      return empty;
    }
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const paths = fs.readdirSync(dir)
      .filter(name => new RegExp(`^${escaped}(?:_\\d+)?\\.wz$`, 'i').test(name))
      .sort()
      .map(name => path.join(dir, name));
    const result = { targetPath: parts.slice(imageIndex).join('/'), paths };
    this.candidateCache.set(source, result);
    return result;
  }

  imageCandidate(logicalPath) {
    if (!this.imageRoot) return null;
    const parts = resourcePath(logicalPath);
    const imageIndex = parts.findIndex(segment => /\.img$/i.test(segment));
    if (imageIndex < 0) return null;
    const filePath = path.join(this.imageRoot, ...parts.slice(0, imageIndex + 1));
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
  }

  async get(logicalPath) {
    await ensureInit();
    const source = resourcePath(logicalPath).join('/');
    if (this.nodes.has(source)) return this.nodes.get(source);
    const { targetPath, paths } = this.candidates(source);
    for (const filePath of paths) {
      const file = await this.file(filePath);
      const object = await getObject(file, targetPath);
      if (object != null) {
        META.set(object, { reader: this, source, filePath, image: parentImage(object), node: object });
        this.nodes.set(source, object);
        return object;
      }
    }
    const imagePath = this.imageCandidate(source);
    if (imagePath) {
      const image = await this.image(imagePath);
      const separator = targetPath.indexOf('/');
      const imageObjectPath = separator < 0 ? '' : targetPath.slice(separator + 1);
      const object = await getObject(image, imageObjectPath);
      if (object != null) {
        META.set(object, { reader: this, source, filePath: imagePath, image: parentImage(object), node: object });
        this.nodes.set(source, object);
        return object;
      }
    }
    throw new Error(`找不到 273 WZ 节点: ${source}`);
  }

  metaFor(object, fallback) {
    const existing = META.get(object);
    if (existing?.reader === this) return existing;
    const image = parentImage(object);
    const prefix = image === fallback.image
      ? imagePrefix(fallback.source)
      : (() => {
          const relative = path.relative(this.dataRoot, path.dirname(fallback.filePath));
          const directory = splitPath(relative);
          return [...directory, image?.name].filter(Boolean);
        })();
    const source = [...prefix, ...localPath(object, image)].join('/');
    const meta = { reader: this, source: source || fallback.source, filePath: fallback.filePath, image, node: object };
    META.set(object, meta);
    if (source) this.nodes.set(source, object);
    return meta;
  }

  async resolveInlink(object, link) {
    const image = parentImage(object);
    if (!image) return null;
    const resolve = parts => {
      let current = image;
      for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') {
          current = current?.parent ?? null;
          continue;
        }
        current = current?.at?.(part) ?? null;
        if (!current) return null;
      }
      return current;
    };
    const direct = resolve(splitPath(link));
    if (direct) return direct;
    if (String(link).includes('\\')) return resolve(splitLinkPath(link));
    return null;
  }

  async getLink(link) {
    try {
      return await this.get(link);
    } catch (error) {
      if (!String(link).includes('\\')) throw error;
      return this.get(splitLinkPath(link).join('/'));
    }
  }

  async resolveFrame(raw) {
    const initialMeta = META.get(raw);
    if (!initialMeta) throw new Error('frame 需要 reader.get() 返回的节点');
    const chain = [];
    let current = raw;
    let meta = initialMeta;
    const seen = new Set();
    while (current) {
      if (seen.has(current)) throw new Error(`WZ 链接循环: ${meta.source}`);
      seen.add(current);
      chain.push({ object: current, meta });
      if (current instanceof wz.WzUOLProperty) {
        const target = uolTarget(current);
        if (!target) throw new Error(`UOL 链接不存在: ${meta.source}`);
        current = target;
        meta = this.metaFor(current, meta);
        continue;
      }
      if (current instanceof wz.WzCanvasProperty) {
        const inlink = inlinkedPath(current);
        if (inlink) {
          const target = await this.resolveInlink(current, inlink);
          if (!target) throw new Error(`Canvas 内链不存在: ${inlink}`);
          current = target;
          meta = this.metaFor(current, meta);
          continue;
        }
        const outlink = linkedPath(current);
        if (outlink) {
          current = await this.getLink(outlink);
          meta = META.get(current);
          continue;
        }
      }
      break;
    }
    return { resolved: current, resolvedMeta: meta, chain };
  }

  async pngBuffer(object, key) {
    if (!this.pngBuffers.has(key)) {
      const pending = (async () => {
        const bitmap = await object.getBitmap();
        if (!bitmap) throw new Error(`Canvas 解码为空: ${key}`);
        return Buffer.from(await bitmap.getBufferAsync('image/png'));
      })().catch(error => {
        this.pngBuffers.delete(key);
        throw error;
      });
      this.pngBuffers.set(key, pending);
    }
    return this.pngBuffers.get(key);
  }

  async writePng(object, resolvedSource, outputDir) {
    const targetDir = path.resolve(outputDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, sourceName(resolvedSource));
    const key = `${targetDir}\0${resolvedSource}`;
    if (!this.pngOutputs.has(key)) {
      const pending = (async () => {
        if (!fs.existsSync(target)) fs.writeFileSync(target, await this.pngBuffer(object, resolvedSource));
        return target;
      })().catch(error => {
        this.pngOutputs.delete(key);
        throw error;
      });
      this.pngOutputs.set(key, pending);
    }
    return this.pngOutputs.get(key);
  }

  async frame(source, outputDir) {
    const raw = typeof source === 'string' ? await this.get(source) : source;
    const sourceMeta = META.get(raw);
    if (!sourceMeta) throw new Error('frame 需要 reader.get() 返回的节点');
    const { resolved, resolvedMeta, chain } = await this.resolveFrame(raw);
    const resolvedSource = resolvedMeta.source;
    const info = pngInfo(resolved);
    if (!info) throw new Error(`节点没有 PNG 数据: ${sourceMeta.source}`);
    const origin = chain.map(item => vector(item.object, 'origin')).find(Boolean) || { x: 0, y: 0 };
    const delay = Number(chain.map(item => value(item.object, 'delay')).find(item => item != null) ?? 100);
    let url = null;
    if (outputDir) {
      const target = await this.writePng(resolved, resolvedSource, outputDir);
      url = path.relative(path.resolve(outputDir), target).split(path.sep).join('/');
    }
    const rawMap = mapValue(raw);
    const alpha = alphaFields(chain);
    const anchors = Object.fromEntries(['lt', 'rb', 'head'].map(key => [key, chain.map(node => vector(node, key)).find(Boolean) ?? null]));
    return { url, width: info.width, height: info.height, origin, x: -origin.x, y: -origin.y,
      delay, map: Object.keys(rawMap).length ? rawMap : mapValue(resolved), source: sourceMeta.source, resolvedSource, ...alpha, ...anchors };
  }

  close() {
    for (const file of this.files.values()) file.dispose();
    for (const image of this.images.values()) image.dispose();
    this.files.clear();
    this.images.clear();
    this.nodes.clear();
    this.candidateCache.clear();
    this.pngBuffers.clear();
    this.pngOutputs.clear();
  }
}

function createReader(dataRoot, imageRoot = null) {
  return new ResourceReader(dataRoot, imageRoot);
}

function dataRootFor(filePath) {
  let current = path.dirname(path.resolve(filePath));
  while (true) {
    if (path.basename(current).toLowerCase() === 'data') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`WZ路径不在 Data 目录下: ${filePath}`);
}

function logicalPathForFile(dataRoot, filePath, objectPath) {
  const relativeDir = path.relative(dataRoot, path.dirname(path.resolve(filePath)));
  const directory = relativeDir && relativeDir !== '.'
    ? resourcePath(relativeDir.split(path.sep).join('/'))
    : [];
  return [...directory, ...resourcePath(objectPath)].join('/');
}

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`参数缺少值: ${arg}`);
    result[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return result;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help || !options.path || (!options.dataRoot && !options.wz)) {
    console.log('用法: node scripts/tms273_wz.cjs --data-root DATA --path LOGICAL [--output-dir DIR]');
    console.log('或:   node scripts/tms273_wz.cjs --wz FILE --path OBJECT [--output PNG]');
    return options.help ? 0 : 2;
  }
  const sourcePath = options.wz ? path.resolve(options.wz) : null;
  const dataRoot = path.resolve(options.dataRoot || dataRootFor(sourcePath));
  const logicalPath = sourcePath ? logicalPathForFile(dataRoot, sourcePath, options.path) : options.path;
  const outputPath = options.output ? path.resolve(options.output) : null;
  const outputDir = outputPath ? path.dirname(outputPath) : options.outputDir;
  const reader = createReader(dataRoot);
  try {
    const result = await reader.frame(logicalPath, outputDir);
    if (outputPath && result.url) {
      const generated = path.join(path.resolve(outputDir), result.url);
      fs.renameSync(generated, outputPath);
      result.url = path.basename(outputPath);
    }
    console.log(JSON.stringify({ ...result, dataRoot, path: logicalPath }, null, 2));
    return 0;
  } finally {
    reader.close();
  }
}

module.exports = { PATCH, IV, ResourceReader, WzRawDataProperty, createReader };

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
