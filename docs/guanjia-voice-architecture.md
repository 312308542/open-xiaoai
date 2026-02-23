# 🏠 "你好管家" 自定义语音助手架构方案

## 一、整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    小爱音箱 (OH2P)                        │
│                                                          │
│  ┌─────┐    ┌────────┐    ┌────────────────────────┐    │
│  │ KWS │───▶│ Client │───▶│ WebSocket ws://:4399   │    │
│  └─────┘    │ (Rust) │◀───│                        │    │
│             │        │    └────────────────────────┘    │
│             │ arecord│──── 录音流 (PCM 16kHz) ────▶     │
│             │ aplay  │◀─── 播放流 (PCM 16kHz) ────      │
│             │ ubus   │──── TTS (tts_play.sh) ────▶     │
│             └────────┘                                   │
└──────────────────────────┬───────────────────────────────┘
                           │ WebSocket (LAN)
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   MEmini (192.168.1.249)                  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Server (Node.js / migpt)                │   │
│  │                                                    │   │
│  │  1. 收到 KWS 事件 → 进入管家模式                    │   │
│  │  2. RPC: start_recording → Client 开始录音          │   │
│  │  3. RPC: tts_play.sh "请说" → 播放提示音            │   │
│  │  4. 收到录音流 → 转发给 FunASR                      │   │
│  │  5. ASR 返回文字 → RPC: stop_recording              │   │
│  │  6. 文字 → OpenClaw API → 得到回复                  │   │
│  │  7. RPC: tts_play.sh "回复内容" → 播放回复          │   │
│  └──────────┬──────────────────┬─────────────────────┘   │
│             │                  │                          │
│             ▼                  ▼                          │
│  ┌──────────────┐   ┌──────────────────┐                │
│  │   FunASR     │   │  OpenClaw API    │                │
│  │  (本地ASR)   │   │  127.0.0.1:18789 │                │
│  │  WebSocket   │   │                  │                │
│  │  :10095      │   │  → Home Assistant│                │
│  └──────────────┘   │  → 通用对话      │                │
│                     └──────────────────┘                │
└─────────────────────────────────────────────────────────┘
```

## 二、双链路并行（互不干扰）

| 链路 | 唤醒词 | ASR | NLP | TTS |
|------|--------|-----|-----|-----|
| 小爱原生 | "小爱同学" | 小爱云端 ASR | 小爱 NLP | 小爱 TTS |
| 管家自定义 | "你好管家" (KWS) | FunASR (本地) | OpenClaw API | 小爱 TTS (tts_play.sh) |

两条链路完全独立：
- "小爱同学" 走原生流程，我们不碰
- "你好管家" 走我们自己的 KWS → 录音 → FunASR → OpenClaw → TTS

## 三、数据流详解

### 3.1 唤醒阶段
```
用户说 "你好管家"
  → KWS (zipformer2) 检测到唤醒词
  → 写入 /tmp/open-xiaoai/kws.log
  → Client KwsMonitor 读取
  → WebSocket 发送 Event { event: "kws", data: "Keyword(你好管家)" }
  → Server 收到 onEvent → 进入管家模式
```

### 3.2 录音阶段
```
Server 进入管家模式:
  → RPC call_remote("start_recording") → Client 启动 arecord
  → RPC run_shell("tts_play.sh '请说'") → 播放提示音
  → Client arecord 持续采集 PCM 音频
  → 通过 WebSocket Stream { tag: "record", bytes } 发送到 Server
  → Server on_stream("record") 收到音频流
  → 转发给 FunASR WebSocket
```

### 3.3 识别阶段
```
FunASR 实时返回识别结果:
  → 中间结果 (is_final=false): 可选展示
  → 最终结果 (is_final=true): 得到完整文字
  → Server RPC call_remote("stop_recording") → 停止录音
