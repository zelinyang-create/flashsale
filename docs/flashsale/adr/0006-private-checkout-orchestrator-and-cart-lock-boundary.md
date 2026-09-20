# ADR-0006：私有 Checkout Orchestrator 与 Cart Lock 临界区

- 状态：已接受（Phase 1E-2B1）
- 日期：2026-09-20
- 适用范围：FlashSale Checkout Outer Orchestration Kernel
- 关联决策：ADR-0005

## 背景

Phase 1E-2A 已交付 CheckoutExecution 结果状态机和绑定 Workflow Transaction 的 Commerce
Permit，但没有执行外层 Checkout。外层必须在同一个 Cart Lock 临界区内完成锁后重新授权、
原生 Complete 和 Commerce 结果持久化；Commerce 成功或结果未知后，后续 Quota/数据库瞬时
失败绝不能触发对 Order 或 Payment 的父级补偿。

Medusa Workflow SDK 的 Constructor 用于声明图，不能在其中用普通运行时 `try/catch` 安全地
分类嵌套 Commerce 结果。`ILockingModule.execute` 的自动续租和 `AbortSignal` 也只覆盖单个
Callback，不能跨多个可独立调度的 Workflow Step 保持。因此本阶段不把普通 Imperative Helper
伪装成 Medusa Workflow。

## 决策

1. 实现私有、明确命名的 `FlashSaleCheckoutOrchestrator`。这里的“私有”是指没有公开 HTTP/
   不可信输入边界；其 TypeScript Factory 可以从 Package Root 导出，供未来服务器 Route
   装配。这种导出不是安全边界，Orchestrator 仍不接受客户端原始 Payload。
2. 输入类型命名为 `ServerCanonicalFlashSaleCheckoutCommand`。其中 Customer Subject、Cart、
   Campaign、Rules Version 和规范化 Item Mapping 必须由未来服务端边界读取并派生；
   `request_hash` 由 Orchestrator 本地重算，`attempt_id` 由 Allocation 返回，Worker 和超时配置由
   服务器生成。客户端原始 Idempotency Key/Token 不进入命令、不落库、不记录日志。
3. 每次调用首先按 `command_id + cart_id + subject_id + request_hash` 查询 Execution Replay。
   只有不存在 Execution 时才执行 Campaign Eligibility 与 `claimAndHoldQuota`，避免对
   `QUOTA_COMMITTING` 或 `QUOTA_CONSUMED` 重跑 Hold。
4. Fresh Path 的顺序固定为：

   ```text
   Replay First
   -> Claim & Hold
   -> Prepare Execution
   -> Begin Quota Settlement
   -> Claim Commerce Lease
   -> ILockingModule.execute(raw cart_id)
        -> Re-authorize current Worker/Epoch with fresh DB clock
        -> Authorize exact Allocation Settlement
        -> Native completeCart with persisted commerce transaction
        -> Persist Commerce result
   -> automatic Cart Lock release
   -> Consume + Complete，或 Release + Cancel
   ```

5. Cart Lock Key 必须与上游 `completeCartWorkflow` 相同，直接使用原始 `cart_id`，不能擅自加
   `cart:` 前缀。使用公开 `ILockingModule.execute`，由 Provider 自动续租并在 Callback 结束时
   释放。Runtime Adapter 在真正持锁的 Callback 内生成非秘密的关联 Key，并在当前 Runtime
   Registry 精确绑定 `key -> cart_id`；Native Adapter 同时核对活跃绑定与数据库中的
   `commerce_transaction_id` 授权。该 Key 会作为 `context.parentStepIdempotencyKey` 传播，Medusa
   可能把它写入 Workflow Metadata，因此安全性不得依赖 Key 保密。Callback 成功或抛错都会在
   `finally` 删除绑定；仅知道 Key、或仅看到“该 Cart 当前有人持锁”都不能借用授权。嵌套
   Complete 使用这个 Key，使上游 Acquire/Release Lock Step 只在真实父临界区内 Skip。
6. 等待 Cart Lock 后必须重新授权 Lease/Epoch。若等待期间 Lease 过期、Epoch 被接管或 Lock
   已丢失，只结束临界区并返回 In Progress；不得调用 Commerce，也不得释放
   `QUOTA_COMMITTING`。下一次 Replay 通过同一 Commerce Transaction 做 Fenced Takeover。
7. Commerce Success、Definitive Failure 或 Unknown 必须在 Cart Lock 内先持久化。锁释放后：
   - Success：Consume Quota，再将 Execution 标记 Completed；任一步失败都保留
     `COMMERCE_SUCCEEDED` 供 Replay 收敛，禁止取消 Order；
   - Definitive Failure：Release Quota，再将 Execution 标记 Canceled；
   - Unknown：保留 `QUOTA_COMMITTING + COMMERCE_UNKNOWN`，返回独立的 `status: "unknown"`，
     不重试 Payment；未来 HTTP Adapter 可将其映射为 202，但不能与普通处理中状态混淆；
   - 未持久化 Commerce 结果时不执行任何 Quota Terminal Settlement。
8. Production Native Adapter 只把上游明确的 `INSUFFICIENT_INVENTORY` 识别为 Definitive；
   其他未证明异常保守分类为 Unknown。同步支付 Decline 的精确分类必须由 B2 的真实 Test
   Provider 证据支持后再扩大。

## Replay 语义

| Execution 状态               | B1 行为                                             |
| ---------------------------- | --------------------------------------------------- |
| `COMPLETED`                  | 返回同一个 `order_id`                               |
| `COMMERCE_SUCCEEDED`         | 不再调用 Commerce；重放 Consume + Complete          |
| `CANCELED`                   | 返回稳定错误码                                      |
| `COMMERCE_DEFINITIVE_FAILED` | 不再调用 Commerce；重放 Release + Cancel            |
| `COMMERCE_UNKNOWN`           | 返回 `status: "unknown"`，不重试 Payment            |
| Active `COMMERCE_PENDING`    | 返回 In Progress                                    |
| Expired `COMMERCE_PENDING`   | 新 Worker/Epoch 接管；使用同一 Commerce Transaction |

## Crash、重试与多进程语义

Runtime Registry 属于单个 Orchestrator Runtime，不跨进程共享，也不会通过 Workflow Metadata
恢复。即使某个关联 Key 已经持久化或被完整获知，只要对应 Callback 已退出、进程已崩溃，或请求
到达另一 Runtime，它都没有活跃 Registry Membership，Native Adapter 必须 Fail Closed。恢复者
使用同一持久化 `commerce_transaction_id`，但必须在新的 Cart Lock Callback 中生成新的活跃绑定，
重新完成 Lease/Epoch 与数据库 Transaction 授权后才能进入 Native Commerce。

## Phase 1E-2B1 边界

B1 交付可执行的私有编排内核、Medusa Runtime Adapter 和确定性 Component Tests，但不宣称公开
Checkout 已上线。Phase 1E-2B2 仍必须交付：Authenticated Store Route、真实 Cart Canonical
Read、`medusaIntegrationTestRunner` 下的 Cart/Order/Inventory/Payment 系统测试，以及 Store
Route、Direct Workflow、Webhook 路径的防绕过证据。Provider 网络 Exactly-once、Webhook
Inbox、通用 Payment UNKNOWN 自动恢复、异步支付和多 Campaign Checkout 仍明确排除。
