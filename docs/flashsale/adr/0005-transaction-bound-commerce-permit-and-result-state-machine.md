# ADR-0005：绑定 Workflow Transaction 的 Commerce Permit 与结果状态机

- 状态：已接受（Phase 1E-2A）
- 日期：2026-09-20
- 适用范围：FlashSale Checkout Safety Kernel
- 关联设计：`docs/flashsale/technical-design.md` 第 13 节
- 修正：ADR-0004 中“Lease/Cart Lock 足以阻止旁路借用”的不完整假设

## 上下文

仅把 Completion Authorization 绑定到 Cart、Worker 和 Lease Epoch 仍有借用窗口：Owner
完成授权后、真正进入 `completeCartWorkflow` 前，普通 Store Complete 或另一个直接 Workflow
调用可能看到同一条 Active Authorization。Cart Lock 能串行化执行，却不能证明当前进入公开
`validate` Hook 的调用就是获得授权的调用。

Medusa 的公开 Workflow Hook Invoke Handler 第二个参数是稳定的 `StepExecutionContext`，其中
包含实际 `transactionId`。Workflow `.run({ context: { transactionId } })` 会保留服务器显式
提供的 ID；未指定时会生成新的 `auto-*` ID。因此可以在不依赖隐藏 Hook、不修改
`completeCartWorkflow` 输入的前提下，把 Permit 绑定到实际 Commerce Transaction。

## 决策

1. `commerce_transaction_id` 在任何 Commerce 副作用前由 Checkout Module 生成并持久化，
   不从客户端接收。Guard 从 Hook Context 读取实际 `transactionId`，并要求它与 Execution
   完全一致。
2. 客户端 Idempotency Key 不原样持久化或记录。`command_id` 只接受服务器派生的 64 位小写
   十六进制摘要；Replay 同时核对 Command Digest、Cart、Subject 和 Request Hash。
3. 专用 Native Complete Bridge 使用持久 `commerce_transaction_id` 调用原生
   `completeCartWorkflow`，并传递 Parent Step Idempotency Key，使内层 Cart Lock 在未来外层
   Workflow 已持有同一 Cart Lock 时跳过。Bridge 不复制 Order、Inventory 或 Payment 逻辑。
4. Bridge 的父级 Compensation 是 No-op。原生 Complete 自身失败仍执行自身补偿；但若
   Commerce 已成功、后续 Quota Consume 暂时失败，父级不得取消可能已经支付的 Order。
5. Commerce 结果必须通过带 `expected_version + worker_id + lease_epoch +
completion_authorized_epoch + commerce_transaction_id` 的精确命令写入：
   - 明确成功：`COMMERCE_PENDING -> COMMERCE_SUCCEEDED`，绑定唯一 `order_id`；
   - 明确失败：`COMMERCE_PENDING -> COMMERCE_DEFINITIVE_FAILED`；
   - 结果不明：`COMMERCE_PENDING -> COMMERCE_UNKNOWN`，设置下一次对账时间；
   - 所有结果写入原子清除 Lease 和 Completion Authorization。
     首次结果与终态命令分别保存服务器计算的 `commerce_result_hash` 和
     `terminal_command_hash`；重放必须与完整原命令一致，不能用不同 Worker、Version、Epoch、
     结果或对账间隔借用既有终态。
6. 只有 `COMMERCE_SUCCEEDED` 可以进入 `COMPLETED`，只有
   `COMMERCE_DEFINITIVE_FAILED` 可以进入 `CANCELED`。`COMMERCE_UNKNOWN` 不释放或消费
   Quota；Commerce 成功后的 Settlement 临时失败保留在 `COMMERCE_SUCCEEDED`，由 Replay
   继续 Consume。
7. 普通 Store Complete、未携带该服务器内部 Transaction 的直接 Workflow 调用，以及复用
   Complete 路径的其他入口，即使 Cart 存在 Active Lease，也必须在公开 Validate Hook 失败。

## Phase 1E-2A 边界

本阶段交付并验证 Transaction-bound Guard、Native Complete Bridge 契约和精确结果状态机，
但不宣称已交付完整 Checkout Happy Path。Phase 1E-2B 仍必须实现并用真实
`medusaIntegrationTestRunner` 证明：

```text
可信服务端快照 / Replay First
-> Claim & Hold
-> Prepare Execution
-> Begin Settlement
-> Claim Lease
-> Acquire SAME Cart Lock
-> Re-authorize after Lock
-> Native Complete with bound Transaction
-> Persist Commerce Result
-> Release Cart Lock
-> Consume + Complete，或仅在明确失败时 Release + Cancel
```

Lease 在等待 Cart Lock 前可以 Claim，但获得锁后必须重新 Authorization；若等待期间 Lease
过期，必须释放锁并重新 Claim。不能把 Transaction Permit 当作 Cart Lock 的替代品。

## 不承诺

Phase 1E-2A 不承诺 Provider 网络 Exactly-once、Webhook Inbox、通用
`PAYMENT_UNKNOWN` 自动恢复、异步支付、Admission/JTI、多 Campaign Checkout，也没有完整
HTTP/Store Full-app Happy Path 证据。在 1E-2B 的真实应用测试通过前，不得宣称端到端 Checkout
闭环。
