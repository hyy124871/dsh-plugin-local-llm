# 安装到 DeepSeek Harness

`dsh-plugin-local-llm` 是一个 DSH profile bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，客户端由 `lib/client.js` 注册设置页。

当前版本：`1.0.0-preview`。

## 前置

- DeepSeek Harness Desktop 已安装。
- Node.js ≥ 22（仅自测和打包需要，Harness 自带运行时）。
- Windows 已内置/可下载 llama.cpp 运行时；其他平台需自备。

## 方式一：npm 安装（推荐）

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
npm install github:hyy124871/dsh-plugin-local-llm
```

## 方式二：zip 安装

解压 `dsh-plugin-local-llm-1.0.0-preview.zip` 到：

```text
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-local-llm
```

## 方式三：本地源码 link

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
npm install file:C:/Users/<你>/.../dsh-plugin-local-llm
```

Windows 的 junction：

```powershell
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-local-llm" "C:\Users\<你>\...\dsh-plugin-local-llm"
```

## 启用

1. 确认 profile 的 `package.json` 中 `dsh.bundles` 含 `dsh-plugin-local-llm`。
2. 重启 Harness。
3. 打开「设置 → 插件」，启用「本地模型」。
4. 进入「设置 → 本地模型」，下载模型并启动。

## 排查

- **插件不显示**：检查 `package.json` 的 `dsh.bundles`，并确认目录名与包名一致。
- **启动报 `ctx is not defined`**：旧版本 bug，升级到 `1.0.0-preview`。
- **服务启动失败**：查看 `%USERPROFILE%\.dsh\local-llm\logs\server-*.log`。
- **502 网关失败**：确认 `127.0.0.1:18081` 正在监听；查看 `logs\requests.jsonl`。
