/**
 * dsh-cost-estimate — client face.
 *
 * Shows, as an inline row in the Web chat stream, a pre-answer estimate of the
 * tokens and DeepSeek API cost a question will consume, then flips the same
 * row to the actual provider-reported usage once the answer lands.
 *
 * Design notes (why it looks the way it does):
 * - The estimate is computed entirely client-side from the durable session
 *   event stream, so no custom event is appended to the session log (custom
 *   session events would make persisted logs unreadable by the core
 *   KNOWN_SESSION_EVENT_TYPES catalog).
 * - One conversation Context per turn, started by the turn's first
 *   `step/start` (step 1 — DSH numbers turns and steps from 1, verified
 *   against real session logs; step 1 is the only turn-carrier identifiable
 *   from the event payload alone, satisfying the engine's one-start rule).
 * - The question text of the turn is read through a separate state-only
 *   Definition (`cost-context`) started on each human `user/message`; the
 *   estimate Definition reads the nearest predecessor with
 *   `reader.previous('cost-context')` at start time.
 * - Input tokens: a running surface fold carried turn to turn, anchored to
 *   exact provider `usage.inputTokens` whenever an `assistant/message`
 *   reports one (the anchor also yields the real system+tools header size).
 * - Output tokens are fundamentally unpredictable; the plugin shows a range
 *   derived from a CJK-aware heuristic scaled by a calibration factor that
 *   adapts to the session's own history (predicted midpoint vs actual).
 * - Pricing: DeepSeek CNY per 1M tokens, flat legacy table plus the
 *   2026-08-17 peak/off-peak table (peak: Beijing 9-12 / 14-18).
 */
