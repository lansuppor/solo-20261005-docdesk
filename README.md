# docdesk

本地资料库登记与版本留存命令行工具。全部数据保存在本机文件中，不依赖网络服务或生成式模型。

- Node.js 24，ES modules，无外部运行依赖（仅使用 Node 内置模块）
- 同一资料库目录跨进程共享同一批记录，不同资料库目录相互隔离
- 快照按原始字节保存；源文件之后被修改、移动或删除不影响已保存版本
- 快照与版本清单以一次完整变更提交（先写不可变快照，再原子改名清单），中断后重开只能看到完整旧状态或完整新状态
- 写入带跨进程锁，命令可并发执行；记录损坏或快照缺失时报错并保留现场，不会自动清空或当作新库继续写

## 运行

需要 Node.js 24（`package.json` 限定 `node >=24 <25`），无需 `npm install`。

```sh
node app.js
node app.js --help
node app.js -h
```

无参数、`--help`、`-h` 均显示应用名与完整帮助。

## 命令

参数同时支持空格与等号形式（如 `--id alpha` 或 `--id=alpha`），也支持环境变量 `DOCDESK_REPO`（命令行 `--repo` 优先）。

### register — 登记资料

```sh
node app.js register --repo ./lib1 --id alpha --file ./draft.txt
```

- `--id`：库内唯一、非空的资料编号（可为任意文本，含空格）。编号是资料身份：文件路径或内容相同都不会合并不同编号。
- `--file`：可读取的本地普通文件，按原始字节保存内容快照，并记录来源路径。
- 首次登记保存第 1 个版本。重复登记已有编号时：
  - 内容与当前版本完全一致 → `unchanged`，返回现有记录，不新增版本、不改来源；
  - 内容不同 → `conflict`（退出码 1），拒绝写入并提示使用 `update`。

### update — 更新版本

```sh
node app.js update --repo ./lib1 --id alpha --file ./draft2.txt --expected-version 1
```

- 先核对预期当前版本号：资料不存在或版本不符一律拒绝（退出码 1），**即使输入内容与当前版本一致也不能绕过冲突**。
- 核对通过后：
  - 内容与当前版本一致 → `unchanged`，成功返回现有版本（退出码 0），历史不变；
  - 内容不同 → `added`，追加下一个连续版本；旧版本的内容、来源与顺序保持不变。
- 内容与某个较早版本相同仍会形成新版本，不会把旧版本设回当前。
- 每个成功的新版本记录其实际来源路径与保存时间（UTC，ISO 8601）。

### list — 目录列表

```sh
node app.js list --repo ./lib1
```

按编号字典序列出：编号、当前版本号、字节大小、当前来源路径。

### history — 版本历史

```sh
node app.js history --repo ./lib1 --id alpha
```

按编号查看全部版本：版本号顺序、字节大小、保存时间（UTC）与来源。资料不存在时报错（退出码 1）。

### get — 读取指定版本内容

```sh
node app.js get --repo ./lib1 --id alpha --version 2
node app.js get --repo ./lib1 --id alpha --version 2 --output ./out.bin
```

按编号和版本号取回与登记时完全一致的字节：缺省写到标准输出，`-o/--output` 原子写入指定文件。不存在的资料或版本明确报错（退出码 1）。

### 机器可读输出与环境变量

```sh
node app.js list --repo ./lib1 --json
node app.js register --repo "$DOCDESK_REPO" --id alpha --file f.txt --json
```

- `--json`：结果以 JSON 打印（`get` 输出到标准输出时内容以 `contentBase64` 返回；带 `--output` 时只返回元数据）。错误为 `{"ok":false,"error":...}` 并仍设置非零退出码。
- `DOCDESK_REPO`：与 `--repo` 等效。
- `DOCDESK_LOCK_WAIT_MS`：写入锁最长等待毫秒数，默认 10000。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含 register/update 的 `unchanged`） |
| 1 | 业务或文件失败：冲突、编号/版本不存在、文件不可读、记录损坏、快照缺失 |
| 2 | 用法错误：未知命令或参数、缺少参数值等 |
| 3 | 内部错误：存储初始化或 I/O 失败、等待存储锁超时 |

## 存储布局

资料数据全部位于 `--repo` 指定目录下的 `.docdesk/` 中，可整体复制或移动：

```
.docdesk/
  index.json                  清单：资料条目与全部版本元数据
  blobs/<sha256前2位>/<sha256>  按内容 sha256 编址的不可变字节快照
  write.lock                  写入命令的跨进程锁（运行期间短暂存在）
```

提交顺序：先把快照写入 `blobs/`（临时文件 fsync 后改名），再把清单写入临时文件 fsync 后原子改名为 `index.json`。因此：

- 读取失败、无效输入或存储失败不会留下可见的新资料、半个版本或跳号；
- 写入进程被中断后重开，只能看到完整旧状态或完整新状态；
- 重新运行后仍遵守编号唯一、预期版本检查与重复操作规则；
- 清单结构损坏或所需快照缺失时报错并保留现场，不会自动清空或当作新库继续写。

## 示例会话

```sh
mkdir -p work && printf '初稿' > work/draft.txt
node app.js register --repo ./lib1 --id alpha --file work/draft.txt
# added  alpha  v1  ...

printf '二稿，内容不同' > work/draft.txt
node app.js register --repo ./lib1 --id alpha --file work/draft.txt
# 退出码 1：conflict，提示 update --expected-version 1

node app.js update --repo ./lib1 --id alpha --file work/draft.txt --expected-version 1
# added  alpha  v2  ...

node app.js list    --repo ./lib1
node app.js history --repo ./lib1 --id alpha
node app.js get     --repo ./lib1 --id alpha --version 1   # 仍取回“初稿”的原始字节
```
