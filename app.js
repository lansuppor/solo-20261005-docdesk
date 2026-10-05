#!/usr/bin/env node
// docdesk — 本地资料登记与版本留存。
// 每个资料库是一个目录：docs.json 保存版本记录，blobs/ 保存内容快照。
// 写入采用“临时文件 + rename”，中断后只会看到完整旧状态或完整新状态。

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const NAME = 'docdesk';
const META_FILE = 'docs.json';
const BLOB_DIR = 'blobs';

const HELP = `${NAME} — 本地资料登记与版本留存

用法:
  node app.js [--help | -h]
  node app.js register --dir <库目录> --id <资料编号> --file <本地文件>
  node app.js update   --dir <库目录> --id <资料编号> --file <本地文件> --expect <当前版本号>
  node app.js list     --dir <库目录>
  node app.js history  --dir <库目录> --id <资料编号>
  node app.js show     --dir <库目录> --id <资料编号> --version <版本号>

说明:
  register  登记新资料，保存第一个版本；编号已存在且内容一致时返回现有记录，
            内容不同则拒绝并提示使用 update。
  update    先核对 --expect 与当前版本号，一致才允许：内容相同则不新增版本，
            内容不同则追加下一个连续版本。
  list      列出库内全部资料的编号、当前版本与来源路径。
  history   列出指定资料全部版本的顺序、大小、保存时间与来源路径。
  show      把指定版本的原始字节写到标准输出（可重定向保存）。

选项值也可写成 --dir=... 形式。退出码：0 成功，1 业务或文件失败，2 用法错误。`;

class UsageError extends Error {}
class FailureError extends Error {}

function fail(message) {
  throw new FailureError(message);
}

// ---------- 参数解析 ----------

const COMMANDS = {
  register: ['dir', 'id', 'file'],
  update: ['dir', 'id', 'file', 'expect'],
  list: ['dir'],
  history: ['dir', 'id'],
  show: ['dir', 'id', 'version'],
};

function parseArgs(argv) {
  if (argv.length === 0) return { help: true };
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };

  const [command, ...rest] = argv;
  const allowed = COMMANDS[command];
  if (!allowed) throw new UsageError(`未知命令: ${command}`);

  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--') || arg === '--') throw new UsageError(`未知参数: ${arg}`);
    const eq = arg.indexOf('=');
    let key, value;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      value = rest[++i];
      if (value === undefined) throw new UsageError(`参数 --${key} 缺少值`);
    }
    if (!allowed.includes(key)) throw new UsageError(`命令 ${command} 不支持参数 --${key}`);
    if (key in opts) throw new UsageError(`参数 --${key} 重复`);
    opts[key] = value;
  }
  for (const key of allowed) {
    if (!(key in opts)) throw new UsageError(`命令 ${command} 缺少参数 --${key}`);
  }
  return { command, opts };
}

function requireId(id) {
  if (typeof id !== 'string' || id.trim() === '') fail('资料编号不能为空');
  return id;
}

