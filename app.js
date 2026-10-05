#!/usr/bin/env node
// docdesk — 本地资料库登记与版本留存（Node.js 24，ES modules，无外部依赖）

import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const APP_NAME = 'docdesk';
const APP_VERSION = '0.1.0';
const STORE_DIR = '.docdesk';
const INDEX_NAME = 'index.json';
const INDEX_TMP = 'index.json.tmp';
const LOCK_NAME = 'write.lock';
const STALE_LOCK_MS = 2_000;
const LOCK_WAIT_MS = Number(process.env.DOCDESK_LOCK_WAIT_MS || 10_000);
const HASH_RE = /^[0-9a-f]{64}$/;

const HELP_TEXT = `${APP_NAME} ${APP_VERSION} — 本地资料库登记与版本留存

用法:
  node app.js register --repo <目录> --id <编号> --file <路径>
  node app.js update   --repo <目录> --id <编号> --file <路径> --expected-version <n>
  node app.js list     --repo <目录>
  node app.js history  --repo <目录> --id <编号>
  node app.js get      --repo <目录> --id <编号> --version <n> [--output <路径>]
  node app.js [--help|-h]

全局选项:
  --repo <目录>            资料库目录（也可用环境变量 DOCDESK_REPO，命令行优先）
  --json                   以 JSON 输出结果（错误同样输出 {"ok":false,...}）

register（登记）:
  --id <编号>              库内唯一、非空的资料编号（可为任意文本，含空格）
  --file <路径>            可读取的本地普通文件，按原始字节保存内容快照
  结果必为以下之一:
    added      新增资料并保存第 1 个版本及来源路径
    unchanged  编号已存在且内容与当前版本一致：返回现有记录，不新增版本、不改来源
    conflict   编号已存在但内容与当前版本不同：拒绝写入，退出码 1，提示使用 update

update（更新）:
  --id <编号>              资料编号
  --file <路径>            可读取的本地普通文件
  --expected-version <n>   先核对当前版本：资料不存在或版本号不符均拒绝，
                           即使内容与当前版本一致也不能绕过冲突
  结果必为以下之一:
    added      核对通过且内容不同：追加下一个连续版本；
               旧版本的内容、来源与先后顺序保持不变；
               内容与某个较早版本相同仍形成新版本，旧版本不会被设回当前
    unchanged  核对通过且内容与当前版本一致：成功返回现有版本，历史不变，退出码 0
    conflict   资料不存在或预期版本与当前版本不符：拒绝写入，退出码 1

list（目录）:
  按编号字典序列出全部资料：编号、当前版本号、字节大小、当前来源路径

history（版本历史）:
  --id <编号>              列出该资料全部版本：版本号顺序、字节大小、保存时间、来源

get（取回指定版本）:
  --version <n>            按编号与版本号取回与登记时完全一致的字节
  -o, --output <路径>      输出到指定文件（原子写入）；缺省输出到标准输出
  不存在的资料或版本明确报错，退出码 1

无参数、--help、-h 显示本帮助；未知命令或参数以退出码 2 结束。

退出码:
  0  成功（含 register/update 的 unchanged）
  1  业务或文件失败（冲突、编号/版本不存在、文件不可读、存储记录损坏、快照缺失等）
  2  用法错误（未知命令或参数、缺少参数值等）
  3  内部错误（存储初始化或 I/O 失败、等待存储锁超时等）

存储布局（位于资料库目录内，可整体复制移动；全部为本机文件，不涉及网络）:
  ${STORE_DIR}/
    ${INDEX_NAME}        清单：全部资料与版本元数据（经临时文件原子改名替换）
    blobs/<sha256前2位>/<sha256>   按内容 sha256 编址的不可变字节快照
    ${LOCK_NAME}              写入命令的跨进程互斥锁（运行期间短暂存在）

每个成功新版本记录其实际来源路径（绝对路径）与保存时间（UTC，ISO 8601）。

示例:
  node app.js register --repo ./lib1 --id alpha --file ./draft.txt
  node app.js update   --repo ./lib1 --id alpha --file ./draft2.txt --expected-version 1
  node app.js list     --repo ./lib1
  node app.js history  --repo ./lib1 --id alpha
  node app.js get      --repo ./lib1 --id alpha --version 2 --output ./out.bin
`;

