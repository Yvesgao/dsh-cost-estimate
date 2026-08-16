# dsh-cost-estimate

DSH (DeepSeek Harness) 插件：**在回答比较大的问题之前**，在 Web 聊天流里插入一行内联通知，预估这次回答大概需要多少 token、折合 DeepSeek API 多少钱；回答结束后，同一行自动更新为**实际** token 用量与费用。

与社区已有插件（dsh-session-cost / dsh-token-budget / dsh-usage 等）的区别：那些都是**事后**用 provider 返回的 `usage` 统计；本插件是**事前预估**（输出长度天然不确定，因此给出区间，并用会话内历史实际值做校准）。

## 安装

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-cost-estimate

# 本地开发 / 尝鲜（从源码目录安装）
dsh plugin --profile web add <本目录路径>
```

然后在插件配置里（可选）调整阈值；重启 `dsh web` 生效。桌面端用户也可以在插件市场搜索 `dsh-cost-estimate` 一键安装。

## 行为

- 触发条件（避免小问题刷屏）：预估请求输入 token ≥ `minInputTokens`（默认 8000），或预估费用上限 ≥ `minCostCny`（默认 ¥0.01）。
- 回答前：`预估：输入约 8.2K tok · 输出 0.4K–1.3K tok · 费用约 ¥0.006–¥0.019（v4-flash）`
- 回答后：`实际：输入 9.1K tok · 输出 1.1K tok · 费用 ¥0.02（缓存命中 87% · v4-flash）`
- 多步回合（工具循环）会标注"多步"，并累计实际费用。

## 配置

`cordis.patch.yml` 中 `config` 支持：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `minInputTokens` | 8000 | 预估输入超过该 token 数才显示 |
| `minCostCny` | 0.01 | 或预估费用上限超过该元数才显示 |
| `defaultModel` | `deepseek-v4-flash` | 首次 usage 锚定前的模型回退值 |
| `headerTokensEstimate` | 6000 | 首次 usage 锚定前系统提示词+工具 schema 的启发式 token 数 |
| `defaultCacheHitRatio` | 0.5 | 首次 usage 锚定前假定的缓存命中率 |

## 定价

内置 DeepSeek 官方定价（¥/百万 token，与 [api-docs.deepseek.com](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 对齐）：

| 模型 | 缓存命中输入 | 未命中输入 | 输出 |
| --- | --- | --- | --- |
| deepseek-v4-flash（2026-08-17 前） | 0.02 | 1 | 2 |
| deepseek-v4-pro（2026-08-17 前） | 0.025 | 3 | 6 |
| flash · 高峰（9-12 / 14-18 北京时间） | 0.10 | 3 | 9 |
| flash · 低谷 | 0.05 | 1.5 | 4.5 |
| pro · 高峰 | 0.30 | 9 | 27 |
| pro · 低谷 | 0.15 | 4.5 | 13.5 |

价格会随官方调价变化；请留意官方定价页更新并同步本插件常量。

## 预估精度说明

- **输入 token**：优先用 provider 每次请求返回的真实 `usage.inputTokens`（精确），中间用 CJK 感知的启发式计数（DSH 内核的 4 字符/token 对中文低估约 5 倍，故单独处理）。
- **输出 token**：本质上不可预测，显示区间；会话内每次拿到实际值后按 `实际/预估中点` 的滑动均值校准后续预估（仅会话内，跨会话校准为后续版本）。
- 费用按当前北京时间的峰/谷价目、最近一次观测的缓存命中率估算，仅供参考，以扣费为准。

## 技术说明

- 纯客户端插件：`dsh.client` 声明 + `exports["./client"]`，无 host 逻辑；不向 session 日志追加任何自定义事件（自定义事件会导致持久化回读失败），因此对会话日志零侵入。
- 通过 `ConversationNodeDefinition`（`cost-context` 捕获提问、`cost-estimate` 生成聊天行）与 `conversation.chat.node` slot 渲染。
