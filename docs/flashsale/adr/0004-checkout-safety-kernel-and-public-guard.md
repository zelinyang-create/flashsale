# ADR-0004：Checkout Safety Kernel 与公开防绕过 Hook

- 状态：已接受
- 日期：2026-09-20
- 适用范围：FlashSale Phase 1E-1
- 关联设计：`docs/flashsale/technical-design.md` 第 9、13 节
- 修正：ADR-0002 第 6 条中的 Medusa Order/Inventory 顺序

## 上下文

Medusa `completeCartWorkflow` 的稳定输入只有 `{ id }`。它先获取 Cart Lock，再运行公开
`validate` Hook，然后创建 Pending Order；随后并行建立 Link、更新 Cart、创建 Physical
Reservation，最后 Authorize Payment Session。FlashSale 不能假设“先库存、后订单”，也
不能依赖未公开的 `beforePaymentAuthorization` 或 `orderCreated` Hook 作为安全边界。

如果 Quota 在普通 `HELD` 状态直接进入这段 Commerce 流程，TTL Worker 可能在 Pending
Order、Reservation 或 Payment 已产生后回收 Quota。仅靠 Checkout 表或应用内状态无法阻止
这个竞争，因为 Allocation 才是 Quota 的事实来源。

## 决策

1. Allocation 增加 `QUOTA_COMMITTING` 保护态。`beginQuotaSettlement` 在锁住 Attempt 和
   Holds 后读取新鲜的数据库 `clock_timestamp()`，确认 Hold 未过期，再绑定内部
   `settlement_id`。不得使用固定在事务起点的 `now()/transaction_timestamp()`。此时 Hold
   与 Counter 仍保持 `HELD`，但 Expiry 不再处理该 Attempt。
2. Settlement ID 是服务器生成的 `CheckoutExecution.id`，不是客户端 Idempotency Key。
   Consume/Release Settlement 必须携带相同 ID；终态重放也必须核对该 ID。
   不暴露 `QUOTA_HELD -> QUOTA_CONSUMED` 直达命令；尚未提交且未过期的 Hold 只能通过
   `cancelHeldQuota` 主动释放，已过期 Hold 必须由 Expiry 处理。
3. 新增独立 Checkout Module。它只拥有 `CheckoutExecution` 与
   `CheckoutExecutionItem`，不与 Campaign、Allocation 或 Medusa 表建立跨模块外键。
4. Execution 保存不可变的 Cart、Customer Subject、Campaign、Rules Version、Request
   Hash 和规范化 Item 指纹。Commerce Transaction ID 在副作用发生前持久化。
5. Commerce Worker 使用数据库时间 Lease 和递增 `lease_epoch`。Claim/Authorization 在行锁
   等待结束后读取新鲜 `clock_timestamp()`；Completion Authorization 持久绑定当前 Epoch；
   每次新 Claim 都清除旧 Authorization。所有有副作用的外层写入必须携带 Worker/Epoch 做
   CAS；旧 Epoch 更新零行。
6. 防绕过逻辑只注册 `completeCartWorkflow.hooks.validate`。普通 Cart 无活动命中且无既有
   Execution 时通过；活动或既有 Execution 必须同时满足：
   - 当前 Cart/Customer/Variant Quantity 与 Execution 完全一致；
   - Campaign Item 映射与 Execution Item 完全一致；
   - Allocation Hold 集合与 Execution Item 完全一致；
   - 使用 Allocation 规范化算法重算的 Request Hash 与 Attempt/Execution 都一致；
   - Execution 有 Active `COMMERCE_PENDING` Lease；
   - Attempt 为 `QUOTA_COMMITTING` 且 Settlement ID 等于 Execution ID。
7. 多 Campaign、混入 Custom Line Item、缺失 Execution、过期 Lease、服务异常或任何快照
   不一致均 Fail Closed。
8. 本阶段不实现外层 Complete Cart Happy Path、HTTP、Payment UNKNOWN、Webhook、
   Outbox 或 ReservationBinding，不以占位状态冒充能力。

## 正确性边界

完整顺序是：

```text
Quota Hold
-> CheckoutExecution / Commerce Lease
-> Quota COMMITTING
-> Pending Order
-> Physical Reserve
-> Payment Authorize
-> Quota Consume
```

Validate Hook 无法从 `{ id }` 获得原 Worker Epoch，因此不能单独证明调用者仍持有 Fence。
后续外层 Workflow 必须先获取同一 Cart Lock，在不释放锁的前提下完成 Lease Claim、Epoch
Authorization 并调用 `completeCartWorkflow`；Claim 不得提前到等待 Cart Lock 之前，短
Lease 必须覆盖整个临界区。Guard 对 Lease、Epoch Authorization 的读取采用同一数据库语句，
避免把旧 Epoch Authorization 与新 Epoch Lease 拼接。Guard 的职责是阻止普通 Store API
绕过，而不是替代外层 Cart Lock 和 Worker Fence。

Phase 1E-1 只提供真实 Public Hook 注册、Medusa 源码顺序契约和插件装载构建证据；没有
外层 Happy Path 就不能运行完整 `completeCart` Runner，也没有验证 Payment Webhook 或已完成
订单重放入口。Phase 1E-2 必须补真实交错测试，证明拒绝发生在零新增 Order、零新增
Reservation 之前；在此之前不宣称端到端 Checkout 已闭环。

## 已知上游风险

当前 `reserveInventoryStep` 对 Lock Key 去重但不显式排序；反向多 Item 请求可能把相反顺序
传给 Locking Provider。Phase 1E-1 只保留 Contract Evidence，不修改 Core。稳定排序和原子
库存原语必须由后续独立 ADR、Contract Test 与通用上游 PR 交付。

## 验证

- PostgreSQL begin-vs-expiry 多调用竞争，过期 Hold 只能由 Expiry 获胜；
- Settlement 同 ID 重放、异 ID 冲突、终态 Fence 与 Counter 一次迁移；
- Prepare 并发、Lease Takeover 与旧 Epoch 拒绝；
- Guard 普通 Cart、Custom Line Item、无 Execution、错 Customer/Cart/Quantity/Rules、错
  Campaign Item/Hold/Request Hash、多 Campaign 和依赖失败矩阵；
- Medusa 源码契约测试确认 Validate、Pending Order、Reserve、Authorize 顺序，并记录当前
  Multi-item Lock Key 未排序事实；
- Migration Fresh、Down/Up 和已有 Campaign/Allocation 数据升级。