window.__ModuleLoader__.load({
  id: "dsh-cost-estimate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");

    // ------------------------------------------------------------------
    // Config (patch `config:` merged over defaults; the client receives it
    // as the second `apply` argument).
    // ------------------------------------------------------------------
    const DEFAULT_CONFIG = {
      minInputTokens: 8000,
      minCostCny: 0.01,
      defaultModel: "deepseek-v4-flash",
      headerTokensEstimate: 6000,
      defaultCacheHitRatio: 0.5
    };
    let estimateConfig = { ...DEFAULT_CONFIG };

    // ------------------------------------------------------------------
    // DeepSeek API pricing, CNY per 1M tokens
    // (https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
    // ------------------------------------------------------------------
    /** 平峰价格（2026-08-17 00:00 北京时间之前生效）。 */
    const FLAT_PRICES = {
      flash: { hit: 0.02, miss: 1, out: 2 },
      pro: { hit: 0.025, miss: 3, out: 6 }
    };
    /** 峰谷价格（2026-08-17 00:00 北京时间起生效）。 */
    const TIERED_PRICES = {
      flash: { peak: { hit: 0.1, miss: 3, out: 9 }, off: { hit: 0.05, miss: 1.5, out: 4.5 } },
      pro: { peak: { hit: 0.3, miss: 9, out: 27 }, off: { hit: 0.15, miss: 4.5, out: 13.5 } }
    };
    /** 2026-08-17 00:00 北京时间 = 2026-08-16 16:00 UTC。 */
    const NEW_PRICING_AT = Date.UTC(2026, 7, 16, 16, 0, 0);

    /** 高峰时段：北京时间 9:00-12:00、14:00-18:00。 */
    function isPeakBeijing(now) {
      const bj = new Date(now.getTime() + 8 * 3600e3);
      const t = bj.getUTCHours() + bj.getUTCMinutes() / 60;
      return (t >= 9 && t < 12) || (t >= 14 && t < 18);
    }

    /** Map a provider model id onto the price-table family (flash | pro). */
    function normalizeModel(model) {
      if (typeof model !== "string") return "flash";
      if (model.includes("pro")) return "pro";
      return "flash";
    }

    function priceOf(model, now) {
      const m = normalizeModel(model);
      if (now.getTime() < NEW_PRICING_AT) return FLAT_PRICES[m];
      return TIERED_PRICES[m][isPeakBeijing(now) ? "peak" : "off"];
    }

    /**
     * 计算一次估算费用（元）。计费口径：缓存写入按"未命中"单价计。
     * 结果 = 未命中×miss + 命中×hit + 输出×out（每百万 token）。
     */
    function computeCost(inputTokens, outLow, outHigh, model, now, hitRatio) {
      const p = priceOf(model, now);
      const r = Math.min(1, Math.max(0, hitRatio ?? 0.5));
      const miss = inputTokens * (1 - r) * p.miss;
      const hit = inputTokens * r * p.hit;
      return {
        low: (miss + hit + outLow * p.out) / 1e6,
        high: (miss + hit + outHigh * p.out) / 1e6
      };
    }

    // ------------------------------------------------------------------
    // Token counting — CJK-aware heuristic (the core's 4 chars/token
    // heuristic undercounts Chinese ~5x; DeepSeek's tokenizer costs roughly
    // 1.2 tokens per CJK char and ~1 token per 4 latin chars).
    // ------------------------------------------------------------------
    function countTextTokens(text) {
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

    function estimateContent(blocks) {
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

    function estimateMessage(message) {
      if (message === null || typeof message !== "object") return 0;
      return estimateContent(message.content) + 4;
    }

    function textOfMessage(message) {
      if (message === null || typeof message !== "object" || !Array.isArray(message.content)) return "";
      return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
    }

    // ------------------------------------------------------------------
    // Output-length estimation: range + in-session calibration.
    // ------------------------------------------------------------------
    function clamp(value, lo, hi) {
      return Math.min(hi, Math.max(lo, value));
    }

    function estimateOutputRange(text, calFactor) {
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

    /** Calibration factor = sum(actual output) / sum(predicted mid) over the session history window. */
    function calFactorOf(history) {
      if (!Array.isArray(history) || history.length === 0) return 1;
      let sumMid = 0;
      let sumActual = 0;
      for (const sample of history) {
        sumMid += sample.mid || 0;
        sumActual += sample.actual || 0;
      }
      return sumMid > 0 ? sumActual / sumMid : 1;
    }

    // ------------------------------------------------------------------
    // Definition: cost-context (state-only). Captures each human question so
    // the estimate Definition can read it back via reader.previous().
    // ------------------------------------------------------------------
    const contextDefinition = {
      kind: "cost-context",
      // No `target`: a state-only Context that never renders a node.
      match(event) {
        if (event.type !== "user/message") return null;
        const kind = event.data?.source?.kind;
        // Skip injected context / tool results / model output: only direct
        // human input drives an estimate. The vocabulary is merge-extensible,
        // so we exclude the known non-human kinds instead of whitelisting.
        if (kind === "plugin" || kind === "tool" || kind === "model") return null;
        return { id: String(event.data.id), role: "start" };
      },
      start(context, match) {
        const text = textOfMessage(match.event.data);
        return { text, tokens: countTextTokens(text) };
      },
      update(context, match) {
        return context.state;
      }
    };

    // ------------------------------------------------------------------
    // Definition: cost-estimate (chat row, one Context per turn).
    // ------------------------------------------------------------------
    const estimateDefinition = {
      kind: "cost-estimate",
      target: "chat",
      match(event) {
        if (event.type === "step/start") {
          // DSH numbers steps from 1: the turn's first step is always step 1.
          return { id: String(event.data.turn), role: event.data.step === 1 ? "start" : "update" };
        }
        if (event.type === "assistant/message") return { id: String(event.data.turn), role: "update" };
        if (event.type === "tool/result") return { id: String(event.data.turn), role: "update" };
        return null;
      },
      start(context, match, reader) {
        const cfg = estimateConfig;
        const q = reader.previous("cost-context");
        const prev = reader.previous("cost-estimate");
        const prevState = prev?.state;
        const questionTokens = q?.state?.tokens ?? 0;
        const questionText = q?.state?.text ?? "";
        const surfaceBefore = prevState?.surfaceTotal ?? 0;
        const headerTokens = prevState?.headerTokens ?? cfg.headerTokensEstimate;
        const anchored = prevState?.anchoredInput;
        const anchorSurface = prevState?.anchorSurface ?? 0;
        // Input estimate for the upcoming request: exact usage when we have
        // an anchor, plus the heuristic surface drift since the anchor, plus
        // this turn's question.
        const inputEstimate = anchored !== undefined
          ? Math.max(0, anchored + (surfaceBefore - anchorSurface) + questionTokens)
          : headerTokens + surfaceBefore + questionTokens;
        const model = prevState?.model ?? cfg.defaultModel;
        const hitRatio = prevState?.hitRatio ?? cfg.defaultCacheHitRatio;
        const calFactor = calFactorOf(prevState?.history);
        const range = estimateOutputRange(questionText, calFactor);
        const cost = computeCost(inputEstimate, range.low, range.high, model, new Date(), hitRatio);
        const visible = inputEstimate >= cfg.minInputTokens || cost.high >= cfg.minCostCny;
        return {
          turn: match.event.data.turn,
          phase: "estimate",
          questionPreview: questionText.slice(0, 80),
          surfaceTotal: surfaceBefore + questionTokens,
          headerTokens,
          inputEstimate,
          outLow: range.low,
          outHigh: range.high,
          costLow: cost.low,
          costHigh: cost.high,
          model,
          hitRatio,
          calFactor,
          visible,
          multiStep: false,
          anchoredInput: undefined,
          anchorSurface: undefined,
          history: prevState?.history ?? [],
          actuals: []
        };
      },
      update(context, match) {
        const s = context.state;
        const event = match.event;
        if (event.type === "step/start") {
          // Another model call within the same turn (tool loop / follow-up
          // step). The row stays; the "multi-step" hint appears.
          return { ...s, multiStep: true };
        }
        if (event.type === "tool/result") {
          return { ...s, surfaceTotal: s.surfaceTotal + estimateMessage(event.data.message) };
        }
        if (event.type !== "assistant/message") return s;
        const msgTokens = estimateMessage(event.data.message);
        const surfaceTotal = s.surfaceTotal + msgTokens;
        const usage = event.data.usage;
        if (usage === undefined) return { ...s, surfaceTotal };
        // Provider reported exact accounting for the step's request.
        const uncached = usage.inputTokens ?? 0;
        const read = usage.cacheReadTokens ?? 0;
        const write = usage.cacheWriteTokens ?? 0;
        const out = usage.outputTokens ?? 0;
        const billedInput = uncached + read + write;
        // The request's input did not include its own assistant message, so
        // the header (system + tools) is what the provider billed beyond the
        // surface as it stood when the request was sent.
        const anchorSurface = surfaceTotal - msgTokens;
        const headerTokens = Math.max(0, billedInput - anchorSurface);
        const hitRatio = billedInput > 0 ? read / billedInput : s.hitRatio;
        const model = event.data.message?.source?.model ?? s.model;
        const actualCost = computeCost(billedInput, out, out, model, new Date(), hitRatio);
        const mid = (s.outLow + s.outHigh) / 2;
        const history = [...s.history, { mid, actual: out }].slice(-8);
        const actuals = [...s.actuals, { step: event.data.step, input: billedInput, output: out, cacheRead: read, cost: actualCost.low }];
        const totalActual = actuals.reduce((sum, a) => sum + a.cost, 0);
        const visible = s.visible || totalActual >= estimateConfig.minCostCny;
        return {
          ...s,
          phase: "actual",
          surfaceTotal,
          headerTokens,
          hitRatio,
          model,
          anchoredInput: billedInput,
          anchorSurface,
          history,
          actuals,
          visible
        };
      },
      publication: () => "immediate",
      buildViewNode(context) {
        const s = context.state;
        if (s === undefined || s.visible !== true) return null;
        const location = context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
        return {
          key: context.key,
          kind: "cost-estimate",
          id: context.id,
          target: "chat",
          anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
          location,
          visibility: "visible",
          data: s
        };
      }
    };

    // ------------------------------------------------------------------
    // Locale dictionaries.
    // ------------------------------------------------------------------
    const zh = {
      "estimate": "预估：输入约 {input} tok · 输出 {low}–{high} tok · 费用约 ¥{lowC}–¥{highC}（{model}）",
      "actual": "实际：输入 {input} tok · 输出 {output} tok · 费用 ¥{cost}（缓存命中 {hit}% · {model}）",
      "multiStep": " · 多步"
    };
    const en = {
      "estimate": "Est. input ~{input} tok · output {low}–{high} tok · cost ≈ ¥{lowC}–¥{highC} ({model})",
      "actual": "Actual: input {input} tok · output {output} tok · cost ¥{cost} ({hit}% cache hit · {model})",
      "multiStep": " · multi-step"
    };

    // ------------------------------------------------------------------
    // Renderer — one compact system-notice row in the chat stream.
    // ------------------------------------------------------------------
    function CostEstimateNodeView({ node, t }) {
      const d = node.data;
      const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n)));
      const fmtCost = (n) => (n >= 1 ? n.toFixed(2) : n.toFixed(4));
      const modelLabel = normalizeModel(d.model);
      let text;
      if (d.phase === "actual" && d.actuals.length > 0) {
        const last = d.actuals[d.actuals.length - 1];
        const totalCost = d.actuals.reduce((sum, a) => sum + a.cost, 0);
        text = t("actual", {
          input: fmtTokens(last.input),
          output: fmtTokens(last.output),
          cost: fmtCost(totalCost),
          hit: Math.round(d.hitRatio * 100),
          model: modelLabel
        });
      } else {
        text = t("estimate", {
          input: fmtTokens(d.inputEstimate),
          low: fmtTokens(d.outLow),
          high: fmtTokens(d.outHigh),
          lowC: fmtCost(d.costLow),
          highC: fmtCost(d.costHigh),
          model: modelLabel
        });
      }
      if (d.multiStep === true) text += t("multiStep");
      return react_jsx_runtime.jsx("div", {
        style: {
          textAlign: "center",
          boxSizing: "border-box",
          color: "var(--dsw-alias-label-tertiary)",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
          overflow: "hidden",
          fontSize: 12,
          lineHeight: "20px",
          padding: "2px 16px 0",
          userSelect: "none"
        },
        children: text
      });
    }

    // ------------------------------------------------------------------
    // Client plugin body.
    // ------------------------------------------------------------------
    const inject = ["slots", "locale", "conversationEvents"];

    function apply(ctx, config) {
      estimateConfig = { ...DEFAULT_CONFIG, ...(config && typeof config === "object" ? config : {}) };
      ctx.effect(() => ctx.locale.register("cost-estimate", { zh, en }), "cost-estimate: dictionaries");
      ctx.effect(() => ctx.conversationEvents.register(contextDefinition), "cost-estimate: question context");
      ctx.effect(() => ctx.conversationEvents.register(estimateDefinition), "cost-estimate: row definition");
      ctx.effect(() => ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
        name: "conversation.chat.node",
        key: "cost-estimate",
        locale: "cost-estimate"
      }, CostEstimateNodeView)), "cost-estimate: chat node");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
