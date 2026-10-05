# docdesk

本地资料登记与版本留存的命令行工具。需要 Node.js 24，无外部运行依赖，全部数据保存在本机资料库目录中（`docs.json` 记录版本元数据，`blobs/` 保存各版本原始字节快照）。

## 用法

```sh
node app.js [--help | -h]

# 登记新资料（编号在库内唯一）；编号已存在且内容一致时返回现有记录，
# 内容不同则拒绝并提示使用 update
node app.js register --dir <库目录> --id <资料编号> --file <本地文件>

# 更新资料：先核对 --expect 与当前版本号，不符即拒绝；
# 内容相同则不新增版本，内容不同则追加下一个连续版本
node app.js update --dir <库目录> --id <资料编号> --file <本地文件> --expect <当前版本号>

# 列出库内资料的编号、当前版本与来源路径
node app.js list --dir <库目录>

# 查看指定资料全部版本的顺序、大小、保存时间与来源
node app.js history --dir <库目录> --id <资料编号>

# 把指定版本的原始字节写到标准输出（可重定向保存）
node app.js show --dir <库目录> --id <资料编号> --version <版本号>
```

选项值也支持 `--dir=...` 形式。不同 `--dir` 的资料库相互隔离。

## 退出码

- `0`：成功（输出会区分“已登记/已更新”与“未变化”）
- `1`：业务或文件失败（冲突、资料或版本不存在、文件不可读、库记录损坏等）
- `2`：用法错误（未知命令或参数、缺少必填参数）

## 示例

```sh
node app.js register --dir ./lib --id spec --file ./spec-v1.md
node app.js update --dir ./lib --id spec --file ./spec-v2.md --expect 1
node app.js history --dir ./lib --id spec
node app.js show --dir ./lib --id spec --version 1 > spec-v1.restored.md
```
