import { OpenXiaoAIConfig } from "./migpt/xiaoai.js";

export const kOpenXiaoAIConfig: OpenXiaoAIConfig = {
  openai: {
    baseURL: "http://127.0.0.1:18789/v1",
    apiKey: "d6e58fb823c2ea8923df093f6353ea136252db5e41b9db5b",
    model: "claude-yunyi/claude-opus-4-6",
  },
  prompt: {
    system:
      "你是公园里22栋1单元13A01的智能家庭管家，负责回答主人的问题和控制家中设备。请用简洁自然的中文回答，语气温和友好。回答尽量简短，适合语音播报。",
  },
  context: {
    historyMaxLength: 10,
  },
  callAIKeywords: [""],
  guanjia: {
    funasr: {
      url: "ws://127.0.0.1:10095",
      mode: "2pass",
    },
    maxRecordingMs: 15000,
    silenceTimeoutMs: 3000,
    promptText: "请说",
  },
};
