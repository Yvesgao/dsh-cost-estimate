# dsh-cost-estimate

> DeepSeek Harness（DSH）插件 —— **回答之前先报价，回答之后看账单**。

在 DSH Web 聊天界面里，当你发送一条**比较大的问题**时，回答开始之前会在聊天流中插入一行内联通知，预估这次回答大概需要多少 token、折合 DeepSeek API 多少钱；回答结束后，同一行自动更新为**实际**的 token 用量与费用。

与社区已有插件（dsh-session-cost / dsh-token-budget / dsh-usage 等）的关键区别：那些都是**事后**用 provider 返回的 `usage` 统计账单；本插件是**事前预估**——输出长度天然无法精确预测，因此给出区间，并用会话内历史实际值做持续校准。

---

## ✨ 特性

- **事前预估**：模型开始生成前，先显示预估的输入 token、输出 token 区间和费用区间
- **事后对账**：回答结束（拿到 provider 真实 `usage`）后，同一行翻转为实际 token 与费用，并展示缓存命中率
- **阈值触发，不刷屏**：默认"预估输入 ≥ 8000 token 或预估费用 ≥ ¥0.01"才显示，小问题静默、大问题必提示
- **峰谷计价**：内置 DeepSeek 官方价目（deepseek-v4-flash / v4-pro），按当前北京时间自动选择高峰/低谷档位
- **输入侧尽量精确**：优先锚定每次请求真实返回的 `usage`，中间穿插用 CJK 感知的启发式计数兜底
- **输出侧持续校准**：用会话内"预估中点 vs 实际输出"的滑动均值校准后续预估，越用越准
- **纯客户端、零侵入**：全部计算与渲染在 Web 客户端完成，不向会话日志写入任何自定义事件，装/卸插件不影响已有会话
- **多步回合友好**：工具调用循环会标注"多步"，并累计真实费用

---

## 效果示例

发送一个大问题（例如几千字的设计文档评审请求）后：

```
预估：输入约 9.9K tok · 输出 2.2K–7.3K tok · 费用约 ¥0.0096–¥0.0198（v4-flash）
```

模型回答结束后，同一行自动翻转为：

```
实际：输入 9.1K tok · 输出 1.1K tok · 费用 ¥0.02（缓存命中 87% · v4-flash）
```

## 演示

![dsh-cost-estimate 演示](demo-cost-estimate.gif)

---

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-cost-estimate

# 本地开发 / 尝鲜（从源码目录安装）
dsh plugin --profile web add <本目录路径>
```

安装后重启 `dsh web`，并在浏览器中**强制刷新**（Ctrl+Shift+R）以加载新插件。桌面端用户也可以在插件市场搜索 `dsh-cost-estimate` 一键安装。

> 注意：DSH 的 `dsh plugin` 命令依赖 pnpm（`npm install -g pnpm`）；Windows 上安装路径含空格时请使用无空格的路径（如 junction）避免解析错误。

---

## 配置

`cordis.patch.yml` 中 `config` 支持以下键：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `minInputTokens` | `8000` | 预估输入超过该 token 数才显示 |
| `minCostCny` | `0.01` | 或预估费用上限超过该元数才显示 |
| `defaultModel` | `deepseek-v4-flash` | 首次 usage 锚定前的模型回退值 |
| `headerTokensEstimate` | `6000` | 首次 usage 锚定前，系统提示词 + 工具 schema 的启发式 token 数 |
| `defaultCacheHitRatio` | `0.5` | 首次 usage 锚定前假定的缓存命中率 |

示例：

```yaml
- id: cost-estimate
  name: dsh-cost-estimate
  config:
    minInputTokens: 20000
    minCostCny: 0.05
