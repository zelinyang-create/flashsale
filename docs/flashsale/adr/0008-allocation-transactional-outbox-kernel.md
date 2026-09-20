# ADR-0008：Allocation Transactional Outbox Kernel

- 状态：Accepted
- 日期：2026-09-20
- 范围：Phase 1F-A

## 背景

Allocation 的配额状态转换已经以 PostgreSQL 为事实来源，但如果在业务事务提交后再调用 EventBus，进程可能
在两者之间崩溃，形成“配额已变化、事件永久丢失”；如果先发消息再提交数据库，又可能让消费者看到最终回滚
的事实。Phase 1F-A 只解决可靠事件生产和数据库内投递状态，不把尚未实现的 Broker 发布冒充为端到端可靠投递。

PurchaseAttempt 的现有版本规则允许“一次可观察业务转换对应一个 Aggregate Version”：`PENDING v1` 不发事件，
`HELD/REJECTED v2`、`COMMITTING v3`、Settlement Terminal v4；从 HELD 直接 Cancel/Expire 为 v3。因此可以用
`(aggregate_type, aggregate_id, aggregate_version)` 表达唯一业务事实，无需放宽为一版本多事件。

## 决策

1. `flash-sale-allocation` 独占 `flash_sale_allocation_outbox_event` 和激活水位表；不存在中央 Outbox，也不与
   Campaign、Checkout 或 Medusa Core 建跨模块外键。共享能力只允许纯 Envelope/Catalog/Canonical Hash/Validation。
2. `QUOTA_HELD`、`QUOTA_REJECTED`、`QUOTA_COMMITTING`、`QUOTA_CONSUMED`、`QUOTA_RELEASED` 和
   `QUOTA_EXPIRED` 均在最终 Attempt CAS 成功后、同一 Allocation 数据库事务提交前追加事件。Expiry 复用同一
   Settlement 路径。重放不追加新事件。
3. 每个 Post-transition Attempt Version 只有一个不可变事件。唯一冲突时读取已有行并比较完整 Envelope 与
   Event Hash；完全一致视为提交响应丢失后的重放，任何漂移都回滚为 Outbox Invariant Violation。
4. Event Hash 覆盖 Event Name、Schema Version、Aggregate Type/ID/Version 和 canonical Payload；不覆盖随机
   Event ID 与数据库时间。Payload 只保存有界完整业务事实，Item 按 Campaign Item ID 的 UTF-16 code-unit
   字典序排序（显式 `<`/`>` 比较，不使用受运行环境 locale 影响的 `localeCompare`）；禁止 Subject、
   Idempotency/Request/Command 值或摘要、Token、Worker/Lease、Payment、原始异常进入 Payload。
5. `QUOTA_RELEASED` 明确区分 `held_cancel` 与 `settlement_release`。事件名和 Payload Schema 都显式版本化。
6. 数据库投递状态机为 `PENDING -> PUBLISHING -> PUBLISHED`，失败可以回到 `PENDING` 或进入
   `DEAD_LETTER`。Claim 使用有界 Batch、`FOR UPDATE SKIP LOCKED`、DB `clock_timestamp()`、Lease Epoch；
   Mark/Failure 必须携带精确 Worker 与 Epoch 且 Lease 仍有效。过期接管递增 Epoch，旧 Owner 只能得到 Fenced。
7. 每个 Aggregate 严格 Head-of-line：任何较低未 Published 事件（包括 Dead Letter）都会阻塞该 Aggregate 的
   高版本；不会阻塞其他 Aggregate。受控 Redrive 保持原 Event ID/Hash，仅重置交付尝试并增加 Redrive Count。
8. `activateAllocationOutbox({})` 持久化一次性 `OUTBOX_REQUIRED` 水位。水位之后更新的 Attempt 在业务重放时必须
   验证当前 Version 的预期事件；缺失或内容冲突时 Fail Closed。水位之前的 Legacy Attempt 明确豁免，因为当前
   Aggregate Row 无法证明完整历史。部署顺序是先迁移/代码，再停止旧 Writer，最后激活水位。
9. Allocation Reconciliation 在只读 Repeatable-read Snapshot 中检查激活后 Current Version 的事件缺失与事件名
   漂移；canonical hash 的精确验证仍由带业务快照的重放路径完成。
10. 所有 generated Outbox/Control CRUD mutation 都被封死；只开放 Server-side exact commands。Phase 1F-A 不新增
    Store Route。

## 当前保证

- 业务状态和对应 Outbox Row 原子提交或原子回滚。
- 同一 Aggregate Version 不会出现两个不同业务事实；并发/重放只保留同一 Event ID/Hash。
- 数据库中的 Claim、Lease、Fencing、Retry、Dead Letter、Redrive 与 Aggregate 顺序可由多 Worker 安全使用。
- 激活后的当前状态重放不会静默接受缺失或冲突的 Outbox Row。

## 明确不保证

Phase 1F-A **没有** EventBus/Broker Dispatcher、定时 Job、Broker Ack 集成、Consumer Inbox、消费者幂等、Webhook
Inbox，也没有端到端 At-least-once Delivery。`PUBLISHED` 只能由未来 Dispatcher 在获得真实 Broker Ack 后调用
exact mark command；本阶段的状态机测试不等于已经对外发布消息。历史事件完整性不能从当前 Aggregate Row 反推。

## 验证

- Unit：catalog、canonicalization/hash、排序、Payload 大小与敏感字段拒绝、exact command/bounds。
- PostgreSQL：六种转换各一事件、20 路并发重放、Expiry Race、两侧事务 Failpoint、响应丢失重放、激活水位、
  SKIP LOCKED、Lease Takeover/Old Epoch、Retry/Backoff/Max/Dead/Redrive、Head-of-line/Poison Isolation、跨锁等待
  Fresh DB Clock、generated CRUD 禁止、Reconciliation。
- Release：Migration Fresh/Upgrade/Down-up/No-drift、全 Unit/PG/Multiprocess、Typecheck、ESLint、Build。
