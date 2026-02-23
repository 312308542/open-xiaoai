/**
 * 本地意图识别 + HA 快速执行
 * 常见智能家居指令直接走 HA REST API，不经过 LLM
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// HA 配置
const haConfig = JSON.parse(
  readFileSync(
    process.env.HA_CONFIG || `${process.env.HOME || "/root"}/.config/home-assistant/config.json`,
    "utf-8"
  )
);
const HA_URL = haConfig.url;
const HA_TOKEN = haConfig.token;

// 设备映射表
interface DeviceMap {
  lights: Record<string, string>;
  covers: Record<string, string>;
  vacuums: Record<string, string>;
  media_players: Record<string, string>;
  aliases: Record<string, string[]>;
}

const devices: DeviceMap = JSON.parse(
  readFileSync(join(__dirname, "devices.json"), "utf-8")
);

interface IntentResult {
  /** 执行是否成功 */
  ok: boolean;
  /** 给用户的语音回复 */
  reply: string;
}

/** 意图模式定义 */
interface IntentPattern {
  /** 正则匹配 */
  pattern: RegExp;
  /** 处理函数，match 保证至少有 [0] */
  handler: (match: string[]) => Promise<IntentResult>;
}

// ---- HA API 调用 ----

async function haCall(
  domain: string,
  service: string,
  entityId: string | string[]
): Promise<boolean> {
  const ids = Array.isArray(entityId) ? entityId : [entityId];
  try {
    const res = await fetch(`${HA_URL}/api/services/${domain}/${service}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entity_id: ids }),
    });
    return res.ok;
  } catch (e) {
    console.error(`🏠 [HA] 调用失败: ${domain}.${service}`, e);
    return false;
  }
}

// ---- 设备查找 ----

function findDevice(name: string): { entityId: string | string[]; domain: string; displayName: string } | null {
  // 先查别名（多设备组）
  const aliasIds = devices.aliases[name];
  if (aliasIds && aliasIds.length > 0) {
    const domain = aliasIds[0]!.split(".")[0]!;
    return { entityId: aliasIds, domain, displayName: name };
  }
  // 逐类查找
  const categories: Record<string, string>[] = [
    devices.lights, devices.covers, devices.vacuums, devices.media_players,
  ];
  for (const map of categories) {
    const eid = map[name];
    if (eid) {
      const domain = eid.split(".")[0]!;
      return { entityId: eid, domain, displayName: name };
    }
  }
  return null;
}

// ---- 设备名提取（从所有映射表中构建） ----

function getAllDeviceNames(): string[] {
  const names = new Set<string>();
  const maps = [devices.lights, devices.covers, devices.vacuums, devices.media_players, devices.aliases];
  for (const map of maps) {
    for (const key of Object.keys(map)) {
      names.add(key);
    }
  }
  // 按长度降序，优先匹配长名称
  return [...names].sort((a, b) => b.length - a.length);
}

const allDeviceNames = getAllDeviceNames();

/** 从文本中提取设备名 */
function extractDevice(text: string): string | null {
  for (const name of allDeviceNames) {
    if (text.includes(name)) return name;
  }
  return null;
}

// ---- 意图模式 ----

const intentPatterns: IntentPattern[] = [
  // 打开/开 + 设备
  {
    pattern: /^(?:打开|开|开启|启动|开一下)(.+)/,
    handler: async (m) => {
      const raw = m[1]!;
      const devName = extractDevice(raw) || raw.trim();
      const dev = findDevice(devName);
      if (!dev) return { ok: false, reply: "" };

      const serviceMap: Record<string, string> = {
        light: "turn_on",
        cover: "open_cover",
        media_player: "turn_on",
        vacuum: "start",
      };
      const service = serviceMap[dev.domain];
      if (!service) return { ok: false, reply: "" };

      const ok = await haCall(dev.domain, service, dev.entityId);
      return {
        ok,
        reply: ok ? `${dev.displayName}已打开` : `${dev.displayName}打开失败`,
      };
    },
  },
  // 关闭/关 + 设备
  {
    pattern: /^(?:关闭|关|关掉|关一下|停止)(.+)/,
    handler: async (m) => {
      const raw = m[1]!;
      const devName = extractDevice(raw) || raw.trim();
      const dev = findDevice(devName);
      if (!dev) return { ok: false, reply: "" };

      const serviceMap: Record<string, string> = {
        light: "turn_off",
        cover: "close_cover",
        media_player: "turn_off",
        vacuum: "return_to_base",
      };
      const service = serviceMap[dev.domain];
      if (!service) return { ok: false, reply: "" };

      const ok = await haCall(dev.domain, service, dev.entityId);
      return {
        ok,
        reply: ok ? `${dev.displayName}已关闭` : `${dev.displayName}关闭失败`,
      };
    },
  },
  // 扫地/打扫
  {
    pattern: /^(?:扫地|打扫|开始打扫|扫一下)/,
    handler: async () => {
      const dev = findDevice("扫地机");
      if (!dev) return { ok: false, reply: "" };
      const ok = await haCall("vacuum", "start", dev.entityId);
      return { ok, reply: ok ? "扫地机已启动" : "扫地机启动失败" };
    },
  },
  // 回充
  {
    pattern: /^(?:回充|充电|回去充电|扫地机回充)/,
    handler: async () => {
      const dev = findDevice("扫地机");
      if (!dev) return { ok: false, reply: "" };
      const ok = await haCall("vacuum", "return_to_base", dev.entityId);
      return { ok, reply: ok ? "扫地机正在回充" : "扫地机回充失败" };
    },
  },
  // 调亮度：把XX灯调到50%
  {
    pattern: /(?:把|将)?(.+?)(?:亮度)?(?:调到|设为|设置为|调成)(\d+)%?/,
    handler: async (m) => {
      const raw = m[1]!;
      const pct = m[2]!;
      const devName = extractDevice(raw) || raw.trim();
      const dev = findDevice(devName);
      if (!dev || dev.domain !== "light") return { ok: false, reply: "" };
      const brightness = Math.min(255, Math.round((parseInt(pct) / 100) * 255));
      try {
        const res = await fetch(`${HA_URL}/api/services/light/turn_on`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${HA_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entity_id: dev.entityId,
            brightness,
          }),
        });
        return {
          ok: res.ok,
          reply: res.ok
            ? `${dev.displayName}亮度已调到${pct}%`
            : `${dev.displayName}亮度调节失败`,
        };
      } catch {
        return { ok: false, reply: `${dev.displayName}亮度调节失败` };
      }
    },
  },
];

// ---- 主入口 ----

/**
 * 尝试本地意图识别并执行
 * @returns IntentResult 如果匹配到意图；null 如果需要 fallback 到 LLM
 */
export async function tryLocalIntent(text: string): Promise<IntentResult | null> {
  const trimmed = text.trim().replace(/[。，！？,.!?]+$/, ""); // 去尾部标点
  console.log(`🏠 [意图] 尝试匹配: "${trimmed}"`);

  for (const { pattern, handler } of intentPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      const result = await handler([...match] as string[]);
      if (result.ok || result.reply) {
        console.log(`🏠 [意图] 匹配成功: ${result.reply}`);
        return result;
      }
      // handler 返回 ok=false 且无 reply，继续尝试下一个模式
    }
  }

  console.log("🏠 [意图] 未匹配，fallback 到 OpenClaw");
  return null;
}
