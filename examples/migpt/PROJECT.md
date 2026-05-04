# 小爱音箱语音助手（管家模式）— 项目文档

## 一、需求概述

将小爱音箱 Pro（LX06/OH2P）改造为智能语音助手，实现：
- 唤醒词"你好管家"激活自定义语音助手（不走小爱原生链路）
- 语音 → ASR 转文字 → 意图识别（本地规则/小模型） → 设备控制/LLM 对话 → TTS 语音回复
- 全链路在本地 MEmini 服务器完成，不依赖云端

## 二、系统架构

```
用户说话
  ↓
小爱音箱 KWS（sherpa-onnx zipformer2）→ 检测唤醒词"你好管家"
  ↓
Client（Rust）→ WebSocket → Server（MEmini）
  ↓
FunASR（本地 ASR，ws://127.0.0.1:10095）→ 文字
  ↓
意图识别（本地正则 → 小模型 → OpenClaw 大模型兜底）
  ↓
Home Assistant REST API（设备控制）/ OpenClaw LLM（对话）
  ↓
Edge TTS / 小爱原生 TTS → 语音播报
```

## 三、硬件与网络

| 设备 | 型号 | IP | 说明 |
|------|------|-----|------|
| 主服务器 | MEmini（N200 4核，11GB RAM） | 192.168.1.249 | 运行 Server + FunASR + OpenClaw + HAOS |
| 小爱音箱 | Pro（LX06/OH2P） | 192.168.1.29 | 运行 Client + KWS + Monitor |
| 路由器 | — | 192.168.1.1 | 5G WiFi 局域网 |

## 四、代码目录结构

### Server 端（MEmini）
```
/data/open-xiaoai/examples/migpt/
├── config.ts              — 运行时配置（OpenClaw API、FunASR、管家参数）
├── migpt/
│   ├── index.ts           — 入口
│   ├── xiaoai.ts          — 核心引擎（管家模式全链路、事件处理）
│   ├── speaker.ts         — TTS/录音/shell 封装
│   ├── funasr.ts          — FunASR WebSocket 客户端
│   ├── intent.ts          — 本地规则意图识别
│   ├── devices.json       — 设备映射表
│   └── open-xiaoai.node   — 编译后的 Rust Neon binding
├── src/                   — Rust 源码（Server RPC、录音、播放）
├── package.json
└── Cargo.toml
```

### Client 端（小爱音箱）
```
/data/open-xiaoai/
├── client                 — Rust Client 二进制（连接 Server WebSocket）
├── server.txt             — Server 地址：ws://192.168.1.249:4399
└── kws/
    ├── kws                — KWS 唤醒词检测二进制（sherpa-onnx zipformer2）
    ├── monitor            — KWS 事件监听二进制（读取 kws.log，触发原生 ASR）
    ├── monitor.sh         — 自定义 shell 版 monitor（已废弃，会崩 client）
    ├── models/            — KWS 模型文件（encoder/decoder/joiner/tokens）
    ├── keywords.txt       — 唤醒词拼音配置
    └── reply.txt          — 提示语文本
```

## 五、关键文件说明

### `migpt/xiaoai.ts` — 核心引擎
- `startGuanjiaMode()`：管家模式全链路入口
- `onEvent()`：处理 kws、playing、instruction 事件
- `onRecord()`：接收音频流转发给 FunASR
- 流程：kws 事件 → abort 小爱 → FunASR 连接 → TTS 提示 → 录音 → ASR → 意图 → LLM/HA → TTS 回复

### `migpt/funasr.ts` — ASR 客户端
- `start()`：建立 WebSocket 连接，等就绪后返回
- `sendAudio()`：发送 PCM 音频数据
- `finishAudio()`：通知音频结束
- `waitForResult()`：等待最终识别结果
- 协议：`{"action":"start"}` → 二进制 PCM → `{"action":"end"}` → `{"text":"xxx","is_final":true}`