/* ------------------------------- 异常类型 -------------------------------- */

class UsageError extends Error {}    // -> 2
class AppError extends Error {}      // -> 1
class InternalError extends Error {} // -> 3

// 输出管道被读取方提前关闭时安静退出（Unix 常规行为），不打印堆栈
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
}

/* ------------------------------- 参数解析 -------------------------------- */

const COMMAND_SPECS = {
  register: { required: ['id', 'file'], optional: [] },
  update:   { required: ['id', 'file', 'expected-version'], optional: [] },
  list:     { required: [], optional: [] },
  history:  { required: ['id'], optional: [] },
  get:      { required: ['id', 'version'], optional: ['output'] },
};
const SHORT_OPTIONS = { o: 'output' };
const GLOBAL_OPTIONS = new Set(['repo', 'json']);

function parseArgs(argv) {
  const command = argv[0];
  if (command === undefined) return { help: true };
  if (command === '--help' || command === '-h') {
    if (argv.length !== 1) throw new UsageError(`${command} 不接受额外参数`);
    return { help: true };
  }
  if (command.startsWith('-')) throw new UsageError(`未知参数 ${command}`);
  if (!Object.hasOwn(COMMAND_SPECS, command)) {
    throw new UsageError(`未知命令 ${command}（可用命令：register、update、list、history、get）`);
  }

  const spec = COMMAND_SPECS[command];
  const allowed = new Set([...spec.required, ...spec.optional, ...GLOBAL_OPTIONS]);
  const values = new Map();
  const repeated = new Set();

  const setOpt = (name, value) => {
    if (!allowed.has(name)) throw new UsageError(`命令 ${command} 不支持选项 --${name}`);
    if (values.has(name)) repeated.add(name);
    values.set(name, value);
  };

  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    let name;
    let inlineValue;

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) { name = tok.slice(2, eq); inlineValue = tok.slice(eq + 1); }
      else name = tok.slice(2);
    } else if (tok.startsWith('-') && tok !== '-' && tok.length > 1) {
      name = SHORT_OPTIONS[tok[1]];
      if (!name) throw new UsageError(`未知参数 ${tok}`);
      if (tok.length > 2) {
        if (tok[2] !== '=') throw new UsageError(`未知参数 ${tok}`);
        inlineValue = tok.slice(3);
      }
    } else {
      throw new UsageError(`命令 ${command} 不接受位置参数：${tok}`);
    }

    if (name === 'json') {
      if (inlineValue !== undefined) throw new UsageError('--json 是开关选项，不带值');
      setOpt('json', true);
      continue;
    }
    let value;
    if (inlineValue !== undefined) value = inlineValue;
    else {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`选项 --${name} 缺少参数值`);
    }
    setOpt(name, value);
  }

  if (repeated.size) throw new UsageError(`选项重复指定：--${[...repeated].join('、--')}`);
  for (const r of spec.required) {
    if (!values.has(r)) throw new UsageError(`命令 ${command} 缺少必需选项 --${r}`);
  }

  const repo = values.get('repo') ?? process.env.DOCDESK_REPO;
  if (!repo || typeof repo !== 'string' || repo.trim() === '') {
    throw new UsageError('缺少资料库目录：请使用 --repo <目录> 或设置 DOCDESK_REPO');
  }

  return {
    help: false,
    command,
    repo,
    json: values.get('json') === true,
    opts: Object.fromEntries(values),
  };
}

function requireNonEmptyId(id) {
  if (typeof id !== 'string' || id.length === 0 || /^\s*$/.test(id)) {
    throw new UsageError('资料编号必须是非空文本');
  }
  return id;
}