```

---

## 定价

内置 DeepSeek 官方定价（¥/百万 token，与 [api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 对齐）：

| 模型 | 缓存命中输入 | 未命中输入 | 输出 |
| --- | --- | --- | --- |
| deepseek-v4-flash（2026-08-17 前） | ¥0.02 | ¥1 | ¥2 |
| deepseek-v4-pro（2026-08-17 前） | ¥0.025 | ¥3 | ¥6 |
| flash · 高峰（北京时间 9-12 / 14-18） | ¥0.10 | ¥3 | ¥9 |
| flash · 低谷 | ¥0.05 | ¥1.5 | ¥4.5 |
| pro · 高峰 | ¥0.30 | ¥9 | ¥27 |
| pro · 低谷 | ¥0.15 | ¥4.5 | ¥13.5 |

价格会随官方调价变化；若官方调价，请同步更新 `lib/client.js` 中的价格常量。

---

## 工作原理

1. **输入 token**
   - 优先使用 provider 每次请求真实返回的 `usage`（`inputTokens` / `cacheReadTokens` / `cacheWriteTokens`）做精确锚定；
   - 中间穿插时用 CJK 感知的启发式计数兜底。注意：DSH 内核自带的 4 字符/token 估算对中文低估约 5 倍，本插件按"中文约 1.2 token/字、英文约 4 字符/token"单独处理；
   - 系统提示词 + 工具 schema 的头部大小在首次锚定后自动推导，无需手工配置。
2. **输出 token（本质不可预测，给区间）**
   - 根据问题长度、是否含代码/分析类关键词给出合理区间；
   - 用会话内每一次"预估中点 vs 实际输出"的滑动均值（最近 8 条）计算校准因子，持续修正后续预估。
3. **费用**
   - 输入 ×（缓存命中率 × 命中单价 + 未命中率 × 未命中单价）+ 输出 × 输出单价；
   - 缓存命中率优先使用最近一次请求的真实比例；价格表按当前北京时间自动选档（平峰 / 高峰 / 低谷）。

### 工程取舍

- **纯客户端实现**：估算与渲染完全在 Web 客户端（`ConversationNodeDefinition` + `conversation.chat.node` 插槽）完成。不向会话日志追加自定义事件——DSH 的持久化回读只认内置事件类型（`KNOWN_SESSION_EVENT_TYPES`），自定义事件会导致会话重启后无法加载。因此本插件对会话日志零侵入、可安全装卸。
- **一个回合一个上下文**：预估行按"回合"（turn）为单位，起始于该回合第一个 `step/start`（DSH 的 turn/step 编号从 1 开始）。

---

## 精度说明（诚实声明）

- 预估**仅供参考，以 DeepSeek 实际扣费为准**。
- 输入侧在拿到真实 `usage` 后是精确的；输出侧是区间估计，会话内校准会持续改善，但不会 100% 准确。
- 费用按当前时段的峰/谷价目与最近观测的缓存命中率估算，实际命中率可能不同。

---

## 路线图

- [x] 事前预估 + 事后对账（Web 聊天内嵌行）
- [x] 峰谷计价、阈值触发、会话内输出校准
- [x] 跨会话校准（localStorage 持久化校准数据，v0.2.0）
- [x] CLI / 无头模式支持（host 端 `agent/pre-step` 输出预估，v0.2.0）
- [ ] 模型 / 价格表的运行时配置界面
- [x] npm 发布（dsh-cost-estimate@0.1.0 / 0.2.0）

## 更新日志

### v0.2.0（2026-08-26）

- **跨会话校准**：实际 vs 预估的校准样本持久化到浏览器 localStorage（最多 100 条），新会话自动继承历史校准因子，越用越准
- **CLI / 无头支持**：host 端新增真实行为——模型回答前，`agent/pre-step` 钩子通过 token-meter 服务计算输入 token，在 stdout 打印预估行（如 `[dsh-cost-estimate] 预估：输入约 302K tok · 输出 0.2K–0.9K tok · 费用约 ¥0.45–¥0.48（v4-flash）`），阈值与 Web 端一致
- **共享估算核心**：估算逻辑抽为 `lib/estimate-core.js`（纯函数），host 端直接引用；CLI 会话内同样维护校准样本
- 代码结构：新增 `lib/estimate-core.js`

---

## 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— DeepSeek 官方 Agent 框架
- [DeepSeek API 定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

## 许可证

[MIT](./LICENSE)
