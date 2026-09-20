# ADR-0007：Authenticated Canonical Checkout Boundary

- 状态：Accepted
- 日期：2026-09-20
- 范围：Phase 1E-2B2

## 背景

Phase 1E-2B1 已有可执行 Checkout Orchestrator，但它只接受标注为 Server Canonical 的命令，尚未提供
不可信 Store HTTP 边界。如果 Route 直接转发 Subject、Items、Campaign 或 Rules，攻击者可以绕过
Cart Ownership、活动重叠和规则版本检查；如果 Route 与 Complete Guard 分别实现候选解析，两者也可能
在 `SCHEDULED` 与 `ACTIVE` 重叠时产生分歧。

Medusa System Payment Provider 可以稳定证明同步成功，但真实物理库存预留失败由 Inventory Module 抛出
无 Error Code 的 `NOT_ALLOWED`。依赖消息匹配会把未来文案变更变成资金正确性风险。

## 决策

1. Store 入口固定为 `POST /store/flash-sales/{campaign_id}/checkout`，Body 严格为 `{ cart_id }`，仅支持
   已认证 Customer；Subject 只来自 `auth_context.actor_id`，Path Campaign 使用有界字符集 Schema 校验。
2. `Idempotency-Key` 在边界校验后立即用 Domain-separated SHA-256 派生；只把摘要交给后续层，原 Key
   不持久化、不记录业务日志。
3. Canonical Reader 只用公开 Query/Module API 读取 Cart，并在服务端派生 Variant 数量、Campaign Item、
   Campaign 和 Rules Version。URL Campaign 只是 Exact-match Assertion，不是规则来源。Reader 必须接收
   `publishable_key_context.sales_channel_ids`，并要求 Cart Sales Channel 属于该服务端 Scope；Scope 缺失或
   为空时 Fail Closed。
4. Reader 与 Guard 共用同一 Candidate Resolver：先考虑 `SCHEDULED + ACTIVE` 排除重叠，再要求唯一
   Candidate 为 `ACTIVE`。任何缺失、歧义、Owner 不匹配、Custom Item 或 Snapshot 漂移都 Fail Closed。
5. Route 保持薄层：认证、输入校验、Key Hash、Canonical Assemble、调用 B1 Orchestrator、稳定 HTTP 映射。
   对外只暴露 `completed`、`in_progress`、`unknown`、`canceled`。
6. Commerce Adapter 使用 `throwOnError: false` 的公开 Workflow Result。只有同时满足以下公开证据才把
   Inventory Stage 视为 Definitive：唯一 TransactionStepError 的 `action` 为公开
   `reserveInventoryStepId`，`handlerType` 为 `INVOKE`，且 Transaction State 为 `REVERTED`。返回通用
   `INVENTORY_STAGE_REVERTED`；不解析消息，也不声称 `INSUFFICIENT_INVENTORY`。
7. 所有 Generic Throw、Payment-stage Failure、未完整补偿或 Guard 拒绝都为 `UNKNOWN`，保留
   `QUOTA_COMMITTING`，不自动重试 Payment。
8. Existing Execution 查询先于 Cart Readiness/完成状态/当前 Snapshot 校验。认证 Subject、URL Campaign、
   Cart 和派生 Command Hash 必须与持久化身份完全一致；所有合法状态（包括 `PREPARED` 与
   `COMMERCE_PENDING`）都用不可变 Execution Item Snapshot 恢复。Ownership 与 Publishable Key Scope 仍
   每次校验；不同 Key 不得恢复。若 Native Complete 已提交而 Result 落库失败，过期 Lease 接管必须复用
   持久化 `commerce_transaction_id` 恢复同一结果。
9. Cart 不存在、Owner 不匹配和 Publishable Key 无 Sales Channel 权限对外统一为同一 404 与通用消息，
   不在响应或业务日志中泄漏 Cart/Customer 事实。

## 结果

- 客户端无法伪造购买主体、购物项、Campaign Rules 或内部执行配置。
- Route 与 Guard 的 Campaign 判定不会因重复实现而漂移。
- 只有能证明 Commerce 尚未越过库存预留且补偿已完成的失败才释放 Quota；其余场景宁可进入人工/后续
  对账，也不冒重复支付或误释放风险。
- Full-app 测试必须从构建后的 Plugin 目录启动真实 Medusa App 和 PostgreSQL，并验证 Route、Hook、Module
  Autoload 以及 Order/Reservation/Quota 的持久结果。

## 未覆盖范围

Guest Checkout、Async/Requires-more Payment、Provider Webhook Inbox/Dedupe、通用 UNKNOWN Reconciler、
Provider 网络 Exactly-once、Admission/JTI、Multi-campaign 和 Cross-region Checkout 不在本阶段。System
Payment Provider 也不能提供确定的同步 Decline/Webhook 证据；在专用确定性 Provider Fixture 完成前，
不得宣称这两条路径已端到端验证。

## 验证

- Unit/Contract：认证、Path/Strict Body、Publishable Key Scope、Domain-separated Hash、共享 Candidate
  Resolver、不可变 Pending Replay、Owner/No-row 同响应、防错误码泄漏、Inventory Stage + REVERTED 分类及
  Upstream Source Contract。
- Full-app：普通 Cart、Direct/HTTP 绕过、Happy/Replay、不同 Key Race、Permit Borrowing、Lease Crossing、
  Lease Takeover/Old Epoch Fence、Settlement Retry、Native Success 后 Result 落库故障恢复、完整 HTTP/Auth/
  Publishable Key 负向边界、Owner 枚举防护、Cart Mutation 和库存阶段完整补偿。
- 工程门禁：Plugin Unit、PostgreSQL Integration、Multiprocess、Typecheck、ESLint、Build、Migration Drift。
