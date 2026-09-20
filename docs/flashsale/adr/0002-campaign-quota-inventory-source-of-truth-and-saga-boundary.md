# ADR-0002：Campaign Quota、Medusa Physical Inventory 与 Saga 边界

- 状态：已接受
- 日期：2026-09-19
- 适用范围：FlashSale Phase 1A 及后续阶段
- 关联设计：`docs/flashsale/technical-design.md` 第 3、6、8、9、11、12、13、14、16、17、24 节

## 上下文

FlashSale 同时受两类容量约束：活动愿意发放多少购买资格，以及仓库实际可以交付多少商品。二者语义不同、所有者不同，不能简单合并成一个 Redis counter 或一张库存副本表。

Campaign Quota 表示活动规则下可发放的资格，可能小于实际库存，并受到 Campaign 生命周期、规则版本、单用户限购和运营调整影响。Physical Inventory 表示 Medusa 管理的真实库存，并与普通订单共享。

Quota Hold、Medusa Reservation、Order 和外部 Payment 无法安全地置于一个数据库事务中。外部支付还存在请求超时但实际已成功的未知结果窗口。因此系统必须明确各自的事实来源和跨边界收敛方式，不能宣称全局 ACID 或 exactly-once。

## 决策

1. PostgreSQL 中的 FlashSale Campaign、Capacity、Allocation Hold、Purchase Attempt、Idempotency、Movement Ledger、Outbox、Inbox 和 Worker Lease 是活动域的事实来源。
2. Medusa Inventory 是 Physical Inventory 的唯一事实来源。FlashSale 不维护 stocked、reserved 或 available quantity 的权威副本。
3. Campaign Quota 是活动资格，不是物理库存。MVP 使用单 Capacity 记录；Advanced 可以使用固定 Escrow Capacity Shards，但所有 Materialized Balance、Movement 和 Hold 仍持久化在 PostgreSQL。
4. Redis 仅用于 Waiting Room、Admission、缓存和消息运输。Redis 丢失、重启或数据过期不得造成配额超发、物理库存超卖、重复订单或重复支付。
5. `ReservationBinding` 只保存 Attempt 与 Medusa Reservation 的关联，不复制 Reservation 或库存事实。
6. Quota 与 Physical Inventory 采用幂等 Saga 协作，推荐顺序为：
   1. 验证 Admission Token；
   2. 按持久化幂等记录创建或重放 Purchase Attempt；
   3. 原子执行 Quota `AVAILABLE -> HELD`，并在同一事务写 Attempt/Hold、Movement 和 Outbox；
   4. 通过 Commerce Adapter 调用 Medusa Inventory Reservation；
   5. 创建或绑定 Order；
   6. 使用稳定 Payment Command ID 执行支付；
   7. 支付成功后执行 Quota `HELD -> CONSUMED`；
   8. 明确失败时按已发生事实逆序、幂等补偿。
7. Quota 事务和 Physical Inventory 事务分别提交，不在它们之间持有数据库事务或分布式锁。中间状态允许短暂不一致，但必须持久、可观测、可重试和可对账。
8. 补偿以当前事实为依据：
   - 只有 Quota Hold：释放 Quota；
   - 已有 Physical Reservation：先幂等释放 Reservation，再释放 Quota；
   - Order 已创建且支付明确失败：取消 Order 并释放资源；
   - Authorization 成功：优先 Void；
   - Capture 成功但订单失败：Refund 后取消 Order并释放资源；
   - Payment `UNKNOWN`：不猜测失败、不更换 Provider Idempotency Key、不立即释放，进入查询、Webhook 或人工处理流程。
9. 所有 Attempt/Hold/Payment 状态转换使用 `state + version + optional fence token` 的 CAS。终态重放返回已有结果，不重复产生副作用。
10. Transactional Outbox 与业务状态在同一个 PostgreSQL 事务提交；消息可以重复投递，Consumer 通过 Inbox 唯一约束使同一事件的本地业务效果最多提交一次。
11. Reconciliation 分三层执行：
    - Plugin 内部 Balance/Ledger、Hold/Attempt 和 Outbox；
    - Medusa Reservation Binding、Order 与数量关系；
    - Payment Provider 的 Unknown、Late Capture、Void 和 Refund。
12. 对无法从本地事实安全推导的物理库存或支付差异，先暂停相关 Campaign Item，标记 `manual-required`，不得猜测修复。

## 理由

