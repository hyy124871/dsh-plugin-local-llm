# 本地模型 · dsh-plugin-local-llm

给 **DeepSeek Harness** 的本地模型插件：下载或导入 GGUF，用 **llama.cpp** 在本机运行，再通过内置 OpenAI 兼容网关接入 Harness 模型下拉。无需手填 API Key。

当前版本：`1.0.0-preview`（首个 GitHub 预览版）。

## 功能

- **模型管理**：Qwen、Kimi、Spark、Llama、MiniCPM 等 GGUF 多源下载；支持本地文件导入、自选模型目录。
- **硬件自适应**：按显存/内存自动决定 GPU 层数、上下文长度、线程数和 KV 缓存类型。Spark-X2.6 的滑动窗口结构按真实 KV 估算，1M 上下文在 16GB 机器上约占 3.9GB（q4_0）。
- **稳定切换**：蓝绿启动新服务，健康后再回收旧进程；切换时等待在飞请求结束，避免 502。
- **速度优先**：小上下文自动用 f16 KV，2B 模型 64K 实测 8.6 → 9.7 tok/s；Spark 64K 约 8.6 tok/s，1M 约 3 tok/s（CPU 上的长上下文代价）。
- **输出上限**：普通请求最高 32768 tokens，精简/压缩请求最高 4096 tokens，并受当前上下文的 1/4 约束；不再被旧的 4096/1024 一刀切。
- **零配置接入**：自动生成 provider 和凭据，写入 Harness 模型菜单；支持思考强度选择。

## 环境

- DeepSeek Harness Desktop
- Windows x64（主要验证环境）；其他平台需自备 llama.cpp 运行时
- Node.js >= 22
- 建议 16GB 内存；小模型可在 8GB 机器上 CPU 运行

## 安装

### 从 GitHub 安装

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
npm install github:hyy124871/dsh-plugin-local-llm
```

安装后在 Harness「设置 → 插件」启用 `dsh-plugin-local-llm`，重启 Harness。

### 从 zip 安装

解压 `dsh-plugin-local-llm-1.0.0-preview.zip` 到：

```text
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-local-llm
```

或在 profile 的 `package.json` 中使用 `link:` 指向源码目录。

## 快速开始

1. 打开 Harness「设置 → 本地模型」。
2. 在「下载模型」选择模型和量化档；16GB 内存建议先选 `Qwen3.5 0.8B Q4_K_M` 或 `Qwen3.8 2B Q4_K_M`。
3. 下载完成后点「启动」，再点「设为默认」。
4. 回到对话页，模型下拉会出现「本地模型」。

## 速度参考

本机：i5-10210U（4 核）、15.8GB 内存、MX250 2GB，CPU-only：

| 模型 | 量化 | 输出速度 |
|---|---|---:|
| Qwen3.5 0.8B | Q4_K_M | ~36 tok/s |
| Qwen3.8 2B | Q4_K_M | ~9.7 tok/s |
| Spark-X2.6 1.7B | Q4_K_M | ~3 tok/s @1M，~8.6 @64K |

2B 模型在 4 核 CPU 上已接近内存带宽上限；要更快请选 0.8B。

## 目录

```text
src/          插件服务端：目录、下载、运行时、网关、Harness 接入
lib/client.js 设置页 UI
assets/       图标
scripts/      本地探针与自测
```

## 已知限制

- Kimi K2.6 官方为 1T 总参 / 32B 激活，没有 2.8B 版本；目录中的 `Kimi-VL A3B` 是 16B 总参 / 2.8B 激活，不是 K2.6。
- Kimi-VL 目前只接文本部分，未接 mmproj 视觉投影。
- 超大模型（>内存）会回退到 mmap，速度受硬盘限制。

## License

MIT