### `config.ts` — 配置
```typescript
openai: {
  baseURL: "http://127.0.0.1:18789/v1",  // OpenClaw OpenAI 兼容 API
  apiKey: "xxx",
  model: "openclaw",                       // ⚠️ 必须是 "openclaw"
},
guanjia: {
  funasr: { url: "ws://127.0.0.1:10095" },
  maxRecordingMs: 15000,
  silenceTimeoutMs: 2000,
  promptText: "请说",
},
```

## 六、外部服务依赖

| 服务 | 地址 | 状态 | 说明 |
|------|------|------|------|
| OpenClaw Gateway | http://127.0.0.1:18789/v1 | ✅ 运行中 | OpenAI 兼容 API，model 用 `openclaw` |
| FunASR | ws://127.0.0.1:10095 | ✅ 运行中 | 本地 ASR，paraformer-zh 模型，RTF 0.081 |
| Home Assistant | http://192.168.1.249:8123/api | ✅ 运行中 | 设备控制，token 在 ~/.config/home-assistant/config.json |
| mico_aivs_lab | 音箱端 | 运行中 | 小爱原生 ASR/TTS 服务 |

## 七、当前进展（2026-05-04）

### ✅ 已完成
1. **Server 端代码** — 管家模式全链路代码编写完成
2. **FunASR 部署** — 本地 ASR 服务运行正常（Python 3.12 虚拟环境，端口 10095）
3. **LLM 对接** — OpenClaw OpenAI 兼容 API 已配置（model 必须用 `openclaw`）
4. **端到端链路跑通** — 从唤醒词到语音回复的完整链路已验证
5. **Bug 修复**：
   - FunASR 时序：`start()` 改为等 WebSocket 就绪后返回
   - LLM model 配置：改为 `openclaw`
   - KWS 事件转发：client 重启后恢复

### 🔧 链路验证结果（21:46 测试）
```
🔥 唤醒词识别: 你好管家          ← KWS ✅
🏠 [管家模式] 启动               ← 管家激活 ✅
🏠 [FunASR] 连接就绪             ← ASR 就绪 ✅
🏠 [录音] 已开始                 ← 录音 ✅
🏠 [ASR 最终] ...你是谁？        ← 转文字 ✅（有噪音）
🏠 [OpenClaw] 发送               ← 下发 LLM ✅
🔊 浩哥好！我是你家的智能管家     ← 语音回复 ✅
🏠 [管家模式] 结束               ← 循环结束 ✅
```

## 八、已知问题

### 问题 1：TTS 自回声（严重）
- **现象**：ASR 结果混入 TTS 播报文字，如 "请问有什么吩咐你是谁"
- **原因**：播放"请说"提示音时，麦克风录到了音箱自己的声音
- **方案**：去掉 TTS 提示音，改用静音或短 beep；或增加更长的延迟
- **文件**：`migpt/xiaoai.ts` 第 2 步 play()

### 问题 2：小爱原生链路干扰（严重）
- **现象**：唤醒后小爱原生 ASR 也同时处理，导致双重播报
- **原因**：音箱端 `monitor` 二进制检测到唤醒词后调用 `event:0`，触发原生 ASR
- **已尝试**：`abortXiaoAI()` 重启 mico_aivs_lab，但太慢来不及
- **方案**：
  - A. 修改音箱端 mico_aivs_lab 配置，禁用原生唤醒
  - B. 用 ubus 命令直接取消正在进行的 ASR/TTS
  - C. 在音箱端用 iptables 阻断小爱云端连接（不推荐）

### 问题 3：不能替换 monitor 二进制（重要教训）
- **现象**：将 `monitor` 替换为 shell 脚本后，client 的 Rust 代码崩溃（ParseIntError）
- **原因**：client 会解析 monitor 的 stdout 输出，格式不匹配导致 panic
- **结论**：monitor 必须保持原始 Rust 二进制，不能替换

### 问题 4：OpenClaw 响应慢
- **现象**：从发送到收到回复约 70 秒
- **原因**：OpenClaw LLM 推理时间长（可能是 mimo-v2.5-pro 模型）
- **方案**：换更快的模型，或优化 prompt 长度