- Campaign Quota 与 Physical Inventory 代表两个不同业务约束，分别建模可以避免把营销规则污染库存模型。
- Medusa Inventory 同时服务普通订单和活动订单，只有 Medusa 能提供完整的物理库存视图。
- PostgreSQL 唯一约束、条件更新和事务可以提供活动配额、幂等和账本的可靠安全边界。
- 外部支付不具备与本地数据库相同的事务边界，Saga、稳定 Command ID 和事实驱动的补偿比 2PC 更现实。
- 持久化中间状态使进程崩溃后的恢复不依赖内存或 Redis。
- 显式区分 Safety 与有条件 Liveness，避免对永久网络分区或长期 Provider 故障作无法兑现的恢复承诺。

## 替代方案

### Redis 原子扣减同时代表配额和库存

不采用。Redis 数据可能丢失、过期或与 PostgreSQL/Medusa 分叉，也无法涵盖普通订单对共享库存的消耗。Lua 原子性只覆盖 Redis 内部，不能跨越 Medusa 和支付。

### 在 FlashSale 表中复制物理库存

不采用。它会产生双重事实来源；普通订单、退货、调拨和后台库存调整都可能使副本失真。

### 只使用 Medusa Inventory，不建 Campaign Quota

不采用。活动配额、单用户限购、规则版本和运营控制不是物理库存语义，且活动可售量经常小于真实库存。

### 跨 Quota、Inventory、Order 和 Payment 使用 2PC

不采用。Medusa Workflow、外部支付和消息系统不共享一个支持 2PC 的事务协调域；引入通用分布式事务框架会增加复杂度，仍无法消除支付 UNKNOWN。

### Payment 超时立即当作失败并释放资源

不采用。Provider 可能已经完成扣款；立即释放会造成已支付但库存/订单被释放，或者后续重试重复扣款。

### 以事件溯源替代所有 Materialized State

不采用。Movement Ledger 只用于配额移动和校验，不扩展为通用 Event Sourcing 或会计平台。在线路径保留 Materialized Balance 以获得简单、可预测的读取和更新成本。

## 后果

### 正面后果

- Redis 故障不会破坏核心业务不变量。
- Quota 和 Inventory 可以独立演进、测试和扩容。
- 每个失败窗口都有持久化证据、恢复入口和明确补偿策略。
- 相同 Idempotency Key、Payment Command 和 Event ID 可以安全重试。
- Movement Ledger 和 Reconciliation 能发现 Materialized Balance 漂移。

### 负面后果

- 跨模块关系只能最终收敛，监控中会出现合法的 Saga 中间状态。
- 需要 Expiry Worker、Outbox Publisher、Inbox、Reconciler 和 Manual Review 运维路径。
- Quota 已 Hold 但 Inventory 不足时需要补偿，短时间内会降低可见 available quota。
- Payment UNKNOWN 会延长资源占用时间，并要求配置 uncertainty grace period。
- 无法声称全局 exactly-once；准确承诺是幂等重试和本地效果去重。

## 验证方式

1. 活动配额不变量：持续验证 `available + held + consumed = issued_quota`、所有 bucket 非负、`held + consumed <= issued_quota`。
2. 物理库存不变量：对禁止 Backorder 的 FlashSale 路径验证 `0 <= reserved_quantity <= stocked_quantity`。
3. 绑定不变量：每个 Live FlashSale Reservation 有唯一 Binding；非成功终态 Attempt 在恢复边界后无 Active Reservation。
4. 幂等测试：同一 `(campaign_id, subject_id, idempotency_key_hash)` 并发 20 次只生成一个 Logical Attempt；同 Key 不同 Request Hash 返回 409。
5. 多实例并发测试：Quota 50、500 个 Attempt、两个至四个独立进程，至少重复 10 轮，要求零超发、零重复业务结果和零对账差异。
6. Failpoint：在 Attempt、Quota Hold、Inventory Reservation、Order Commit、Payment Send、Outbox Publish 后分别终止进程，重启后由重放、Expiry 或 Reconciliation 收敛。
7. Payment 测试：覆盖明确失败、请求超时、迟到成功、重复/乱序 Webhook、Void 和 Refund；UNKNOWN 时不得生成新 Command ID。
8. Redis 故障测试：Redis restart/down 期间系统可以降级或拒绝 Admission，但 PostgreSQL 和 Medusa 不变量必须保持。
9. Reconciliation 测试：分别构造 Balance/Ledger、Binding、Order 和 Payment 差异，验证 `dry-run`、`safe-repair` 与 `manual-required` 分类。
