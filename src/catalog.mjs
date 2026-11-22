// 模型目录：收录真实存在、能用 llama.cpp 跑的 GGUF 仓库。
// 体积来自 HuggingFace tree API 实测（2026-11-21）；换仓库/换量化时以实际文件为准。
//
// 说明：
//  - match 是下载解析用的关键字：目录名（UD-Q4_K_XL/…）或单文件名片段。
//  - gb 是整档（含分片）合计体积，不含 mmproj 视觉投影、imatrix 与 MTP 草稿头。
//  - 在线更新发现的新家族会以 discovered:true 追加，不覆盖这里的基准目录。

export const FAMILIES = [
  // ---- Qwen3.8：官方目前只开源 27B；2B 为社区蒸馏 GGUF，0.8B 暂无公开 GGUF ----
  {
    id: 'qwen3.8-2b-distill',
    name: 'Qwen3.8 2B Distill',
    vendor: 'Qwen',
    params: '2B',
    paramsB: 2,
    arch: 'Dense',
    mode: 'dense',
    tag: '轻量 · 3.8',
    tier: 3,
    repo: 'empero-ai/Qwen3.8-2B-Distill-GGUF',
    sourceRepo: 'empero-ai/Qwen3.8-2B-Distill',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/empero-ai/Qwen3.8-2B-Distill-GGUF',
    note: 'Qwen3.8 2B 社区蒸馏版，Q4 约 1.31GB；不是官方 0.8/2B 权重，但在 2GB 显存机器上比 27B 实际得多。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 1.31, match: 'Qwen3.8-2B-Q4_K_M', note: '推荐' },
      { id: 'Q5_K_M', label: 'Q5_K_M · 5-bit', bits: 5, gb: 1.45, match: 'Qwen3.8-2B-Q5_K_M' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 1.61, match: 'Qwen3.8-2B-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 2.08, match: 'Qwen3.8-2B-Q8_0', note: '画质优先' },
    ],
  },
  {
    id: 'qwen3.8-27b',
    name: 'Qwen3.8 27B',
    vendor: 'Qwen',
    params: '27B',
    paramsB: 27,
    arch: 'Dense',
    mode: 'dense',
    tag: '高质量',
    tier: 2,
    repo: 'unsloth/Qwen3.8-27B-GGUF',
    sourceRepo: 'Qwen/Qwen3.8-27B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.8-27B',
    note: 'Qwen3.8 官方 27B 稠密模型；16GB 内存建议 IQ2/Q2，Q4 约 16.6GB 需要 24GB 以上内存或更多显存。',
    quants: [
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 7.21, match: 'Qwen3.8-27B-UD-IQ2_XXS', note: '最小档' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 9.95, match: 'Qwen3.8-27B-UD-Q2_K_XL' },
      { id: 'UD-Q3_K_XL', label: 'Q3_K_XL · 3-bit', bits: 3, gb: 13.15, match: 'Qwen3.8-27B-UD-Q3_K_XL' },
      { id: 'UD-Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 16.56, match: 'Qwen3.8-27B-UD-Q4_K_M', note: '需 24GB+' },
    ],
  },
  // ---- Kimi K2.6：官方 1T 开源权重；16GB 机器只能选社区 35B-A3B 蒸馏 ----
  {
    id: 'kimi-k2.6-1t',
    name: 'Kimi K2.6 1T',
    vendor: 'Moonshot',
    params: '1T-A32B',
    paramsB: 1000,
    arch: 'MoE',
    mode: 'moe',
    tag: '需 350GB+',
    tier: 1,
    repo: 'unsloth/Kimi-K2.6-GGUF',
    sourceRepo: 'moonshotai/Kimi-K2.6',
    license: 'Modified MIT',
    homepage: 'https://huggingface.co/moonshotai/Kimi-K2.6',
    note: 'Kimi K2.6 官方 1T 总参、32B 激活的 MoE，原生 256K 上下文。最小动态 2-bit 也要约 317GB 权重 + KV，16GB 内存跑不动；这里只作为完整目录与下载入口，不建议在本机启动。',
    quants: [
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 317.1, match: 'Kimi-K2.6-UD-Q2_K_XL', note: '最小档 · 需 350GB 内存' },
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 543.6, match: 'Kimi-K2.6-UD-Q4_K_XL', note: '需 600GB+' },
      { id: 'UD-Q8_K_XL', label: 'Q8_K_XL · 8-bit', bits: 8, gb: 553.7, match: 'Kimi-K2.6-UD-Q8_K_XL', note: '近无损' },
    ],
  },
  {
    id: 'kimi-k2.6-distill-35b-a3b',
    name: 'Kimi K2.6 Distill 35B-A3B',
    vendor: 'Moonshot',
    params: '35B-A3B',
    paramsB: 35,
    arch: 'MoE',
    mode: 'moe',
    tag: '轻量蒸馏',
    tier: 2,
    repo: 'deejayprime/Qwen3.6-35B-A3B-Kimi-K2.6-Reasoning-Distilled.IQ3_XXS.gguf',
    sourceRepo: 'lordx64/Qwen3.6-35B-A3B-Kimi-K2.6-Reasoning-Distilled',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/lordx64/Qwen3.6-35B-A3B-Kimi-K2.6-Reasoning-Distilled-GGUF',
    note: 'Kimi K2.6 推理蒸馏到 Qwen3.6 35B-A3B 的社区版，不是官方 1T 权重。IQ3_XXS 约 13.6GB，16GB 内存只能勉强跑，速度会明显低于 0.8B/2B；想在本机体验 K2.6 风格选它，想快仍用 Qwen3.5-0.8B。',
    quants: [
      { id: 'IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 13.62, match: 'Qwen3.6-35B-A3B-Kimi-K2.6-Reasoning-Distilled.IQ3_XXS', note: '16GB 极限' },
    ],
  },
  // ---- Kimi-VL A3B：官方视觉模型，16B 总参 / 2.8B 激活；不是 K2.6 ----
  {
    id: 'kimi-vl-a3b-2.8b',
    name: 'Kimi-VL A3B 2.8B 激活',
    vendor: 'Moonshot',
    params: '16B-A2.8B',
    paramsB: 16,
    arch: 'MoE',
    mode: 'moe',
    tag: '2.8B 激活 · 视觉',
    tier: 2,
    repo: 'ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF',
    sourceRepo: 'moonshotai/Kimi-VL-A3B-Thinking-2506',
    license: 'MIT',
    homepage: 'https://huggingface.co/ggml-org/Kimi-VL-A3B-Thinking-2506-GGUF',
    note: 'Kimi-VL A3B 是官方视觉语言模型，16B 总参、推理时只激活 2.8B；这是 Kimi 家族真正的 2.8B 激活档，不是 Kimi K2.6（K2.6 是 1T 总参 / 32B 激活）。Q4_K_M 约 10.5GB，16GB 内存可 CPU 跑但会慢；看图还需要额外 mmproj，本插件当前只使用文本部分。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 10.5, match: 'Kimi-VL-A3B-Thinking-2506-Q4_K_M', note: '16GB 内存可跑' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 17.0, match: 'Kimi-VL-A3B-Thinking-2506-Q8_0', note: '需 24GB+' },
    ],
  },
  // ---- 讯飞星火 Spark-X2.6：官方 GGUF，原生 1M 上下文；需要支持 Spark2_6 架构的运行时 ----
  {
    id: 'spark-x2.6-1.7b',
    name: 'Spark-X2.6 1.7B',
    vendor: 'Spark',
    params: '1.7B',
    paramsB: 1.7,
    arch: 'Dense',
    mode: 'dense',
    tag: '星火 · 1M 上下文',
    tier: 3,
    repo: 'XHToken/Spark-X2.6-1.7B-GGUF',
    sourceRepo: 'XHToken/Spark-X2.6-1.7B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/XHToken/Spark-X2.6-1.7B-GGUF',
    note: '讯飞星火 Spark-X2.6 1.7B 官方 GGUF，混合注意力、原生 1M 上下文、200+ 语言。Q4 约 1.77GB，是本机最现实的星火档；需要运行时支持 Spark2_6 架构。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 1.77, match: 'Spark-X2.6-1.7B-Q4_K_M', note: '推荐' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 1.82, match: 'Spark-X2.6-1.7B-Q8_0' },
    ],
  },
  {
    id: 'spark-x2.6-4b',
    name: 'Spark-X2.6 4B',
    vendor: 'Spark',
    params: '4B',
    paramsB: 4,
    arch: 'Dense',
    mode: 'dense',
    tag: '星火 · 1M 上下文',
    tier: 3,
    repo: 'XHToken/Spark-X2.6-4B-GGUF',
    sourceRepo: 'XHToken/Spark-X2.6-4B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/XHToken/Spark-X2.6-4B-GGUF',
    note: '星火 Spark-X2.6 4B 官方 GGUF，代码/智能体/长文本能力比 1.7B 强；Q4 约 3.54GB，16GB 内存可跑但比 1.7B 慢。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 3.54, match: 'Spark-X2.6-4B-Q4_K_M', note: '推荐' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 4.38, match: 'Spark-X2.6-4B-Q8_0' },
    ],
  },
  // ---- 老电脑 / 小内存优先：Qwen3.5 小尺寸全家桶 ----
  {
    id: 'qwen3.5-0.8b',
    name: 'Qwen3.5 0.8B',
    vendor: 'Qwen',
    params: '0.8B',
    paramsB: 0.8,
    arch: 'Dense',
    mode: 'dense',
    tag: '超轻量',
    tier: 3,
    repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    sourceRepo: 'Qwen/Qwen3.5-0.8B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.5-0.8B',
    note: '0.8B 稠密模型，4GB 内存的老机器也能跑；适合写作润色、简单问答和离线助手。',
    quants: [
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 0.32, match: 'Qwen3.5-0.8B-UD-IQ2_XXS', note: '最小档' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 0.39, match: 'Qwen3.5-0.8B-UD-Q2_K_XL' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 0.50, match: 'Qwen3.5-0.8B-Q4_K_M', note: '推荐' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 0.60, match: 'Qwen3.5-0.8B-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 0.76, match: 'Qwen3.5-0.8B-Q8_0', note: '画质优先' },
    ],
  },
  {
    id: 'qwen3.5-2b',
    name: 'Qwen3.5 2B',
    vendor: 'Qwen',
    params: '2B',
    paramsB: 2,
    arch: 'Dense',
    mode: 'dense',
    tag: '轻量',
    tier: 3,
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    sourceRepo: 'Qwen/Qwen3.5-2B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.5-2B',
    note: '2B 档在 8GB 内存的旧笔记本上很舒服，Q4 只要约 1.2GB，启动十几秒。',
    quants: [
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 0.72, match: 'Qwen3.5-2B-UD-IQ2_XXS', note: '最小档' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 0.90, match: 'Qwen3.5-2B-UD-Q2_K_XL' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 1.19, match: 'Qwen3.5-2B-Q4_K_M', note: '推荐' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 1.47, match: 'Qwen3.5-2B-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 1.87, match: 'Qwen3.5-2B-Q8_0', note: '画质优先' },
    ],
  },
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    vendor: 'Qwen',
    params: '4B',
    paramsB: 4,
    arch: 'Dense',
    mode: 'dense',
    tag: '轻量',
    tier: 3,
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    sourceRepo: 'Qwen/Qwen3.5-4B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.5-4B',
    note: '4B 是小内存机器上的甜点：Q4 约 2.5GB，8GB 内存可跑，质量明显比 2B 稳。',
    quants: [
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 1.42, match: 'Qwen3.5-4B-UD-IQ2_XXS', note: '最小档' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 1.82, match: 'Qwen3.5-4B-UD-IQ3_XXS' },
      { id: 'IQ4_XS', label: 'IQ4_XS · 4-bit', bits: 4, gb: 2.31, match: 'Qwen3.5-4B-IQ4_XS' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 2.55, match: 'Qwen3.5-4B-Q4_K_M', note: '推荐' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 3.28, match: 'Qwen3.5-4B-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 4.17, match: 'Qwen3.5-4B-Q8_0', note: '画质优先' },
    ],
  },
  {
    id: 'qwen3.5-9b',
    name: 'Qwen3.5 9B',
    vendor: 'Qwen',
    params: '9B',
    paramsB: 9,
    arch: 'Dense',
    mode: 'dense',
    tag: '均衡',
    tier: 3,
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    sourceRepo: 'Qwen/Qwen3.5-9B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.5-9B',
    note: '9B 稠密模型，Q4 约 5.3GB、Q8 约 8.9GB；16GB 内存的笔记本可以跑 Q8，是质量与速度的平衡点。',
    quants: [
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 2.97, match: 'Qwen3.5-9B-UD-IQ2_XXS', note: '最小档' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 3.74, match: 'Qwen3.5-9B-UD-IQ3_XXS' },
      { id: 'IQ4_XS', label: 'IQ4_XS · 4-bit', bits: 4, gb: 4.81, match: 'Qwen3.5-9B-IQ4_XS' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 5.29, match: 'Qwen3.5-9B-Q4_K_M', note: '日常推荐' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 6.95, match: 'Qwen3.5-9B-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 8.87, match: 'Qwen3.5-9B-Q8_0', note: '画质优先' },
    ],
  },
  {
    id: 'qwen3.5-27b',
    name: 'Qwen3.5 27B',
    vendor: 'Qwen',
    params: '27B',
    paramsB: 27,
    arch: 'Dense',
    mode: 'dense',
    tag: '高质量',
    tier: 2,
    repo: 'unsloth/Qwen3.5-27B-GGUF',
    sourceRepo: 'Qwen/Qwen3.5-27B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.5-27B',
    note: '27B 稠密模型，Q2 约 8GB、Q3 约 10.7GB；16GB 内存可跑 2/3-bit，质量比 9B 更高但速度更慢。',
    quants: [
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 7.98, match: 'Qwen3.5-27B-UD-IQ2_XXS', note: '最小档' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 10.72, match: 'Qwen3.5-27B-UD-IQ3_XXS', note: '16GB 内存可跑' },
      { id: 'IQ4_XS', label: 'IQ4_XS · 4-bit', bits: 4, gb: 13.95, match: 'Qwen3.5-27B-IQ4_XS', note: '吃紧' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 15.59, match: 'Qwen3.5-27B-Q4_K_M' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 20.91, match: 'Qwen3.5-27B-Q6_K' },
    ],
  },
  {
    id: 'qwen3.5-35b-a3b',
    name: 'Qwen3.5 35B-A3B',
    vendor: 'Qwen',
    params: '35B',
    paramsB: 35,
    arch: 'MoE',
    mode: 'moe',
    tag: 'MoE',
    tier: 2,
    repo: 'unsloth/Qwen3.5-35B-A3B-GGUF',
    sourceRepo: 'Qwen/Qwen3.5-35B-A3B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.5-35B-A3B',
    note: '35B MoE（每 token 约 3B 激活）。2-bit 约 10GB，16GB 内存可跑，速度快于同尺寸稠密模型。',
    quants: [
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 9.93, match: 'Qwen3.5-35B-A3B-UD-IQ2_XXS', note: '最小档' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 12.18, match: 'Qwen3.5-35B-A3B-UD-IQ3_XXS' },
      { id: 'UD-IQ4_XS', label: 'IQ4_XS · 4-bit', bits: 4, gb: 16.29, match: 'Qwen3.5-35B-A3B-UD-IQ4_XS', note: '吃紧' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 20.50, match: 'Qwen3.5-35B-A3B-Q4_K_M' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 26.87, match: 'Qwen3.5-35B-A3B-Q6_K' },
    ],
  },

  // ---- 大模型家族：给大内存/服务器用户，最小档也能在硬盘上流式尝试 ----
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    vendor: 'DeepSeek',
    params: '~700B',
    paramsB: 700,
    arch: 'MoE',
    mode: 'moe',
    tag: '旗舰',
    tier: 1,
    repo: 'unsloth/DeepSeek-V4-Pro-0813-GGUF',
    sourceRepo: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    license: 'MIT',
    homepage: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813',
    note: 'DeepSeek V4 Pro 的 4-bit/8-bit 分片都在 790GB 以上，只适合 1TB 内存级服务器；普通电脑可收藏但不要下载。',
    quants: [
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 791.33, match: 'UD-Q4_K_XL', note: '约 20 个分片' },
      { id: 'UD-Q8_K_XL', label: 'Q8_K_XL · 8-bit', bits: 8, gb: 813.46, match: 'UD-Q8_K_XL' },
    ],
  },
  {
    id: 'minimax-m3.1-flash',
    name: 'MiniMax M3.1 Flash',
    vendor: 'MiniMax',
    params: 'MoE',
    paramsB: 120,
    arch: 'MoE',
    mode: 'moe',
    tag: '大内存',
    tier: 1,
    repo: 'unsloth/MiniMax-M3.1-Flash-GGUF',
    sourceRepo: 'MiniMaxAI/MiniMax-M3.1-Flash',
    license: '见仓库',
    homepage: 'https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash',
    note: 'MiniMax M3.1 Flash 最小 1-bit 档约 120GB，需要 128GB 内存；普通电脑只能落盘收藏。',
    quants: [
      { id: 'UD-IQ1_M', label: 'IQ1_M · 1-bit', bits: 1, gb: 120.48, match: 'UD-IQ1_M', note: '最小档' },
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 125.68, match: 'UD-IQ2_XXS' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 149.06, match: 'UD-IQ3_XXS' },
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 232.27, match: 'UD-Q4_K_XL' },
    ],
  },
  {
    id: 'kimi-k3.1-pro',
    name: 'Kimi K3.1 Pro',
    vendor: 'Moonshot',
    params: 'MoE',
    paramsB: 300,
    arch: 'MoE',
    mode: 'moe',
    tag: '超大',
    tier: 1,
    repo: 'KarLexAI/Kimi-K3.1-Pro-GGUF',
    sourceRepo: 'moonshotai/Kimi-K3.1-Pro',
    license: '见仓库',
    homepage: 'https://huggingface.co/moonshotai/Kimi-K3.1-Pro',
    note: 'Kimi K3.1 Pro 最小的 1-bit 分片合计约 552GB，适合 768GB 内存工作站；本机只做目录展示。',
    quants: [
      { id: 'KLX-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 551.97, match: 'KLX-IQ1_S', note: '最小档' },
      { id: 'KLX-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 661.12, match: 'KLX-IQ2_XXS' },
    ],
  },

  // ---- 旧版目录保留，避免已有下载失效 ----
  {
    id: 'deepseek-v4.1-flash-1017',
    name: 'DeepSeek V4.1 Flash',
    vendor: 'DeepSeek',
    params: '763B',
    paramsB: 763,
    arch: 'MoE',
    mode: 'moe',
    tag: '旗舰',
    tier: 1,
    repo: 'unsloth/DeepSeek-V4.1-Flash-1017-GGUF',
    sourceRepo: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    license: 'MIT',
    homepage: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    note: '官方权重 763B MoE，本地跑需要 128GB 以上内存；本机只建议下载后在服务器/大内存机器上用。',
    quants: [
      { id: 'UD-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 217.0, match: 'UD-IQ1_S', note: '最小档' },
      { id: 'UD-IQ1_M', label: 'IQ1_M · 1-bit', bits: 1, gb: 233.2, match: 'UD-IQ1_M' },
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 279.8, match: 'UD-IQ2_XXS' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 311.8, match: 'UD-Q2_K_XL', note: '2-bit 均衡' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 367.6, match: 'UD-IQ3_XXS' },
      { id: 'UD-Q3_K_XL', label: 'Q3_K_XL · 3-bit', bits: 3, gb: 451.8, match: 'UD-Q3_K_XL', note: '3-bit 推荐' },
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 466.3, match: 'UD-Q4_K_XL', note: '画质优先' },
    ],
  },
  {
    id: 'qwen3.8-flash-next',
    name: 'Qwen3.8 Flash',
    vendor: 'Qwen',
    params: '177B',
    paramsB: 177,
    arch: 'MoE',
    mode: 'moe',
    tag: '大内存',
    tier: 2,
    repo: 'unsloth/Qwen3.8-Flash-Next-GGUF',
    sourceRepo: 'Qwen/Qwen3.8-Flash-Next',
    license: 'Qwen Community 1.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.8-Flash-Next',
    note: '177B MoE（每 token 约 6B 激活）。1-bit 约 62GB，64GB 内存的机器可以勉强流式跑。',
    quants: [
      { id: 'UD-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 61.8, match: 'UD-IQ1_S', note: '最小档' },
      { id: 'UD-IQ1_M', label: 'IQ1_M · 1-bit', bits: 1, gb: 63.3, match: 'UD-IQ1_M' },
      { id: 'UD-Q2_0', label: 'Q2_0 · 2-bit', bits: 2, gb: 65.7, match: 'UD-Q2_0' },
      { id: 'UD-IQ2_XS', label: 'IQ2_XS · 2-bit', bits: 2, gb: 70.6, match: 'UD-IQ2_XS' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 74.1, match: 'UD-Q2_K_XL', note: '2-bit 均衡' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 77.9, match: 'UD-IQ3_XXS' },
      { id: 'UD-Q3_K_XL', label: 'Q3_K_XL · 3-bit', bits: 3, gb: 83.3, match: 'UD-Q3_K_XL', note: '3-bit 推荐' },
      { id: 'UD-IQ4_XS', label: 'IQ4_XS · 4-bit', bits: 4, gb: 87.2, match: 'UD-IQ4_XS' },
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 103.7, match: 'UD-Q4_K_XL', note: '画质优先' },
    ],
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    vendor: 'Z.ai',
    params: '744B',
    paramsB: 744,
    arch: 'MoE',
    mode: 'moe',
    tag: '旗舰',
    tier: 1,
    repo: 'unsloth/GLM-5.3-Flash-GGUF',
    sourceRepo: 'zai-org/GLM-5.3-Flash',
    license: 'MIT',
    homepage: 'https://huggingface.co/zai-org/GLM-5.3-Flash',
    note: '744B MoE，最小 1-bit 档约 87GB，需要 128GB 级内存。',
    quants: [
      { id: 'UD-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 86.7, match: 'UD-IQ1_S', note: '最小档' },
      { id: 'UD-IQ1_M', label: 'IQ1_M · 1-bit', bits: 1, gb: 90.9, match: 'UD-IQ1_M' },
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 94.9, match: 'UD-IQ2_XXS' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 101.3, match: 'UD-Q2_K_XL' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 112.1, match: 'UD-IQ3_XXS' },
      { id: 'UD-Q3_K_XL', label: 'Q3_K_XL · 3-bit', bits: 3, gb: 137.4, match: 'UD-Q3_K_XL' },
      { id: 'UD-IQ4_XS', label: 'IQ4_XS · 4-bit', bits: 4, gb: 146.1, match: 'UD-IQ4_XS' },
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 186.0, match: 'UD-Q4_K_XL' },
    ],
  },
  {
    id: 'qwen3.8-27b',
    name: 'Qwen3.8 27B',
    vendor: 'Qwen',
    params: '27B',
    paramsB: 27,
    arch: 'Dense',
    mode: 'dense',
    tag: '轻量',
    tier: 3,
    repo: 'unsloth/Qwen3.8-27B-GGUF',
    sourceRepo: 'Qwen/Qwen3.8-27B',
    license: 'Qwen Community 1.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3.8-27B',
    note: '27B 稠密模型，Q2/Q3 档 16GB 内存的笔记本能跑，是这台机器上真正可用的日常档。',
    quants: [
      { id: 'UD-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 5.8, match: 'UD-IQ1_S' },
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 6.7, match: 'UD-IQ2_XXS' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 9.3, match: 'UD-Q2_K_XL', note: '2-bit 均衡' },
      { id: 'UD-IQ3_XXS', label: 'IQ3_XXS · 3-bit', bits: 3, gb: 10.2, match: 'UD-IQ3_XXS' },
      { id: 'UD-IQ3_S', label: 'IQ3_S · 3-bit', bits: 3, gb: 11.2, match: 'UD-IQ3_S' },
      { id: 'UD-Q3_K_XL', label: 'Q3_K_XL · 3-bit', bits: 3, gb: 12.2, match: 'UD-Q3_K_XL', note: '画质更稳，但吃紧' },
      { id: 'UD-IQ4_XS', label: 'IQ4_XS · 4-bit', bits: 4, gb: 13.4, match: 'UD-IQ4_XS' },
      { id: 'UD-Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 15.4, match: 'UD-Q4_K_M' },
      { id: 'UD-Q5_K_M', label: 'Q5_K_M · 5-bit', bits: 5, gb: 18.5, match: 'UD-Q5_K_M' },
      { id: 'UD-Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 27.1, match: 'UD-Q8_0' },
    ],
  },
  // ---- 腾讯混元 Hy4 / Hy4 Flash（2026-11 开源，社区 GGUF） ----
  {
    id: 'hunyuan-hy4',
    name: '混元4（Hy4）',
    vendor: 'Hunyuan',
    params: '770B',
    paramsB: 770,
    arch: 'MoE',
    mode: 'moe',
    tag: '旗舰',
    tier: 1,
    repo: 'AngelSlim/Hy4-GGUF',
    sourceRepo: 'tencent/Hy4',
    license: 'Tencent Hy License',
    homepage: 'https://huggingface.co/tencent/Hy4',
    note: '腾讯混元 Hy4（Hunyuan 4）旗舰版，770B MoE / 49B 激活、1M 上下文；GGUF 由社区转换，最小档约 215GB，只适合 256GB 以上内存的工作站。',
    quants: [
      { id: 'STQ1_0', label: 'STQ1_0 · 1-bit', bits: 1, gb: 214.65, match: 'Hy4-STQ1_0', note: '最小档' },
      { id: 'IQ2', label: 'IQ2 · 2-bit', bits: 2, gb: 309.58, match: 'Hy4-IQ2' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 437.93, match: 'Hy4-Q4_K_M', note: '画质优先' },
    ],
  },
  {
    id: 'hunyuan-hy4-flash',
    name: '混元4 Flash（Hy4 Flash）',
    vendor: 'Hunyuan',
    params: '224B-A12B',
    paramsB: 224,
    arch: 'MoE',
    mode: 'moe',
    tag: 'Flash',
    tier: 2,
    repo: 'AngelSlim/Hy4-flash-GGUF',
    sourceRepo: 'tencent/Hy4-flash',
    license: 'Tencent Hy License',
    homepage: 'https://huggingface.co/tencent/Hy4-flash',
    note: '混元 Hy4 Flash：224B 总参数（含 64B Engram）、每 token 约 12B 激活、1M 上下文；最小 2-bit 约 126GB，适合 128GB 内存、能接受硬盘流式加载的机器。',
    quants: [
      { id: 'IQ2_AH', label: 'IQ2_AH · 2-bit', bits: 2, gb: 125.73, match: 'Hy4-flash-IQ2_AH', note: '最小档' },
      { id: 'Q3_K', label: 'Q3_K · 3-bit', bits: 3, gb: 144.7, match: 'Hy4-flash-Q3_K' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 156.79, match: 'Hy4-flash-Q4_K_M', note: '画质优先' },
      { id: 'SPARK-4Bit', label: 'SPARK-4Bit · 4-bit', bits: 4, gb: 151.35, match: 'Hy4-flash-SPARK-4Bit.gguf', note: '社区优化档' },
    ],
  },

  // ---- DeepSeek R1 系列：经典 R1 与 0528 更新版 ----
  {
    id: 'deepseek-r1',
    name: 'DeepSeek R1',
    vendor: 'DeepSeek',
    params: '671B',
    paramsB: 671,
    arch: 'MoE',
    mode: 'moe',
    tag: '推理旗舰',
    tier: 1,
    repo: 'unsloth/DeepSeek-R1-GGUF',
    sourceRepo: 'deepseek-ai/DeepSeek-R1',
    license: 'MIT',
    homepage: 'https://huggingface.co/deepseek-ai/DeepSeek-R1',
    note: 'DeepSeek R1 经典推理模型，671B MoE；最小 1-bit 档约 131GB，建议 192GB 以上内存，普通电脑只适合目录展示或硬盘流式尝试。',
    quants: [
      { id: 'UD-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 130.6, match: 'UD-IQ1_S', note: '最小档' },
      { id: 'UD-IQ1_M', label: 'IQ1_M · 1-bit', bits: 1, gb: 157.32, match: 'UD-IQ1_M' },
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 182.69, match: 'UD-IQ2_XXS' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 211.04, match: 'UD-Q2_K_XL', note: '2-bit 均衡' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 376.65, match: 'Q4_K_M' },
    ],
  },
  {
    id: 'deepseek-r1-0528',
    name: 'DeepSeek R1 0528',
    vendor: 'DeepSeek',
    params: '671B',
    paramsB: 671,
    arch: 'MoE',
    mode: 'moe',
    tag: '推理新版',
    tier: 1,
    repo: 'unsloth/DeepSeek-R1-0528-GGUF',
    sourceRepo: 'deepseek-ai/DeepSeek-R1-0528',
    license: 'MIT',
    homepage: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-0528',
    note: 'DeepSeek R1-0528 是 R1 的 2025-05-28 更新版，推理更稳；671B MoE，最小 1-bit 约 173GB，适合 256GB 级工作站。',
    quants: [
      { id: 'UD-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 172.75, match: 'UD-IQ1_S', note: '最小档' },
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 201.89, match: 'UD-IQ2_XXS' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 233.86, match: 'UD-Q2_K_XL', note: '2-bit 均衡' },
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 357.63, match: 'UD-Q4_K_XL', note: '画质优先' },
    ],
  },

  // ---- DeepSeek R1 轻量蒸馏：15–25GB 内存的主力档 ----
  {
    id: 'deepseek-r1-distill-qwen-7b',
    name: 'DeepSeek R1 Distill Qwen 7B',
    vendor: 'DeepSeek',
    params: '7B',
    paramsB: 7,
    arch: 'Dense',
    mode: 'dense',
    tag: '推理轻量',
    tier: 3,
    repo: 'unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF',
    sourceRepo: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    license: 'MIT',
    homepage: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    note: 'R1 的 7B 蒸馏版，Q4 约 4.4GB、Q8 约 7.5GB；12–16GB 内存的轻薄本就能跑，适合数学、代码和分步推理。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 4.36, match: 'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M', note: '日常推荐' },
      { id: 'Q5_K_M', label: 'Q5_K_M · 5-bit', bits: 5, gb: 5.07, match: 'DeepSeek-R1-Distill-Qwen-7B-Q5_K_M' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 5.82, match: 'DeepSeek-R1-Distill-Qwen-7B-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 7.54, match: 'DeepSeek-R1-Distill-Qwen-7B-Q8_0', note: '质量优先' },
    ],
  },
  {
    id: 'deepseek-r1-distill-qwen-14b',
    name: 'DeepSeek R1 Distill Qwen 14B',
    vendor: 'DeepSeek',
    params: '14B',
    paramsB: 14,
    arch: 'Dense',
    mode: 'dense',
    tag: '推理均衡',
    tier: 2,
    repo: 'unsloth/DeepSeek-R1-Distill-Qwen-14B-GGUF',
    sourceRepo: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',
    license: 'MIT',
    homepage: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',
    note: '16GB 内存档的推理甜点：Q4 约 8.4GB、Q6 约 11.3GB、Q8 约 14.6GB；Q8 需要 24GB 左右内存才宽裕。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 8.37, match: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M', note: '16GB 内存推荐' },
      { id: 'Q5_K_M', label: 'Q5_K_M · 5-bit', bits: 5, gb: 9.79, match: 'DeepSeek-R1-Distill-Qwen-14B-Q5_K_M' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 11.29, match: 'DeepSeek-R1-Distill-Qwen-14B-Q6_K', note: '质量/体积平衡' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 14.62, match: 'DeepSeek-R1-Distill-Qwen-14B-Q8_0', note: '24GB 内存推荐' },
    ],
  },
  {
    id: 'deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek R1 Distill Qwen 32B',
    vendor: 'DeepSeek',
    params: '32B',
    paramsB: 32,
    arch: 'Dense',
    mode: 'dense',
    tag: '推理大杯',
    tier: 2,
    repo: 'unsloth/DeepSeek-R1-Distill-Qwen-32B-GGUF',
    sourceRepo: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
    license: 'MIT',
    homepage: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
    note: '32B 蒸馏版，Q4 约 18.5GB、Q5 约 21.7GB；24–32GB 内存可跑，16GB 机器会大量换页，不建议。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 18.49, match: 'DeepSeek-R1-Distill-Qwen-32B-Q4_K_M', note: '24GB 内存推荐' },
      { id: 'Q5_K_M', label: 'Q5_K_M · 5-bit', bits: 5, gb: 21.66, match: 'DeepSeek-R1-Distill-Qwen-32B-Q5_K_M', note: '32GB 内存更稳' },
    ],
  },
  {
    id: 'deepseek-r1-0528-qwen3-8b',
    name: 'DeepSeek R1 0528 Qwen3 8B',
    vendor: 'DeepSeek',
    params: '8B',
    paramsB: 8,
    arch: 'Dense',
    mode: 'dense',
    tag: '推理新版',
    tier: 3,
    repo: 'unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF',
    sourceRepo: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
    license: 'MIT',
    homepage: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
    note: 'R1-0528 的 Qwen3 8B 蒸馏，比老 7B 蒸馏更新；Q4 约 4.7GB、Q8 约 8.1GB，16GB 内存可跑 Q8。',
    quants: [
      { id: 'IQ4_XS', label: 'IQ4_XS · 4-bit', bits: 4, gb: 4.27, match: 'DeepSeek-R1-0528-Qwen3-8B-IQ4_XS' },
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 4.68, match: 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M', note: '推荐' },
      { id: 'Q5_K_M', label: 'Q5_K_M · 5-bit', bits: 5, gb: 5.45, match: 'DeepSeek-R1-0528-Qwen3-8B-Q5_K_M' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 6.26, match: 'DeepSeek-R1-0528-Qwen3-8B-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 8.11, match: 'DeepSeek-R1-0528-Qwen3-8B-Q8_0' },
    ],
  },
  {
    id: 'qwen3-14b',
    name: 'Qwen3 14B',
    vendor: 'Qwen',
    params: '14B',
    paramsB: 14,
    arch: 'Dense',
    mode: 'dense',
    tag: '通用 14B',
    tier: 2,
    repo: 'unsloth/Qwen3-14B-GGUF',
    sourceRepo: 'Qwen/Qwen3-14B',
    license: 'Apache-2.0',
    homepage: 'https://huggingface.co/Qwen/Qwen3-14B',
    note: 'Qwen3 14B 通用模型，Q4 约 8.4GB、Q8 约 14.6GB；写作、问答、代码都稳，16–24GB 内存档的主力。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 8.38, match: 'Qwen3-14B-Q4_K_M', note: '16GB 内存推荐' },
      { id: 'Q5_K_M', label: 'Q5_K_M · 5-bit', bits: 5, gb: 9.79, match: 'Qwen3-14B-Q5_K_M' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 11.29, match: 'Qwen3-14B-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 14.62, match: 'Qwen3-14B-Q8_0', note: '24GB 内存推荐' },
    ],
  },
  {
    id: 'phi-4-14b',
    name: 'Phi-4 14B',
    vendor: 'Microsoft',
    params: '14B',
    paramsB: 14,
    arch: 'Dense',
    mode: 'dense',
    tag: '推理通用',
    tier: 2,
    repo: 'unsloth/Phi-4-GGUF',
    sourceRepo: 'microsoft/phi-4',
    license: 'MIT',
    homepage: 'https://huggingface.co/microsoft/phi-4',
    note: '微软 Phi-4 14B，Q4 约 8.3GB、Q8 约 14.5GB；数学和代码强，15–24GB 内存档可跑。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 8.28, match: 'phi-4-Q4_K_M', note: '16GB 内存推荐' },
      { id: 'Q5_K_M', label: 'Q5_K_M · 5-bit', bits: 5, gb: 9.70, match: 'phi-4-Q5_K_M' },
      { id: 'Q6_K', label: 'Q6_K · 6-bit', bits: 6, gb: 11.20, match: 'phi-4-Q6_K' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 14.51, match: 'phi-4-Q8_0', note: '24GB 内存推荐' },
    ],
  },

  // ---- Meta Llama 4：Scout（109B-A17B）与 Maverick（400B-A17B） ----
  {
    id: 'llama-4-scout',
    name: 'Llama 4 Scout',
    vendor: 'Meta',
    params: '109B-A17B',
    paramsB: 109,
    arch: 'MoE',
    mode: 'moe',
    tag: 'MoE',
    tier: 2,
    repo: 'unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF',
    sourceRepo: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    license: 'Llama 4 Community License',
    homepage: 'https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct',
    note: 'Llama 4 Scout：109B 总参数、17B 激活，16 个专家；最小 1-bit 约 30GB，32GB 内存可尝试，16GB 机器需要硬盘流式。',
    quants: [
      { id: 'UD-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 30.24, match: 'UD-IQ1_S', note: '最小档' },
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 34.83, match: 'UD-IQ2_XXS' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 39.47, match: 'UD-Q2_K_XL', note: '2-bit 均衡' },
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 57.74, match: 'UD-Q4_K_XL', note: '画质优先' },
    ],
  },
  {
    id: 'llama-4-maverick',
    name: 'Llama 4 Maverick',
    vendor: 'Meta',
    params: '400B-A17B',
    paramsB: 400,
    arch: 'MoE',
    mode: 'moe',
    tag: '旗舰',
    tier: 1,
    repo: 'unsloth/Llama-4-Maverick-17B-128E-Instruct-GGUF',
    sourceRepo: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
    license: 'Llama 4 Community License',
    homepage: 'https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct',
    note: 'Llama 4 Maverick：400B 总参数、17B 激活，128 个专家；最小 1-bit 约 112GB，建议 128GB 以上内存。',
    quants: [
      { id: 'UD-IQ1_S', label: 'IQ1_S · 1-bit', bits: 1, gb: 112.48, match: 'UD-IQ1_S', note: '最小档' },
      { id: 'UD-IQ2_XXS', label: 'IQ2_XXS · 2-bit', bits: 2, gb: 125.91, match: 'UD-IQ2_XXS' },
      { id: 'UD-Q2_K_XL', label: 'Q2_K_XL · 2-bit', bits: 2, gb: 142.17, match: 'UD-Q2_K_XL', note: '2-bit 均衡' },
      { id: 'UD-Q4_K_XL', label: 'Q4_K_XL · 4-bit', bits: 4, gb: 216.19, match: 'UD-Q4_K_XL', note: '画质优先' },
    ],
  },

  // ---- 面壁智能 MiniCPM5：端侧 1B / 2B ----
  {
    id: 'minicpm5-1b',
    name: 'MiniCPM5 1B',
    vendor: 'OpenBMB',
    params: '1B',
    paramsB: 1,
    arch: 'Dense',
    mode: 'dense',
    tag: '超轻量',
    tier: 3,
    repo: 'openbmb/MiniCPM5-1B-GGUF',
    sourceRepo: 'OpenBMB/MiniCPM5-1B',
    license: '见仓库',
    homepage: 'https://huggingface.co/openbmb/MiniCPM5-1B',
    note: 'MiniCPM5 1B 端侧小模型，Q4 约 0.64GB、Q8 约 1.07GB；4GB 内存的老电脑也能跑，适合离线问答、写作润色和轻量 Agent。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 0.64, match: 'MiniCPM5-1B-Q4_K_M', note: '推荐' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 1.07, match: 'MiniCPM5-1B-Q8_0', note: '画质优先' },
    ],
  },
  {
    id: 'minicpm5-2b',
    name: 'MiniCPM5 2B',
    vendor: 'OpenBMB',
    params: '2B',
    paramsB: 2,
    arch: 'Dense',
    mode: 'dense',
    tag: '轻量',
    tier: 3,
    repo: 'openbmb/MiniCPM5-2B-GGUF',
    sourceRepo: 'OpenBMB/MiniCPM5-2B',
    license: '见仓库',
    homepage: 'https://huggingface.co/openbmb/MiniCPM5-2B',
    note: 'MiniCPM5 2B 端侧模型，Q4 约 1.45GB、Q8 约 2.5GB；8GB 内存的旧笔记本可以流畅运行。',
    quants: [
      { id: 'Q4_K_M', label: 'Q4_K_M · 4-bit', bits: 4, gb: 1.45, match: 'MiniCPM5-2B-Q4_K_M', note: '推荐' },
      { id: 'Q8_0', label: 'Q8_0 · 8-bit', bits: 8, gb: 2.5, match: 'MiniCPM5-2B-Q8_0', note: '画质优先' },
    ],
  },
];

