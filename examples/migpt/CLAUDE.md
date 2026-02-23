# 智能家居语音助手 — 管家模式

## 项目概述
小爱音箱 Pro（OH2P）的自定义语音助手后端。音箱端 Client（Rust）通过 WebSocket 连接本 Server，实现：
- KWS 唤醒词"你好管家" → 自主录音 → FunASR 语音识别 → 意图理解 → HA 设备控制 → TTS 回复
- 小爱原生"小爱同学"链路保持不变

## 技术栈
- TypeScript + tsx 运行（非编译后 JS）
- Rust Neon binding（open-xiaoai.node）：音箱 RPC 通信
- @mi-gpt/engine：MiGPT 引擎基类
- WebSocket：Client↔Server 通信 + FunASR 通信
- Home Assistant REST API：设备控制

## 目录结构
```
examples/migpt/
├── config.ts          — 运行时配置（OpenClaw API、FunASR、管家参数）
├── migpt/
│   ├── index.ts       — 入口
│   ├── xiaoai.ts      — 核心引擎（管家模式全链路、事件处理）
│   ├── speaker.ts     — TTS/录音/shell 封装
│   ├── funasr.ts      — FunASR WebSocket 客户端
│   ├── intent.ts      — 本地规则意图识别（待替换为小模型）
│   ├── devices.json   — 设备映射表（待替换为动态生成）
│   ├── open-xiaoai.ts — Rust binding 类型声明
│   └── open-xiaoai.node — 编译后的 Rust 二进制
├── src/               — Rust 源码（Server RPC、录音、播放）
├── tsconfig.json
├── package.json
└── Cargo.toml
```

## 关键文件说明
- `xiaoai.ts`：最核心的文件。`startGuanjiaMode()` 是管家模式全链路入口
- `intent.ts`：当前是正则匹配，**需要替换为小模型（Qwen Flash）意图识别**
- `config.ts`：所有配置集中在这里，包括 OpenClaw API 地址/密钥、FunASR 地址
- `speaker.ts`：封装了 `play()`（TTS）、`wakeUp()`、`run_shell()` 等方法

## 编译与运行
```bash
# TypeScript 类型检查
npx tsc --noEmit

# Rust 编译（需要时才跑，改 TS 不需要）
PATH="$HOME/.cargo/bin:$PATH" pnpm build

# 启动服务
pnpm start
# 或
tsx migpt/index.ts

# systemd service
systemctl restart open-xiaoai-migpt
journalctl -u open-xiaoai-migpt -f
```

## 代码规范
- TypeScript strict 模式
- 中文注释和日志（用户是中文环境）
- 日志前缀：🏠 [管家模式]、🔵 [小爱模式]、🔥 唤醒词、✅ 成功
- 错误处理：try/catch + finally 资源清理
- HA API 调用用 fetch，Bearer token 认证

## 外部服务
- OpenClaw API：http://127.0.0.1:18789/v1（OpenAI 兼容格式，兜底大模型）
- FunASR：ws://127.0.0.1:10095（本地语音识别，协议：action:start → PCM → action:end）
- Home Assistant：http://192.168.1.249:8123/api/（设备控制）
- HA Token 配置：读取 `~/.config/home-assistant/config.json`，fallback `/root`

## 当前任务：意图识别层升级
将 `intent.ts` 从规则匹配替换为小模型意图识别：

### 架构
1. 第1层：Qwen Flash 小模型（阿里云百炼 API，直连，不走 OpenClaw）
   - 输入：用户语音文字
   - 输出：JSON 动作列表 `{"actions":[{"entity_id":"xxx","service":"xxx","data":{}}]}`
   - 搞不定返回 `{"fallback":true}`
2. 第2层：OpenClaw Opus 大模型（现有 `onMessage` 路径，兜底）

### 需要做的事
1. 重写 `intent.ts`：调用阿里云百炼 Qwen Flash API 做意图识别
2. 设备列表动态化：写脚本从 HA API `/api/states` 拉取可控设备，生成 JSON
3. System prompt：包含设备列表 + 场景模板（看电影、睡觉等多设备联动）
4. 修改 `xiaoai.ts` 第8步：调用新的意图识别，解析 JSON actions，批量调 HA API
5. 修改 `config.ts`：新增阿里云百炼 API 配置项

### HA 可控设备（供 system prompt 参考）
- 灯光 10个：格栅灯、客厅灯带、吊顶灯带、西顿灯带x4、灯组、筒灯组合等
- 窗帘 4个：客厅纱帘、领普窗帘电机、主帘、纱帘
- 扫地机 1台：石头 G30 Space 探索版（vacuum.g30_space_tan_suo_ban）
- 媒体 1个：Hope 双音源背景音乐（播放/暂停/上下首）
- 详细 entity_id 见 devices.json 或从 HA API 动态获取

### 另一个待修复问题
- streaming TTS：OpenClaw 流式返回时每个 chunk 都触发 speaker.play()，导致语音碎片化
- 修复方案：管家模式的 `onMessage` 改为非流式 API 调用，拿到完整回复再播报

## 注意事项
- `process.env.HOME` 在 systemd service 里可能是 undefined，需要 fallback `/root`
- 音箱端没有 scp/base64，传文件用管道：`cat file | ssh root@192.168.1.29 'cat > dest'`
- 音箱 SSH：`sshpass -p 'open-xiaoai' ssh -o HostKeyAlgorithms=+ssh-rsa root@192.168.1.29`
- Rust 编译需要 `PATH="$HOME/.cargo/bin:$PATH"`
- 改 TypeScript 不需要重新编译 Rust，重启 service 即可