function parseVersion(value, label = '--version') {
  if (!/^\d+$/.test(String(value))) throw new UsageError(`${label} 必须是正整数`);
  const n = Number(value);
  if (n < 1 || n > 2_147_483_647) throw new UsageError(`${label} 超出允许范围（1..2147483647）`);
  return n;
}

/* ----------------------------- 输入文件读取 ------------------------------- */

async function readSourceFile(file) {
  if (typeof file !== 'string' || file === '') throw new UsageError('--file 路径不能为空');
  let st;
  try {
    st = await fsp.stat(file); // 跟随符号链接
  } catch (e) {
    if (e.code === 'ENOENT') throw new AppError(`文件不存在: ${file}`);
    if (e.code === 'EACCES') throw new AppError(`文件不可读取（权限拒绝）: ${file}`);
    throw new AppError(`无法访问文件: ${file} (${e.message})`);
  }
  if (!st.isFile()) throw new AppError(`不是本地普通文件: ${file}`);
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch (e) {
    if (e.code === 'EACCES') throw new AppError(`文件不可读取（权限拒绝）: ${file}`);
    throw new AppError(`读取文件失败: ${file} (${e.message})`);
  }
  return { buf, source: path.resolve(file) };
}

/* ------------------------------- 存储布局 --------------------------------- */

async function prepareStore(repo, create) {
  const repoDir = path.resolve(repo);
  let st;
  try {
    st = await fsp.stat(repoDir);
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (!create) throw new AppError(`资料库目录不存在: ${repo}`);
      await fsp.mkdir(repoDir, { recursive: true });
      st = await fsp.stat(repoDir);
    } else if (e.code === 'EACCES') {
      throw new InternalError(`资料库目录不可访问（权限拒绝）: ${repo}`);
    } else {
      throw new InternalError(`无法访问资料库目录: ${repo} (${e.message})`);
    }
  }
  if (!st.isDirectory()) throw new AppError(`资料库路径不是目录: ${repo}`);

  const storeDir = path.join(repoDir, STORE_DIR);
  if (create) {
    try {
      // 残留的 index.json.tmp 无需清理：提交时以截断方式重写并原子改名。
      // 不能在锁外删除它，否则可能删掉其他进程正在提交的临时清单。
      await fsp.mkdir(path.join(storeDir, 'blobs'), { recursive: true });
    } catch (e) {
      throw new InternalError(`无法初始化资料库: ${e.message}`);
    }
  }
  return { repoDir, storeDir };
}

/* -------------------------------- 锁 -------------------------------------- */

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