function requireVersion(value, label) {
  if (!/^\d+$/.test(value)) fail(`${label}必须是正整数: ${value}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail(`${label}必须是正整数: ${value}`);
  return n;
}

// ---------- 存储 ----------

function metaPath(dir) {
  return path.join(dir, META_FILE);
}

function blobPath(dir, id, version) {
  const key = Buffer.from(id, 'utf8').toString('hex');
  return path.join(dir, BLOB_DIR, key, `v${version}`);
}

async function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

function validateLib(data, file) {
  const corrupt = () => fail(`资料库记录已损坏: ${file}`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) corrupt();
  const { docs } = data;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) corrupt();
  for (const [id, doc] of Object.entries(docs)) {
    if (!doc || typeof doc !== 'object') corrupt();
    if (typeof doc.source !== 'string') corrupt();
    if (!Number.isInteger(doc.current) || doc.current < 1) corrupt();
    if (!Array.isArray(doc.versions) || doc.versions.length === 0) corrupt();
    doc.versions.forEach((v, i) => {
      if (!v || typeof v !== 'object') corrupt();
      if (v.version !== i + 1) corrupt();
      if (!Number.isInteger(v.size) || v.size < 0) corrupt();
      if (typeof v.source !== 'string' || typeof v.savedAt !== 'string') corrupt();
    });
    if (doc.current !== doc.versions[doc.versions.length - 1].version) corrupt();
  }
  return data;
}

async function loadLib(dir) {
  const file = metaPath(dir);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { docs: {} };
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(`资料库记录已损坏: ${file}`);
  }
  return validateLib(data, file);
}

async function saveLib(dir, lib) {
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(metaPath(dir), JSON.stringify(lib, null, 2) + '\n');
}

async function readBlob(dir, id, version) {
  const file = blobPath(dir, id, version);
  try {
    return await fsp.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') fail(`资料 ${id} 的版本 ${version} 快照缺失: ${file}`);
    throw err;
  }
}

async function readSourceFile(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (err) {
    if (err.code === 'ENOENT') fail(`文件不存在: ${file}`);
    throw err;
  }
  if (!stat.isFile()) fail(`不是普通文件: ${file}`);
  return fsp.readFile(file);
}

// ---------- 命令 ----------

async function cmdRegister({ dir, id, file }) {
  id = requireId(id);
  const content = await readSourceFile(file);
  const lib = await loadLib(dir);
  const existing = lib.docs[id];

  if (existing) {
    const current = await readBlob(dir, id, existing.current);
    if (current.equals(content)) {
      console.log(`未变化: ${id} 当前版本 v${existing.current}（来源 ${existing.source}）`);
      return;
    }
    fail(`冲突: 资料 ${id} 已存在且内容不同，请使用 update 命令（当前版本 v${existing.current}）`);
  }

  const version = {
    version: 1,
    size: content.length,
    source: file,
    savedAt: new Date().toISOString(),
  };
  const blob = blobPath(dir, id, 1);
  await fsp.mkdir(path.dirname(blob), { recursive: true });
  await writeFileAtomic(blob, content);
  lib.docs[id] = { source: file, current: 1, versions: [version] };
  await saveLib(dir, lib);
  console.log(`已登记: ${id} v1（${content.length} 字节，来源 ${file}）`);
}

async function cmdUpdate({ dir, id, file, expect }) {
  id = requireId(id);
  const expected = requireVersion(expect, '预期版本号');
  const content = await readSourceFile(file);
  const lib = await loadLib(dir);
  const doc = lib.docs[id];
  if (!doc) fail(`资料不存在: ${id}`);
  if (doc.current !== expected) {
    fail(`冲突: 资料 ${id} 当前版本为 v${doc.current}，与预期 v${expected} 不符`);
  }

  const current = await readBlob(dir, id, doc.current);
  if (current.equals(content)) {
    console.log(`未变化: ${id} 保持 v${doc.current}（来源 ${doc.source}）`);
    return;
  }

  const next = doc.current + 1;
  const version = {
    version: next,
    size: content.length,
    source: file,
    savedAt: new Date().toISOString(),
  };
  const blob = blobPath(dir, id, next);
  await fsp.mkdir(path.dirname(blob), { recursive: true });
  await writeFileAtomic(blob, content);
  doc.versions.push(version);
  doc.current = next;
  doc.source = file;
  await saveLib(dir, lib);
  console.log(`已更新: ${id} v${next}（${content.length} 字节，来源 ${file}）`);
}

async function cmdList({ dir }) {
  const lib = await loadLib(dir);
  const ids = Object.keys(lib.docs).sort();
  if (ids.length === 0) {
    console.log('（空资料库）');
    return;
  }
  for (const id of ids) {
    const doc = lib.docs[id];
    console.log(`${id}\tv${doc.current}\t${doc.source}`);
  }
}

async function cmdHistory({ dir, id }) {
  id = requireId(id);
  const lib = await loadLib(dir);
  const doc = lib.docs[id];
  if (!doc) fail(`资料不存在: ${id}`);
  for (const v of doc.versions) {
    const mark = v.version === doc.current ? '（当前）' : '';
    console.log(`v${v.version}\t${v.size} 字节\t${v.savedAt}\t${v.source}${mark}`);
  }
}

async function cmdShow({ dir, id, version }) {
  id = requireId(id);
  const n = requireVersion(version, '版本号');
  const lib = await loadLib(dir);
  const doc = lib.docs[id];
  if (!doc) fail(`资料不存在: ${id}`);
  if (!doc.versions.some((v) => v.version === n)) {
    fail(`资料 ${id} 不存在版本 v${n}（当前共 ${doc.versions.length} 个版本）`);
  }
  const content = await readBlob(dir, id, n);
  process.stdout.write(content);
}

// ---------- 入口 ----------

const HANDLERS = {
  register: cmdRegister,
  update: cmdUpdate,
  list: cmdList,
  history: cmdHistory,
  show: cmdShow,
};

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    return;
  }
  await HANDLERS[parsed.command](parsed.opts);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`${NAME}: ${err.message}\n${HELP}`);
    process.exitCode = 2;
  } else if (err instanceof FailureError) {
    console.error(`${NAME}: ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error(`${NAME}: ${err.message}`);
    process.exitCode = 1;
  }
});