function normalizeDiscovered(f) {
  if (!f || !f.repo || !Array.isArray(f.quants) || !f.quants.length) return null;
  const id = String(f.id || f.repo.replace(/[^a-zA-Z0-9]/g, '-')).toLowerCase();
  return {
    id,
    name: String(f.name || f.repo.split('/').pop().replace(/-GGUF$/i, '')),
    vendor: String(f.vendor || '在线更新'),
    params: String(f.params || '—'),
    paramsB: Number(f.paramsB) || 7,
    arch: String(f.arch || 'GGUF'),
    mode: String(f.mode || 'dense'),
    tag: String(f.tag || '在线新增'),
    tier: Number(f.tier) || 2,
    repo: String(f.repo),
    sourceRepo: String(f.sourceRepo || f.repo),
    license: String(f.license || '见仓库'),
    homepage: String(f.homepage || ('https://huggingface.co/' + f.repo)),
    note: String(f.note || '在线模型库更新发现的 GGUF 仓库，已缓存到本机。'),
    discovered: true,
    quants: f.quants.map((q) => ({
      id: String(q.id),
      label: String(q.label || q.id),
      bits: Number(q.bits) || 4,
      gb: Number(q.gb) || 0,
      match: String(q.match || q.id),
      note: String(q.note || ''),
    })),
  };
}