async function acquireLock(storeDir) {
  await fsp.mkdir(storeDir, { recursive: true });
  const lockPath = path.join(storeDir, LOCK_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await fsp.open(lockPath, 'wx');
      await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      return { fh, lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') throw new InternalError(`无法获取存储锁: ${e.message}`);
      let stale = false;
      try {
        const raw = await fsp.readFile(lockPath, 'utf8');
        const [pidStr, ts] = raw.split('\n');
        const pid = Number(pidStr);
        if (ts && Date.now() - Date.parse(ts) > STALE_LOCK_MS && !pidAlive(pid)) stale = true;
      } catch { /* 读不到锁文件就继续等 */ }
      if (stale) {
        try { await fsp.rm(lockPath, { force: true }); } catch { /* 与锁持有者竞争，继续等 */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new InternalError('等待存储锁超时；可能有另一个 docdesk 进程正在写入该资料库');
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
    }
  }
}

async function releaseLock(lock) {
  if (!lock) return;
  try { await lock.fh.close(); } catch { /* 忽略 */ }
  try { await fsp.rm(lock.lockPath, { force: true }); } catch { /* 忽略 */ }
}

/* ------------------------------- 清单校验 --------------------------------- */

function corrupt(detail) {
  return new AppError(`资料库记录已损坏，已保留现场且未做任何修改（${detail}）`);
}

function validateIndex(raw) {
  if (raw === null) return { magic: 'docdesk-store-v1', version: 1, documents: {} };
  let obj;
  try {
    obj = JSON.parse(raw.toString('utf8'));
  } catch {
    throw corrupt('index.json 不是合法 JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw corrupt('顶层结构必须是对象');
  }
  if (obj.magic !== 'docdesk-store-v1') throw corrupt('magic 标识不匹配');
  if (obj.version !== 1) throw corrupt(`不支持的清单版本: ${obj.version}`);
  if (obj.documents === null || typeof obj.documents !== 'object' || Array.isArray(obj.documents)) {
    throw corrupt('documents 必须是对象');
  }
  for (const [key, doc] of Object.entries(obj.documents)) {
    if (key.length === 0) throw corrupt('存在空的资料编号');
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw corrupt(`资料 ${key} 的记录不是对象`);
    }
    if (doc.id !== key) throw corrupt(`资料 ${key} 的编号字段与键不一致`);
    if (!Array.isArray(doc.versions) || doc.versions.length === 0) {
      throw corrupt(`资料 ${key} 没有任何版本`);
    }
    if (doc.currentVersion !== doc.versions.length) {
      throw corrupt(`资料 ${key} 的当前版本号与版本数量不一致`);
    }
    let expected = 1;
    for (const v of doc.versions) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw corrupt(`资料 ${key} v${expected} 的记录不是对象`);
      }
      if (v.version !== expected) {
        throw corrupt(`资料 ${key} 的版本号不连续（期望 v${expected}，实际 v${v.version}）`);
      }
      if (!Number.isInteger(v.size) || v.size < 0) {
        throw corrupt(`资料 ${key} v${expected} 的大小非法`);
      }
      if (typeof v.sha256 !== 'string' || !HASH_RE.test(v.sha256)) {
        throw corrupt(`资料 ${key} v${expected} 的 sha256 非法`);
      }
      if (typeof v.source !== 'string' || v.source === '') {
        throw corrupt(`资料 ${key} v${expected} 的来源路径非法`);
      }
      if (typeof v.savedAt !== 'string' || Number.isNaN(Date.parse(v.savedAt))) {
        throw corrupt(`资料 ${key} v${expected} 的保存时间非法`);
      }
      expected++;
    }
  }
  return obj;
}

function blobPath(storeDir, hash) {
  return path.join(storeDir, 'blobs', hash.slice(0, 2), hash);
}

async function loadIndex(storeDir) {
  let raw;
  try {
    raw = await fsp.readFile(path.join(storeDir, INDEX_NAME));
  } catch (e) {
    if (e.code === 'ENOENT') return validateIndex(null); // 尚未有任何资料
    if (e.code === 'EACCES') throw new InternalError('清单不可读取（权限拒绝）');
    throw new InternalError(`读取清单失败: ${e.message}`);
  }
  return validateIndex(raw);
}

// 校验快照是否齐全；给定 ids 时只检查这些资料，缺省检查全部引用
async function checkRefs(storeDir, index, ids = null) {
  if (!index) return;
  for (const doc of Object.values(index.documents)) {
    if (ids && !ids.has(doc.id)) continue;
    for (const v of doc.versions) {
      const p = blobPath(storeDir, v.sha256);
      let st;
      try {
        st = await fsp.stat(p);
      } catch (e) {
        if (e.code === 'ENOENT') {
          throw new AppError(`资料库快照缺失，已保留现场：资料 ${doc.id} v${v.version} 的内容文件不存在（sha256=${v.sha256}）`);
        }
        throw new InternalError(`访问快照失败: ${e.message}`);
      }
      if (!st.isFile() || st.size !== v.size) {
        throw new AppError(`资料库快照已损坏，已保留现场：资料 ${doc.id} v${v.version} 大小不匹配（记录 ${v.size}，实际 ${st.size}）`);
      }
    }
  }
}

/* ------------------------------- 原子提交 --------------------------------- */