```

### 3.4 处理 + 回复阶段
```
Server 拿到文字:
  → POST http://127.0.0.1:18789/v1/chat/completions
  → OpenClaw 处理（可能调用 HA 控制设备）
  → 得到回复文字
  → RPC run_shell("tts_play.sh '回复内容'") → 音箱播放
  → 管家模式结束，等待下次唤醒
```

## 四、需要改动的组件

### 4.1 FunASR 部署（新增）
- **位置**: MEmini Docker 容器
- **模型**: paraformer-zh (离线，中文优化)
- **接口**: WebSocket ws://127.0.0.1:10095
- **资源**: ~500MB 内存，CPU 推理
- **音频格式**: PCM 16kHz 16bit 单声道（与 Client arecord 输出一致）

### 4.2 Server 端改动（xiaoai.ts）
现有代码改动点：
```
onEvent 中 kws 事件处理:
  - 现在: 设置 _kwsActivated = true，等 instruction.log
  - 改为: 主动 start_recording + 播提示音 + 收音频流 + 发 FunASR

去掉: 对 instruction.log RecognizeResult 的依赖（管家模式不再需要）
保留: instruction.log 监听（小爱模式日志用）
新增: FunASR WebSocket 客户端
新增: 音频流缓冲 + VAD 静音检测（判断用户说完了）
```

### 4.3 音箱端（无改动）
- Client 二进制不需要改，start_recording / stop_recording RPC 已内置
- KWS 保留，唤醒词检测不变
- init.sh 只启动 client + kws（去掉 monitor）

### 4.4 OpenClaw API（无改动）
- 已经在 127.0.0.1:18789 运行
- 已有 HA skill，设备控制已验证

## 五、VAD（语音活动检测）策略

用户说完话后需要自动停止录音，两种方案：

**方案 A: FunASR 内置 VAD（推荐）**
- FunASR 的 2pass 模式自带 VAD
- 检测到静音自动返回 is_final=true
- Server 收到 final 结果后 stop_recording

**方案 B: 简单超时**
- 开始录音后设 10 秒超时
- 超时自动 stop_recording + 把已有音频发 FunASR
- 简单但不够智能

## 六、实施步骤

### 第一步：部署 FunASR（~30分钟）
1. Docker 拉取 FunASR runtime 镜像
2. 启动 WebSocket 服务（端口 10095）
3. 验证：发送测试音频，确认返回识别结果

### 第二步：改造 Server 端（~1-2小时）
1. 新增 FunASR WebSocket 客户端模块
2. 改造 xiaoai.ts 的 kws 事件处理逻辑
3. 实现录音流 → FunASR 转发
4. 实现 ASR 结果 → OpenClaw → TTS 回复

### 第三步：更新音箱 init.sh（~5分钟）
1. 去掉 monitor 启动
2. 只保留 client + kws

### 第四步：端到端测试
1. "你好管家" → 提示音 → 说指令 → ASR → 回复
2. "小爱同学" → 原生流程不受影响
3. 压力测试：连续唤醒、长句识别、设备控制

## 七、资源评估

| 组件 | CPU | 内存 | 磁盘 |
|------|-----|------|------|
| FunASR (paraformer-zh) | 推理时 ~1核 | ~500MB | ~1GB 模型 |
| Server (Node.js) | 低 | ~100MB | 已部署 |
| KWS (音箱端) | ~10% | ~45MB | 已部署 |
| Client (音箱端) | 低 | ~30MB | 已部署 |

MEmini (N200 4核 11GB) 完全够用。FunASR 只在说话时推理，空闲时几乎不占 CPU。

## 八、后续优化方向

1. **连续对话**: 管家回复后自动进入下一轮录音，不需要再说唤醒词
2. **流式 TTS**: 用 Edge TTS 流式合成 + start_play 推音频流，减少首字延迟
3. **Realtime API**: 对接 OpenAI Realtime API，实现真正的语音对语音
4. **KWS 防误触**: TTS 播放时暂停 KWS，避免回复声音触发唤醒
