# Changelog - 管家模式自定义语音链路

## feat/guanjia-voice (2026-02-23)

基于 open-xiaoai 实现"你好管家"自定义语音助手，与小爱原生"小爱同学"双模式并行。

### 架构

```
"你好管家" → KWS → start_recording → 提示音 → 录音流 → FunASR(本地ASR) → OpenClaw → TTS回复
"小爱同学" → 原生小爱链路（不受影响）
```

详细架构图见 [docs/guanjia-voice-architecture.md](../../docs/guanjia-voice-architecture.md)

### 改动文件

#### Rust Server (`src/lib.rs`)
- 新增 `start_recording()` 导出函数 — 通过 RPC 调用 Client 端开始录音
- 新增 `stop_recording()` 导出函数 — 通过 RPC 调用 Client 端停止录音
- 原有 `start`, `run_shell`, `on_output_data` 不变

#### FunASR 客户端 (`migpt/funasr.ts`) — 新文件
- FunASR WebSocket 客户端，每次识别一个连接
- 支持 `offline` / `online` / `2pass` 三种模式
- 流式发送音频块，实时接收中间结果
- `finishAudio()` 发送结束标记，等待最终识别结果
- 完整错误处理和连接管理

#### 引擎改造 (`migpt/xiaoai.ts`)
- 新增 `GuanjiaConfig` 配置接口（FunASR 地址、录音时长、静音超时等）
- KWS 事件处理：检测到"管家"唤醒词 → `startGuanjiaMode()`
- 管家模式全链路：
  1. 创建 FunASR 会话
  2. RPC `start_recording` 开始录音
  3. TTS 播放提示音"请说"
  4. 录音流实时转发给 FunASR（`onRecord` 回调）
  5. 静音超时(3s) + 最大录音时长(15s) 双保护
  6. ASR 最终结果 → `onMessage` 交给 OpenClaw 处理
  7. OpenClaw 回复通过 TTS 播放
  8. `finally` 确保资源清理（停止录音、关闭 ASR 会话、清除定时器）
- 小爱原生 ASR 结果仅打日志，不干预

#### 配置 (`config.ts`)
- 新增 `guanjia` 配置块：
  - `funasr.url`: FunASR WebSocket 地址（默认 `ws://127.0.0.1:10095`）
  - `funasr.mode`: 识别模式（默认 `2pass`）
  - `maxRecordingMs`: 最大录音时长（默认 15s）
  - `silenceTimeoutMs`: 静音超时（默认 3s）
  - `promptText`: 提示音文字（默认"请说"）

#### 依赖 (`package.json`)
- 新增 `ws` (WebSocket 客户端，FunASR 通信用)
- 新增 `@types/ws` (开发依赖)

#### 唤醒词 (`examples/kws/keywords.txt`)
- "你好管家"双拼音变体配置

### 前置依赖

- **FunASR Docker**: 需在 MEmini 上部署 FunASR 服务（paraformer-zh 模型），监听 `ws://127.0.0.1:10095`
- **OpenClaw API**: 已在 `http://127.0.0.1:18789/v1` 运行
- **音箱端**: Client + KWS 已部署，无需改动