async function fsyncDirMaybe(dir) {
  try {
    const fh = await fsp.open(dir, 'r');
    try { await fh.sync(); } finally { await fh.close(); }
  } catch { /* 某些平台不允许目录 fsync，仅作尽力增强 */ }
}

async function putBlob(storeDir, hash, buf) {
  const dir = path.join(storeDir, 'blobs', hash.slice(0, 2));
  await fsp.mkdir(dir, { recursive: true });
  const final = path.join(dir, hash);
  try {
    const st = await fsp.stat(final);
    if (st.isFile() && st.size === buf.length) return; // 内容相同，复用同一快照
  } catch { /* 尚不存在，继续写入 */ }

  const tmp = path.join(dir, `.${hash}.${process.pid}.tmp`);
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(buf);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, final);
  await fsyncDirMaybe(dir);
}

async function commitIndex(storeDir, index) {
  // 提交前确认清单引用的每个快照都真实存在，绝不引用空快照
  await checkRefs(storeDir, index);
  const tmp = path.join(storeDir, INDEX_TMP);
  const payload = Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf8');
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(payload);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, path.join(storeDir, INDEX_NAME));
  await fsyncDirMaybe(storeDir);
}

/* ------------------------------- 输出辅助 --------------------------------- */

function emit(json, human, obj) {
  if (json) console.log(JSON.stringify(obj));
  else process.stdout.write(human);
}

// 业务冲突：人类模式走异常（stderr + 退出码 1），JSON 模式输出结构化结果
function conflict(json, obj) {
  if (json) {
    console.log(JSON.stringify(obj));
    return 1;
  }
  throw new AppError(obj.error);
}

/* ------------------------------- 命令实现 --------------------------------- */