/** 自定义条目：面板里只填最少字段，其余给默认值。 */
function normalizeCustom(c) {
  if (!c || !c.repo) return null;
  const id = String(c.id || c.repo.replace(/[^a-zA-Z0-9]/g, '-')).toLowerCase();
  const gb = Number(c.gb) || 0;
  return {
    id,
    name: String(c.name || c.repo.split('/').pop() || id),
    vendor: '自定义',
    params: String(c.params || '—'),
    paramsB: Number(c.paramsB) || 7,
    arch: 'GGUF',
    mode: String(c.mode || 'dense'),
    tag: '自定义',
    tier: 3,
    repo: String(c.repo),
    sourceRepo: String(c.sourceRepo || c.repo),
    license: '见仓库',
    homepage: `https://huggingface.co/${c.repo}`,
    note: String(c.note || '自定义 HuggingFace GGUF 仓库'),
    custom: true,
    quants: [
      {
        id: String(c.quant || 'custom'),
        label: String(c.quantLabel || c.quant || '自定义量化'),
        bits: Number(c.bits) || 4,
        gb,
        match: String(c.match || c.quant || ''),
        note: '',
      },
    ],
  };
}

export function findFamily(id, custom = [], extra = []) {
  return allFamilies(custom, extra).find((f) => f.id === id) || null;
}

