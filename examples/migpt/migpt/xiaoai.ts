import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { FunASRSession, type FunASRConfig } from "./funasr.js";
import { tryLocalIntent } from "./intent.js";
import { randomUUID } from "node:crypto";

export interface GuanjiaConfig {
  /** FunASR 服务配置 */
  funasr?: Partial<FunASRConfig>;
  /** 录音最大时长（毫秒），默认 15000 */
  maxRecordingMs?: number;
  /** 静音超时（毫秒）：FunASR 无新结果多久后自动停止，默认 3000 */
  silenceTimeoutMs?: number;
  /** 提示音文字，默认 "请说" */
  promptText?: string;
  /** 阿里云百炼 Qwen Flash 意图识别配置 */
  qwenFlash?: {
    baseURL: string;
    apiKey: string;
    model: string;
  };
}

export type OpenXiaoAIConfig = Prettify<
  EngineConfig<OpenXiaoAIEngine> & { guanjia?: GuanjiaConfig }
>;

const kDefaultOpenXiaoAIConfig: OpenXiaoAIConfig = {
  //
};

const kDefaultGuanjiaConfig: Required<GuanjiaConfig> = {
  funasr: { url: "ws://127.0.0.1:10095", mode: "offline" },
  maxRecordingMs: 15000,
  silenceTimeoutMs: 3000,
  promptText: "请说",
  qwenFlash: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "",
    model: "qwen-flash",
  },
};

class OpenXiaoAIEngine extends MiGPTEngine {
  speaker = OpenXiaoAISpeaker;

  private _guanjiaConfig = kDefaultGuanjiaConfig;
  private _guanjiaActive = false; // 管家模式是否正在处理中
  private _asrSession: FunASRSession | null = null;
  private _silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private _maxRecordTimer: ReturnType<typeof setTimeout> | null = null;

  async start(config: OpenXiaoAIConfig) {
    if (config.guanjia) {
      this._guanjiaConfig = {
        ...kDefaultGuanjiaConfig,
        ...config.guanjia,
        funasr: { ...kDefaultGuanjiaConfig.funasr, ...config.guanjia.funasr },
      };
    }
    await super.start(deepMerge(kDefaultOpenXiaoAIConfig, config));
    // 注册全局回调函数
    (global as any).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onRecord,
    };
    // 启动服务
    console.log("✅ 服务已启动...");
    await RustServer.start();
  }

  /**
   * 收到事件
   */
  onEvent = (event: string) => {
    const e = JSON.parse(event);
    if (e.event === "playing") {
      OpenXiaoAISpeaker.status =
        e.data === "Playing"
          ? "playing"
          : e.data === "Paused"
          ? "paused"
          : "idle";
    } else if (e.event === "instruction" && e.data?.NewLine) {
      // 小爱原生 ASR 结果（仅日志，管家模式不依赖这个）
      const line = jsonDecode(e.data.NewLine);
      if (
        line?.header?.namespace === "SpeechRecognizer" &&
        line?.header?.name === "RecognizeResult" &&
        line?.payload?.is_final &&
        line?.payload?.results?.[0]?.text
      ) {
        const text = line.payload.results[0].text;
        console.log(`🔵 [小爱模式] ${text}`);
      }
    } else if (e.event === "kws") {
      const keyword =
        typeof e.data === "string" ? e.data : e.data?.Keyword ?? "";
      console.log("🔥 唤醒词识别:", keyword);
      if (keyword.includes("管家") && !this._guanjiaActive) {
        this.startGuanjiaMode();
      }
    }
  };

  /**
   * 收到录音音频流 — 转发给 FunASR
   */
  onRecord = (data: Uint8Array) => {
    if (this._asrSession && this._guanjiaActive) {
      this._asrSession.sendAudio(data);
      // 收到音频数据，重置静音计时器
      this.resetSilenceTimer();
    }
  };

  /**
   * 启动管家模式全链路
   */
  private async startGuanjiaMode() {
    this._guanjiaActive = true;
    const cfg = this._guanjiaConfig;
    console.log("🏠 [管家模式] 启动");

    try {
      // 1. 创建 FunASR 会话
      this._asrSession = new FunASRSession(cfg.funasr);
      const asrPromise = this._asrSession.start((partial) => {
        console.log(`🏠 [ASR 中间] ${partial.text}`);
      });

      // 2. 播放提示音（blocking 等播完，避免被录进去）
      await OpenXiaoAISpeaker.play({ text: cfg.promptText, blocking: true });

      // 3. 开始录音（RPC 到 Client）
      const recRes = await RustServer.start_recording();
      console.log("🏠 [录音] 已开始:", recRes);

      // 4. 设置最大录音时长保护
      this._maxRecordTimer = setTimeout(() => {
        console.log("🏠 [录音] 达到最大时长，停止");
        this.stopRecording();
      }, cfg.maxRecordingMs);

      // 5. 启动静音计时器
      this.resetSilenceTimer();

      // 6. 等待 ASR 最终结果
      const result = await asrPromise;
      console.log(`🏠 [ASR 最终] ${result.text}`);

      // 7. 清理录音相关定时器
      this.clearTimers();

      if (!result.text.trim()) {
        console.log("🏠 [管家模式] 未识别到有效文字，退出");
        await OpenXiaoAISpeaker.play({ text: "没有听清，请再说一次", blocking: false });
        return;
      }

      // 8. 先尝试本地意图识别（快速通道）
      console.log(`🏠 [管家] 收到: ${result.text}`);
      const intent = await tryLocalIntent(result.text);
      if (intent) {
        // 本地匹配成功，直接播报结果
        console.log(`🏠 [快速] ${intent.reply}`);
        await OpenXiaoAISpeaker.play({ text: intent.reply, blocking: false });
      } else {
        // Fallback 到 OpenClaw（流式）
        console.log(`🏠 [OpenClaw] 发送: ${result.text}`);
        await this.onMessage({
          text: result.text,
          id: randomUUID(),
          sender: "user",
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      console.error("🏠 [管家模式] 错误:", err);
      this.clearTimers();
      try {
        await OpenXiaoAISpeaker.play({ text: "出了点问题，请稍后再试", blocking: false });
      } catch {}
    } finally {
      this._guanjiaActive = false;
      this._asrSession?.close();
      this._asrSession = null;
      // 确保录音已停止
      try {
        await RustServer.stop_recording();
      } catch {}
      console.log("🏠 [管家模式] 结束");
    }
  }

  /**
   * 停止录音并通知 FunASR 音频结束
   */
  private async stopRecording() {
    try {
      await RustServer.stop_recording();
      console.log("🏠 [录音] 已停止");
    } catch (err) {
      console.error("🏠 [录音] 停止失败:", err);
    }
    // 通知 FunASR 音频结束
    this._asrSession?.finishAudio();
  }

  private resetSilenceTimer() {
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => {
      console.log("🏠 [静音检测] 超时，停止录音");
      this.stopRecording();
    }, this._guanjiaConfig.silenceTimeoutMs);
  }

  private clearTimers() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    if (this._maxRecordTimer) {
      clearTimeout(this._maxRecordTimer);
      this._maxRecordTimer = null;
    }
  }
}

export const OpenXiaoAI = new OpenXiaoAIEngine();
