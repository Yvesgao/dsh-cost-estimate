/**
 * Shared estimator core for dsh-cost-estimate (host / CLI face).
 *
 * Pure functions only — no browser or Cordis dependencies, so the host
 * plugin can import this directly. The client bundle (lib/client.js) keeps an
 * identical inline copy because the served browser bundle cannot use ESM
 * imports; keep the two in sync when changing estimator behavior.
 */
/** DeepSeek API pricing, CNY per 1M tokens (https://api-docs.deepseek.com/zh-cn/quick_start/pricing). */
export const FLAT_PRICES = {
  flash: { hit: 0.02, miss: 1, out: 2 },
  pro: { hit: 0.025, miss: 3, out: 6 }
};
/** 峰谷价格（2026-08-17 00:00 北京时间起生效）。 */
export const TIERED_PRICES = {
  flash: { peak: { hit: 0.1, miss: 3, out: 9 }, off: { hit: 0.05, miss: 1.5, out: 4.5 } },
  pro: { peak: { hit: 0.3, miss: 9, out: 27 }, off: { hit: 0.15, miss: 4.5, out: 13.5 } }
};
/** 2026-08-17 00:00 北京时间 = 2026-08-16 16:00 UTC。 */
export const NEW_PRICING_AT = Date.UTC(2026, 7, 16, 16, 0, 0);

export const DEFAULT_CONFIG = {
  minInputTokens: 8000,
  minCostCny: 0.01,
  defaultModel: "deepseek-v4-flash",
  headerTokensEstimate: 6000,
  defaultCacheHitRatio: 0.5
};

export function isPeakBeijing(now) {
  const bj = new Date(now.getTime() + 8 * 3600e3);
  const t = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  return (t >= 9 && t < 12) || (t >= 14 && t < 18);
}

export function normalizeModel(model) {
  if (typeof model !== "string") return "flash";
  return model.includes("pro") ? "pro" : "flash";
}

export function priceOf(model, now) {
  const m = normalizeModel(model);
  if (now.getTime() < NEW_PRICING_AT) return FLAT_PRICES[m];
  return TIERED_PRICES[m][isPeakBeijing(now) ? "peak" : "off"];
}

/** 费用（元）：未命中×miss + 命中×hit + 输出×out（每百万 token）。 */
export function computeCost(inputTokens, outLow, outHigh, model, now, hitRatio) {
  const p = priceOf(model, now);
  const r = Math.min(1, Math.max(0, hitRatio ?? 0.5));
  const miss = inputTokens * (1 - r) * p.miss;
  const hit = inputTokens * r * p.hit;
  return {
    low: (miss + hit + outLow * p.out) / 1e6,
    high: (miss + hit + outHigh * p.out) / 1e6
  };
}

/** CJK-aware token estimate: ~1.2 tokens per CJK char, ~1 token per 4 latin chars. */
export function countTextTokens(text) {
  if (typeof text !== "string") return 0;
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff) || (code >= 0xff00 && code <= 0xffef)) cjk += 1;
    else latin += 1;
  }
  return Math.ceil(cjk * 1.2 + latin / 4);
}

export function estimateContent(blocks) {
  let tokens = 0;
  if (!Array.isArray(blocks)) return 0;
  for (const block of blocks) {
    if (block.type === "text" || block.type === "reasoning") tokens += countTextTokens(block.text) + 4;
    else if (block.type === "tool-call") tokens += countTextTokens(block.name) + countTextTokens(block.arguments) + 4;
    else if (block.type === "tool-result") tokens += estimateContent(block.content) + 4;
    else tokens += 4 + Math.ceil(JSON.stringify(block).length / 4);
  }
  return tokens;
}

export function estimateMessage(message) {
  if (message === null || typeof message !== "object") return 0;
  return estimateContent(message.content) + 4;
}

export function textOfMessage(message) {
  if (message === null || typeof message !== "object" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** 输出长度区间：启发式基数 × 代码/分析类关键词加成 × 校准因子。 */
export function estimateOutputRange(text, calFactor) {
  let cjk = 0;
  let latin = 0;
  if (typeof text === "string") {
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x30ff) || (code >= 0xff00 && code <= 0xffef)) cjk += 1;
      else latin += 1;
    }
  }
  const hay = text || "";
  const codey = /(实现|编写|代码|修复|调试|函数|脚本|命令|接口|api|code|implement|fix|debug|build|refactor|test|写)/i.test(hay);
  const explainy = /(解释|分析|为什么|区别|对比|总结|设计|方案|说明|讲|explain|why|compare|design|describe)/i.test(hay);
  const base = Math.min(2400, Math.max(100, 80 + cjk * 3 + latin * 0.8));
  const mid = Math.round(base * (codey ? 1.7 : explainy ? 1.35 : 1) * clamp(calFactor || 1, 0.3, 4));
  return { low: Math.max(40, Math.round(mid * 0.55)), high: Math.max(80, Math.round(mid * 1.8)) };
}

/** 校准因子 = sum(实际输出) / sum(预估中点)。 */
export function calFactorOf(history) {
  if (!Array.isArray(history) || history.length === 0) return 1;
  let sumMid = 0;
  let sumActual = 0;
  for (const sample of history) {
    sumMid += sample.mid || 0;
    sumActual += sample.actual || 0;
  }
  return sumMid > 0 ? sumActual / sumMid : 1;
}

/** 人类提问过滤：跳过注入上下文/工具结果/模型输出。 */
export function isHumanMessage(message) {
  const kind = message?.source?.kind;
  return kind !== "plugin" && kind !== "tool" && kind !== "model";
}

export function formatTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n));
}

export function formatCost(n) {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

/** 组装一行预估文案（CLI 与调试共用）。 */
export function formatEstimateLine({ input, outLow, outHigh, costLow, costHigh, model, prefix = "预估" }) {
  return `${prefix}：输入约 ${formatTokens(input)} tok · 输出 ${formatTokens(outLow)}–${formatTokens(outHigh)} tok · 费用约 ¥${formatCost(costLow)}–¥${formatCost(costHigh)}（${normalizeModel(model)}）`;
}