export function allFamilies(custom = [], extra = []) {
  const discovered = (Array.isArray(extra) ? extra : []).map(normalizeDiscovered).filter(Boolean);
  const extraModels = (Array.isArray(custom) ? custom : []).map(normalizeCustom).filter(Boolean);
  // 静态目录优先；在线更新与自定义只补充不覆盖。
  const seen = new Set(FAMILIES.map((f) => f.id));
  const merged = [...FAMILIES];
  for (const f of [...discovered, ...extraModels]) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    merged.push(f);
  }
  return merged;
}

/** 量化档的"能跑程度"，按 显存 > 内存 > 只能落盘 > 装不下 排序。 */
export function assessQuant(family, quant, hw, diskFreeGB) {
  const gb = Number(quant.gb) || 0;
  const vram = Number(hw?.vramGB) || 0;
  const ram = Number(hw?.ramGB) || 0;
  const disk = Number(diskFreeGB) || 0;
  const needVram = round1(gb * 1.06 + 1.2);
  const needRam = round1(gb * (family.mode === 'moe' ? 0.92 : 1.04) + 2.0);
  const needDisk = round1(gb * 1.12 + 1.0);
  let fit = 'no';
  if (gb > 0 && vram >= needVram) fit = 'gpu';
  else if (gb > 0 && ram >= needRam) fit = 'ram';
  else if (gb > 0 && disk >= needDisk) fit = 'disk';
  const tight = fit === 'ram' && needRam > ram * 0.86;
  return {
    fit,
    tight,
    needVramGB: needVram,
    needRamGB: needRam,
    needDiskGB: needDisk,
    reason:
      fit === 'gpu'
        ? `显存 ${vram}GB 可全量放下（约需 ${needVram}GB）`
        : fit === 'ram'
          ? `内存 ${ram}GB ${tight ? '刚够、建议关掉其他程序' : '可跑'}（约需 ${needRam}GB）`
          : fit === 'disk'
            ? `内存不足，只能落盘后靠 mmap 流式读取（会很慢，约需 ${needRam}GB 内存）`
            : `磁盘空间不足（约需 ${needDisk}GB，当前可用 ${disk}GB）`,
  };
}