### 问题 5：无语音时等待 15 秒
- **现象**：用户没说话时，录音持续到 maxRecordingMs（15 秒）才退出
- **原因**：静音检测依赖 FunASR 的中间结果，但 FunASR 不发中间结果
- **方案**：实现音频能量检测，静音时主动停止录音

## 九、最终目标

### 短期（体验优化）
1. [ ] 去掉 TTS 自回声（去掉"请说"或用 beep 替代）
2. [ ] 抑制小爱原生链路（禁用原生 ASR 或快速取消）
3. [ ] 优化响应速度（换模型或优化 prompt）
4. [ ] 实现静音检测（音频能量阈值）

### 中期（功能增强）
5. [ ] 意图识别升级（正则 → Qwen Flash 小模型 → OpenClaw 兜底）
6. [ ] 设备控制完善（灯光、窗帘、扫地机等）
7. [ ] 多轮对话支持（保持上下文）
8. [ ] TTS 声音优化（更好的中文声音）

### 长期（高级功能）
9. [ ] 打断支持（用户说话时停止 TTS 播放）
10. [ ] 端到端语音模型（Qwen2.5-Omni，等有 GPU 后）
11. [ ] 多房间支持（多个音箱）

## 十、SSH 连接信息

### MEmini（Server）
```bash
# 本地直接操作
ssh root@192.168.1.249

# 服务管理
systemctl restart open-xiaoai-migpt     # 重启 Server
journalctl -u open-xiaoai-migpt -f      # 查看日志

# FunASR 服务
systemctl status funasr                 # 查看状态
systemctl restart funasr                # 重启

# OpenClaw Gateway
systemctl --user status openclaw-gateway
export XDG_RUNTIME_DIR=/run/user/0
systemctl --user restart openclaw-gateway
```

### 小爱音箱（Client）
```bash
# SSH 连接（密码：open-xiaoai）
sshpass -p 'open-xiaoai' ssh -o HostKeyAlgorithms=+ssh-rsa -o StrictHostKeyChecking=no root@192.168.1.29

# 查看进程
ps | grep -E "kws|monitor|client" | grep -v grep

# 重启 Client
kill $(pgrep -f "client ws://")
/data/open-xiaoai/client ws://192.168.1.249:4399 > /tmp/open-xiaoai/client.log 2>&1 &

# 查看 KWS 日志
tail -f /tmp/open-xiaoai/kws.log

# 查看原生 ASR/TTS 日志
tail -f /tmp/mico_aivs_lab/instruction.log

# 重启小爱原生服务（会短暂中断）
/etc/init.d/mico_aivs_lab restart

# 传文件到音箱（无 scp）
cat local_file | sshpass -p 'open-xiaoai' ssh -o HostKeyAlgorithms=+ssh-rsa -o StrictHostKeyChecking=no root@192.168.1.29 'cat > /remote/path'
```

### KWS 启动命令（音箱端）
```bash
cd /data/open-xiaoai/kws
./kws --model-type=zipformer2 --encoder models/encoder.onnx --decoder models/decoder.onnx --joiner models/joiner.onnx --tokens models/tokens.txt --keywords-file keywords.txt > /tmp/open-xiaoai/kws.log 2>&1 &
```

## 十一、调试技巧

1. **看 Server 日志**：`journalctl -u open-xiaoai-migpt -f --since "5 minutes ago"`
2. **看音箱 kws.log**：确认唤醒词是否被检测到
3. **看 instruction.log**：确认小爱原生 ASR 识别了什么
4. **测 FunASR**：用 websocat 连 `ws://127.0.0.1:10095` 手动发音频
5. **测 OpenClaw API**：`curl http://127.0.0.1:18789/v1/chat/completions -H "Authorization: Bearer TOKEN" -d '{"model":"openclaw","messages":[{"role":"user","content":"你好"}]}'`

## 十二、版本记录

| 日期 | 改动 |
|------|------|
| 2026-05-04 | 初始调试：FunASR 时序修复、LLM model 修复、端到端链路跑通 |
