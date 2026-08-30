/**
 * dsh-cost-estimate — host face.
 *
 * Web client face (lib/client.js) shows the estimate as a chat row; this host
 * face adds **CLI / headless support**: before the model is asked to answer a
 * direct human question, it prints an estimate line to stdout (input tokens,
 * output range, DeepSeek cost under the current peak/off-peak price), using
 * the shared estimator core (lib/estimate-core.js) and the token-meter
 * service for usage-anchored input figures. A per-session in-memory
 * calibration history refines the output range within the session.
 *
 * The estimate is advisory — it never modifies the request; `next()` is
 * always called with the original payload.
 */
import {
  DEFAULT_CONFIG,
  estimateOutputRange,
  computeCost,
  estimateMessage,
  countTextTokens,
  textOfMessage,
  calFactorOf,
  isHumanMessage,
  formatEstimateLine
} from "./estimate-core.js";

/** Stable Cordis plugin name (must match the id used in the bundle patch). */
const name = "cost-estimate";

/** Token-meter provides usage-anchored input measurement. */
const inject = ["tokenMeter"];

/** Per-session in-memory calibration history + last predicted mid (host face). */
const calibrationBySession = new Map();
/** Pending predicted mid per session — paired with the next actual. */
const pendingMid = new Map();

/** Fallback input estimate when the token meter is unavailable: fold the session log. */
function estimateInputFallback(session) {
  const events = session?.events ?? [];
  let tokens = 0;
  try {
    const header = session.requestHeader?.();
    if (header?.system) tokens += Math.ceil(header.system.length / 4) + 4;
    if (header?.tools) tokens += Math.ceil(JSON.stringify(header.tools).length / 4) + 4;
  } catch {
    /* header read failure — estimate surface only */
  }
  for (const event of events) {
    if (event.type === "user/message") tokens += estimateMessage(event.data);
    else if (event.type === "assistant/message") tokens += estimateMessage(event.data.message);
    else if (event.type === "tool/result") tokens += estimateMessage(event.data.message);
  }
  return tokens;
}

function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config && typeof config === "object" ? config : {}) };

  // Pair the predicted mid with the provider-reported actual for calibration.
  ctx.on("session/event", (session, event) => {
    if (event.type !== "assistant/message" || event.data?.usage === undefined) return;
    const key = String(session.id ?? "session");
    const pending = pendingMid.get(key);
    pendingMid.delete(key);
    if (pending === undefined) return;
    const samples = calibrationBySession.get(key) ?? [];
    samples.push({ mid: pending.mid, actual: event.data.usage.outputTokens ?? 0 });
    calibrationBySession.set(key, samples.slice(-8));
  });

  ctx.on("agent/pre-step", async (payload, next) => {
    try {
      const agent = payload?.agent;
      const session = agent?.session;
      const messages = payload?.messages ?? [];
      if (session === undefined || !messages.some(isHumanMessage)) return next();

      // Input estimate: token-meter measurement (usage-anchored) with a log
      // fold fallback. Both are estimates; the provider bill is authoritative.
      let inputEstimate = 0;
      try {
        inputEstimate = ctx.tokenMeter?.measure?.(session)?.totalTokens ?? 0;
      } catch {
        inputEstimate = 0;
      }
      if (inputEstimate <= 0) inputEstimate = estimateInputFallback(session);

      const question = messages.find(isHumanMessage);
      const questionText = textOfMessage(question);
      const key = String(session.id ?? "session");
      const history = calibrationBySession.get(key) ?? [];
      const range = estimateOutputRange(questionText, calFactorOf(history));

      const header = session.requestHeader?.();
      const model = header?.config?.model ?? cfg.defaultModel;
      const cost = computeCost(inputEstimate, range.low, range.high, model, new Date(), cfg.defaultCacheHitRatio);
      const visible = inputEstimate >= cfg.minInputTokens || cost.high >= cfg.minCostCny;

      // Remember the predicted mid for the calibration sample when the actual
      // usage for the next assistant message arrives.
      pendingMid.set(key, { mid: (range.low + range.high) / 2 });

      if (visible) {
        console.log(`[dsh-cost-estimate] ${formatEstimateLine({
          input: inputEstimate,
          outLow: range.low,
          outHigh: range.high,
          costLow: cost.low,
          costHigh: cost.high,
          model
        })}`);
      }
    } catch {
      // The estimate must never break the agent loop.
    }
    return next();
  });
}

export { apply, inject, name };