const BIT_SCORE = { 1: 50, 2: 64, 3: 75, 4: 86, 5: 92, 6: 95, 8: 97 };
function qualityScore(family, quant) {
  const bits = Math.min(8, Math.max(1, Number(quant.bits) || 2));
  const bitScore = BIT_SCORE[bits] || 60;
  // 参数量的权重用 log2：0.8B 不再因为"能塞进 2GB 显存"就压过 9B。
  const familyBonus = Math.round(Math.log2(Math.max(0.5, Number(family.paramsB) || 7)) * 8);
  return bitScore + familyBonus;
}

/** 给整套目录打上本机适配标签，并按"能跑 + 质量"给出推荐。 */
export function evaluate(hw, diskFreeGB, custom = [], extra = []) {
  const families = allFamilies(custom, extra).map((f) => {
    const quants = f.quants.map((q) => ({ ...q, ...assessQuant(f, q, hw, diskFreeGB) }));
    const order = { gpu: 3, ram: 2, disk: 1, no: 0 };
    const best = quants.reduce((a, b) => (order[b.fit] > order[a.fit] ? b : a), quants[0]);
    return { ...f, quants, bestFit: best ? best.fit : 'no' };
  });
  const candidates = [];
  for (const f of families) {
    for (const q of f.quants) {
      if (q.fit !== 'gpu' && q.fit !== 'ram') continue;
      const score = qualityScore(f, q) + (q.fit === 'gpu' ? 6 : 0) - (q.tight ? 8 : 0);
      candidates.push({ familyId: f.id, quantId: q.id, score, fit: q.fit, tight: q.tight, family: f, quant: q });
    }
  }
  let best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best) {
    // 一台机器全都装不下：挑一个"能落盘"里最小的，明确提示只能下载、跑不动。
    const fallback = families
      .flatMap((f) => f.quants.map((q) => ({ family: f, quant: q })))
      .filter((x) => x.quant.fit === 'disk')
      .sort((a, b) => a.quant.gb - b.quant.gb)[0];
    if (fallback) best = { ...fallback, familyId: fallback.family.id, quantId: fallback.quant.id, fit: 'disk', tight: false, score: 0 };
  }
  if (!best) return { families, recommended: null };
  return {
    families,
    recommended: {
      familyId: best.family.id,
      quantId: best.quant.id,
      name: best.family.name,
      label: best.quant.label,
      gb: best.quant.gb,
      fit: best.fit,
      tight: best.tight,
      reason:
        best.fit === 'gpu'
          ? `显存够，${best.family.name} ${best.quant.label} 可全量放显卡`
          : best.fit === 'ram'
            ? `${best.family.name} ${best.quant.label} 约 ${best.quant.gb}GB，本机内存可跑${best.tight ? '（偏紧，建议关掉其他应用）' : ''}`
            : `本机跑不动任何量化档，只能先下载 ${best.family.name} ${best.quant.label}`,
    },
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 给"下载并启动"用：找到某档在目录里的完整描述。 */
export function describe(familyId, quantId, custom = [], extra = []) {
  const f = findFamily(familyId, custom, extra);
  if (!f) throw new Error(`没有这个模型：${familyId}`);
  const q = f.quants.find((x) => x.id === quantId);
  if (!q) throw new Error(`${f.name} 没有这个量化档：${quantId}`);
  return { family: f, quant: q };
}