async function cmdRegister(parsed) {
  const { repo, json, opts } = parsed;
  const id = requireNonEmptyId(opts.id);
  // 先读源文件：读取失败时资料库目录不会被创建或修改
  const { buf, source } = await readSourceFile(opts.file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');

  const { storeDir } = await prepareStore(repo, true);
  const lock = await acquireLock(storeDir);
  try {
    const index = await loadIndex(storeDir);
    await checkRefs(storeDir, index);
    const existing = index.documents[id];

    if (existing) {
      const cur = existing.versions[existing.currentVersion - 1];
      if (cur.sha256 === hash) {
        emit(json,
          `unchanged\t${id}\tv${cur.version}\t内容与当前版本一致，未新增版本，来源保持 ${cur.source}\n`,
          { ok: true, result: 'unchanged', id, currentVersion: cur.version, version: cur.version, size: cur.size, source: cur.source });
        return 0;
      }
      return conflict(json, {
        ok: false, result: 'conflict', id, currentVersion: cur.version,
        error: `资料编号 ${id} 已存在且内容与当前版本 v${cur.version} 不同；如确认要更新，请使用 update --expected-version ${cur.version}`,
      });
    }

    const savedAt = new Date().toISOString();
    await putBlob(storeDir, hash, buf);
    index.documents[id] = {
      id,
      currentVersion: 1,
      versions: [{ version: 1, size: buf.length, sha256: hash, source, savedAt }],
    };
    await commitIndex(storeDir, index); // 快照与清单构成一次完整变更

    emit(json,
      `added\t${id}\tv1\t${buf.length} 字节\t来源 ${source}\n`,
      { ok: true, result: 'added', id, currentVersion: 1, version: 1, size: buf.length, sha256: hash, source, savedAt });
    return 0;
  } finally {
    await releaseLock(lock);
  }
}

async function cmdUpdate(parsed) {
  const { repo, json, opts } = parsed;
  const id = requireNonEmptyId(opts.id);
  const expected = parseVersion(opts['expected-version'], '--expected-version');
  const { buf, source } = await readSourceFile(opts.file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');

  // 更新不创建新库：库不存在或未初始化按“资料不存在”冲突处理
  const { storeDir } = await prepareStore(repo, false);
  try {
    await fsp.access(path.join(storeDir, INDEX_NAME));
  } catch {
    return conflict(json, {
      ok: false, result: 'conflict', reason: 'not-found', id, expectedVersion: expected,
      error: `资料不存在: ${id}（资料库尚未初始化或资料编号不存在；预期当前版本 v${expected}）`,
    });
  }
  const lock = await acquireLock(storeDir);
  try {
    const index = await loadIndex(storeDir);
    if (index === null || !index.documents[id]) {
      return conflict(json, {
        ok: false, result: 'conflict', reason: 'not-found', id, expectedVersion: expected,
        error: `资料不存在: ${id}（预期当前版本 v${expected}）`,
      });
    }
    await checkRefs(storeDir, index, new Set([id]));
    const doc = index.documents[id];

    // 先核对预期版本：即使内容与当前版本一致，版本不符也一律拒绝
    if (doc.currentVersion !== expected) {
      return conflict(json, {
        ok: false, result: 'conflict', reason: 'version-mismatch', id,
        expectedVersion: expected, currentVersion: doc.currentVersion,
        error: `版本冲突: 资料 ${id} 当前版本为 v${doc.currentVersion}，与预期 v${expected} 不符，已拒绝写入`,
      });
    }

    const cur = doc.versions[doc.currentVersion - 1];
    if (cur.sha256 === hash) {
      emit(json,
        `unchanged\t${id}\tv${cur.version}\t内容与当前版本一致，历史不变，来源保持 ${cur.source}\n`,
        { ok: true, result: 'unchanged', id, currentVersion: cur.version, version: cur.version, size: cur.size, source: cur.source });
      return 0;
    }

    const savedAt = new Date().toISOString();
    const next = doc.currentVersion + 1;
    await putBlob(storeDir, hash, buf);
    doc.versions.push({ version: next, size: buf.length, sha256: hash, source, savedAt });
    doc.currentVersion = next;
    await commitIndex(storeDir, index);

    emit(json,
      `added\t${id}\tv${next}\t${buf.length} 字节\t来源 ${source}\n`,
      { ok: true, result: 'added', id, currentVersion: next, version: next, size: buf.length, sha256: hash, source, savedAt });
    return 0;
  } finally {
    await releaseLock(lock);
  }
}

async function cmdList(parsed) {
  const { repo, json } = parsed;
  const { storeDir } = await prepareStore(repo, false);
  const index = await loadIndex(storeDir);
  await checkRefs(storeDir, index);
  const docs = Object.values(index?.documents ?? {}).sort((a, b) =>
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (json) {
    return {
      ok: true,
      documents: docs.map((d) => {
        const c = d.versions[d.currentVersion - 1];
        return { id: d.id, currentVersion: d.currentVersion, size: c.size, source: c.source, savedAt: c.savedAt };
      }),
    };
  }
  const lines = ['编号\t当前版本\t字节\t当前来源'];
  for (const d of docs) {
    const c = d.versions[d.currentVersion - 1];
    lines.push(`${d.id}\tv${d.currentVersion}\t${c.size}\t${c.source}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return undefined;
}

async function cmdHistory(parsed) {
  const { repo, json, opts } = parsed;
  const id = requireNonEmptyId(opts.id);
  const { storeDir } = await prepareStore(repo, false);
  const index = await loadIndex(storeDir);
  const doc = index?.documents[id];
  if (!doc) throw new AppError(`资料不存在: ${id}`);
  await checkRefs(storeDir, index, new Set([id]));

  if (json) {
    return {
      ok: true,
      id,
      currentVersion: doc.currentVersion,
      versions: doc.versions.map((v) => ({
        version: v.version, size: v.size, sha256: v.sha256, source: v.source, savedAt: v.savedAt,
      })),
    };
  }
  const lines = [
    `资料 ${id}（当前版本 v${doc.currentVersion}，共 ${doc.versions.length} 个版本）`,
    '版本\t字节\t保存时间(UTC)\t来源',
  ];
  for (const v of doc.versions) {
    lines.push(`v${v.version}\t${v.size}\t${v.savedAt}\t${v.source}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return undefined;
}

function writeAllStdout(buf) {
  return new Promise((resolve, reject) => {
    fs.write(1, buf, (err) => {
      if (err && err.code === 'EPIPE') process.exit(0); // 读取方提前关闭，安静退出
      if (err) reject(err);
      else resolve();
    });
  });
}

async function cmdGet(parsed) {
  const { repo, json, opts } = parsed;
  const id = requireNonEmptyId(opts.id);
  const version = parseVersion(opts.version);
  const output = opts.output;
  const { storeDir } = await prepareStore(repo, false);
  const index = await loadIndex(storeDir);
  const doc = index?.documents[id];
  if (!doc) throw new AppError(`资料不存在: ${id}`);
  const rec = doc.versions[version - 1];
  if (!rec) {
    throw new AppError(`版本不存在: 资料 ${id} 没有 v${version}（当前版本 v${doc.currentVersion}）`);
  }

  let buf;
  try {
    buf = await fsp.readFile(blobPath(storeDir, rec.sha256));
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new AppError(`资料库快照缺失，已保留现场：资料 ${id} v${version} 的内容文件不存在（sha256=${rec.sha256}）`);
    }
    throw new InternalError(`读取快照失败: ${e.message}`);
  }
  if (buf.length !== rec.size) {
    throw new AppError(`资料库快照已损坏，已保留现场：资料 ${id} v${version} 大小不匹配（记录 ${rec.size}，实际 ${buf.length}）`);
  }
  if (crypto.createHash('sha256').update(buf).digest('hex') !== rec.sha256) {
    throw new AppError(`资料库快照已损坏，已保留现场：资料 ${id} v${version} 校验和不匹配`);
  }

  if (output) {
    const out = path.resolve(output);
    const tmp = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.tmp`);
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(buf);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, out);
    if (json) return { ok: true, id, version, size: buf.length, sha256: rec.sha256, output: out };
    process.stdout.write(`已取回 ${id} v${version}（${buf.length} 字节）到 ${out}\n`);
    return undefined;
  }

  if (json) {
    return { ok: true, id, version, size: buf.length, sha256: rec.sha256, contentBase64: buf.toString('base64') };
  }
  await writeAllStdout(buf);
  return undefined;
}

/* --------------------------------- 主流程 --------------------------------- */

const COMMANDS = {
  register: cmdRegister,
  update: cmdUpdate,
  list: cmdList,
  history: cmdHistory,
  get: cmdGet,
};

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${APP_NAME}: ${e.message}\n使用 --help 查看帮助\n`);
      return 2;
    }
    throw e;
  }

  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  try {
    const r = await COMMANDS[parsed.command](parsed);
    if (typeof r === 'number') return r;
    if (parsed.json && r && typeof r === 'object') console.log(JSON.stringify(r));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      if (parsed.json) console.log(JSON.stringify({ ok: false, error: e.message }));
      else process.stderr.write(`${APP_NAME}: ${e.message}\n`);
      return 2;
    }
    if (e instanceof AppError) {
      if (parsed.json) console.log(JSON.stringify({ ok: false, error: e.message }));
      else process.stderr.write(`${APP_NAME}: ${e.message}\n`);
      return 1;
    }
    if (e instanceof InternalError) {
      if (parsed.json) console.log(JSON.stringify({ ok: false, error: `内部错误: ${e.message}` }));
      else process.stderr.write(`${APP_NAME}: 内部错误: ${e.message}\n`);
      return 3;
    }
    process.stderr.write(`${APP_NAME}: 内部错误: ${e?.stack || e}\n`);
    return 3;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => {
    process.stderr.write(`${APP_NAME}: 致命错误: ${e?.stack || e}\n`);
    process.exitCode = 3;
  },
);
