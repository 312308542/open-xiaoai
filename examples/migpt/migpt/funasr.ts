import { WebSocket } from "ws";

export interface FunASRResult {
  text: string;
  isFinal: boolean;
  mode?: string;
  timestamp?: string;
}

export interface FunASRConfig {
  url: string; // ws://127.0.0.1:10095
  mode?: "offline" | "online" | "2pass"; // default: 2pass
  chunkSizeMs?: number[]; // default: [5, 10, 5]
  sampleRate?: number; // default: 16000
}

const DEFAULT_CONFIG: Required<FunASRConfig> = {
  url: "ws://127.0.0.1:10095",
  mode: "2pass",
  chunkSizeMs: [5, 10, 5],
  sampleRate: 16000,
};

/**
 * FunASR WebSocket 客户端
 *
 * 每次识别创建一个新连接（FunASR 的设计就是一次连接一次识别）
 * 流程：connect → 发送音频块 → 发送结束标记 → 等待最终结果 → 关闭
 */
export class FunASRSession {
  private ws: WebSocket | null = null;
  private config: Required<FunASRConfig>;
  private resolveResult: ((result: FunASRResult) => void) | null = null;
  private rejectResult: ((err: Error) => void) | null = null;
  private partialCallback?: (result: FunASRResult) => void;
  private closed = false;
  private finalText = "";

  constructor(config?: Partial<FunASRConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 开始一次识别会话
   * @param onPartial 可选，收到中间结果时回调
   * @returns Promise<FunASRResult> 最终识别结果
   */
  start(onPartial?: (result: FunASRResult) => void): Promise<FunASRResult> {
    this.partialCallback = onPartial;
    this.closed = false;
    this.finalText = "";

    return new Promise<FunASRResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;

      try {
        this.ws = new WebSocket(this.config.url);
      } catch (err) {
        reject(new Error(`FunASR 连接失败: ${err}`));
        return;
      }

      this.ws.on("open", () => {
        // 发送初始配置
        const initMsg = JSON.stringify({
          mode: this.config.mode,
          chunk_size: this.config.chunkSizeMs,
          wav_name: "guanjia",
          is_speaking: true,
          wav_format: "pcm",
          audio_fs: this.config.sampleRate,
        });
        this.ws!.send(initMsg);
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          const result: FunASRResult = {
            text: msg.text || "",
            isFinal: msg.is_final === true || msg.is_final === "true",
            mode: msg.mode,
            timestamp: msg.timestamp,
          };

          if (result.isFinal && result.text) {
            this.finalText = result.text;
          }

          if (result.text && !result.isFinal && this.partialCallback) {
            this.partialCallback(result);
          }
        } catch {
          // 忽略非 JSON 消息
        }
      });

      this.ws.on("close", () => {
        if (!this.closed) {
          this.closed = true;
          if (this.finalText) {
            this.resolveResult?.({
              text: this.finalText,
              isFinal: true,
            });
          } else {
            this.rejectResult?.(new Error("FunASR 连接关闭，未收到最终结果"));
          }
        }
      });

      this.ws.on("error", (err) => {
        if (!this.closed) {
          this.closed = true;
          this.rejectResult?.(new Error(`FunASR 错误: ${err.message}`));
        }
      });
    });
  }

  /**
   * 发送音频数据块（PCM 16kHz 16bit 单声道）
   */
  sendAudio(pcmData: Uint8Array | Buffer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmData);
    }
  }

  /**
   * 通知 FunASR 音频结束，等待最终结果
   */
  finishAudio() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // 发送结束标记
      const endMsg = JSON.stringify({ is_speaking: false });
      this.ws.send(endMsg);
    }
  }

  /**
   * 强制关闭会话
   */
  close() {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
