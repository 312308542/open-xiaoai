import { WebSocket } from "ws";

export interface FunASRResult {
  text: string;
  isFinal: boolean;
}

export interface FunASRConfig {
  url: string; // ws://127.0.0.1:10095
  mode?: "offline" | "online" | "2pass";
}

const DEFAULT_CONFIG: Required<FunASRConfig> = {
  url: "ws://127.0.0.1:10095",
  mode: "offline",
};

/**
 * FunASR WebSocket 客户端
 *
 * 协议（与 funasr_ws_server.py 对齐）：
 *   → {"action": "start"}
 *   ← {"status": "started"}
 *   → 二进制 PCM 音频块 (16kHz 16bit mono)
 *   → {"action": "end"}
 *   ← {"text": "识别结果", "is_final": true}
 */
export class FunASRSession {
  private ws: WebSocket | null = null;
  private config: Required<FunASRConfig>;
  private resolveResult: ((result: FunASRResult) => void) | null = null;
  private rejectResult: ((err: Error) => void) | null = null;
  private closed = false;
  private _resultPromise: Promise<FunASRResult> | null = null;

  constructor(config?: Partial<FunASRConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 开始一次识别会话
   * @param onPartial 可选，收到中间结果时回调
   * @returns Promise 等 WebSocket 就绪后 resolve（可以开始发音频了）
   */
  start(onPartial?: (result: FunASRResult) => void): Promise<void> {
    this.closed = false;

    return new Promise<void>((readyResolve, readyReject) => {
      try {
        this.ws = new WebSocket(this.config.url);
      } catch (err) {
        readyReject(new Error(`FunASR 连接失败: ${err}`));
        return;
      }

      // 结果 Promise 单独管理
      this._resultPromise = new Promise<FunASRResult>((resolve, reject) => {
        this.resolveResult = resolve;
        this.rejectResult = reject;
      });

      this.ws.on("open", () => {
        this.ws!.send(JSON.stringify({ action: "start" }));
        // WebSocket 就绪，可以开始发音频了
        readyResolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.status === "started") return;

          if (msg.error) {
            console.error(`FunASR error: ${msg.error}`);
            return;
          }

          const result: FunASRResult = {
            text: msg.text || "",
            isFinal: msg.is_final === true || msg.is_final === "true",
          };

          if (result.isFinal) {
            this.closed = true;
            this.resolveResult?.(result);
            this.resolveResult = null;
            this.rejectResult = null;
          } else if (result.text && onPartial) {
            onPartial(result);
          }
        } catch {
          // 忽略非 JSON 消息
        }
      });

      this.ws.on("close", () => {
        if (!this.closed) {
          this.closed = true;
          this.resolveResult?.({ text: "", isFinal: true });
          this.resolveResult = null;
          this.rejectResult = null;
        }
      });

      this.ws.on("error", (err) => {
        if (!this.closed) {
          this.closed = true;
          this.rejectResult?.(new Error(`FunASR 错误: ${err.message}`));
          this.resolveResult = null;
          this.rejectResult = null;
        }
        // 连接阶段的错误也通知 readyReject
        readyReject(new Error(`FunASR 连接错误: ${err.message}`));
      });
    });
  }

  /**
   * 获取最终识别结果（在 start() 就绪后调用）
   */
  waitForResult(): Promise<FunASRResult> {
    return this._resultPromise ?? Promise.resolve({ text: "", isFinal: true });
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
   * 通知服务端音频结束，等待最终结果
   */
  finishAudio() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "end" }));
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
