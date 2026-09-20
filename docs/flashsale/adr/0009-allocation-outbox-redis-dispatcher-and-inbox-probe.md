# ADR-0009：Allocation Outbox Redis Dispatcher 与 Transactional Inbox Probe

- 状态：Accepted
- 日期：2026-09-20
- 范围：Phase 1F-B1

## 背景

Phase 1F-A 已经保证 Allocation 业务事实与 Outbox Row 原子提交，并提供数据库内 Claim/Lease/Fencing，但尚没有把
事件交给任何 Durable Provider。直接在业务事务内调用 EventBus 会把网络延迟带进数据库锁区；把任意 EventBus
返回都当作持久接受，则 Local Provider 的进程内异步调用也会制造虚假 Ack。

## 决策

1. 生产 Dispatcher 只依赖窄化的 `AllocationOutboxPort` 与 `AllocationEventTransport`。它在短数据库事务中 Claim，
   释放行锁后再访问网络，获得 Provider Acceptance 后才用精确 Worker ID/Lease Epoch Mark Published。
2. 当前唯一允许的 Provider 是显式配置的 Medusa Redis EventBus。`emit` resolve 的含义钉死为 BullMQ `addBulk`
   Queue Acceptance；它不代表 Subscriber Handler 成功。Local、Unknown、Custom Provider 均在 Claim 前拒绝。
3. Redis 模块、Worker/Shared Mode、完整版本化 Subscriber Manifest 和 Mark Lease Budget 都必须在 Claim 前通过
   Guard。事件没有可配置 Destination Remap：每个事实只按自身 Canonical `event_name` 发布。Manifest 必须逐事件
   列出预期 Subscriber ID，运行时要求该事件的 Exact Registration 与 Manifest 完全一致；Wildcard 不构成覆盖。
   `mark_timeout + safety_margin` 必须严格小于 Lease。
   Medusa 2.21 的 `IEventBusModuleService` 尚未声明 Subscriber 查询接口；Guard 只读使用
   `AbstractEventBusModuleService.eventToSubscribersMap` 公共 Getter，并以源契约测试钉住。这是明确记录的上游脆弱点，
   Getter 缺失时 Fail Closed，而不是跳过检查。
4. Acceptance 之前的明确失败可用 sanitized finite error code回到 Pending/Dead Letter；Acceptance 之后的 Hook、
   Mark Error 或 Mark Timeout 一律保留 Publishing，等待 Lease Takeover。旧 Epoch 永远不能完成新 Owner 的事件。
5. 每 Tick Claim 数量等于配置的 `concurrency` 上限并立即 `allSettled` 并发处理；单个 Poison Event 不阻塞其他
   Aggregate。进程内 overlap guard 是性能保护，不承担正确性。
6. 生产 Job 默认禁用，只有显式配置才运行；Worker ID 是进程启动时生成的稳定值。当前只有每 Tick 一条结构化安全
   日志，字段是固定的状态计数，不记录 Payload、Event/Aggregate 动态 ID、Redis URL、PII 或原始异常。Backlog、
   Oldest Age、Publish Latency、Retry/Dead/Fenced Metrics 尚未实现，属于后续观测性工作。
7. 测试工程提供独立 `allocationEventProbe` Module 与固定 Subscriber ID。该 Module 自有 Inbox/Effect/Cursor 表，
   与 Allocation 无 FK、Import 或跨模块 SQL；严格验证 Envelope/Hash 后，在单个本地事务内提交 Inbox、Effect、Cursor。
8. Probe 的第一个可见 Aggregate Version 是 2。Exact Duplicate 成功但只增加 Delivery Count；Event Drift、Aggregate
   Version Conflict、Gap 和 Unknown Stale Event Fail Closed。两个 Failpoint 分别验证 Inbox 后、Effect 后崩溃会全回滚。
9. Probe 只存在于独立 Full-app Fixture，不随生产 Plugin 注册，不能被描述为 Production Inbox。

## 当前保证

- Allocation Outbox 网络发布期间不持有 PostgreSQL Outbox 行锁。
- 在明确 Redis 配置下，`PUBLISHED` 表示该 Event 曾获得 Redis/BullMQ Queue Acceptance。
- Acceptance 后崩溃会以相同 Event ID/Hash 重投；旧 Owner/Epoch 无法 Mark。
- 具体测试 Consumer 的 Inbox、Effect、Cursor 原子提交，同一 Event 的本地 Effect 最多提交一次。
- Redis 网络中断不会误写 Published。共享 Redis EventBus 不配置全局 `commandTimeout`，因为它会破坏 BullMQ 的阻塞
  Worker 命令；断线期间 `emit` 可以保持 Pending。单实例 overlap guard 将悬挂限制为一个 Tick，Lease 到期后允许其他
  实例接管。连接恢复后，原 `emit` 只有真正 resolve 才尝试 Mark；若 Lease 已过期则被 Fence，随后 Takeover 重投并排空。

## 明确不保证

- Queue Acceptance 不等于 Subscriber Success，也不证明 Redis AOF/RDB、Replication、HA 或跨 Region Durability。
- 不保证 Exactly-once Delivery；Redis reconnecting `emit` 没有可证明能取消底层 `addBulk` 的外层超时，重复投递是协议
  允许且必须被 Consumer 处理的。
- 没有 Production Consumer Inbox、Checkout Outbox、Webhook Inbox/Dedup、通用 UNKNOWN Reconciler 或死信运维 API。
- Test Probe 的 Transactional Effect 结论不能推广到未实现 Inbox 的其他消费者。

## 验证

- Unit/Contract：严格配置 Guard、Canonical Event/Exact Subscriber Manifest、Ack/Mark 分界、Poison Isolation、Overlap、Medusa Redis
  `emit -> addBulk` 源契约、Local Provider 非 Durable 语义。
- PostgreSQL：网络 Publish 悬停期间 `FOR UPDATE NOWAIT`、Inbox 两侧 Failpoint、Drift/Conflict/Gap/Stale、100 路重复。
- Real Redis Full-app：Module/Job/Subscriber Autoload、正常 Published、Accepted-before-mark Takeover/Duplicate、旧 Epoch
  Fenced、动态端口 Redis Fault Proxy Down/Restore、同一 Effect/Cursor 一次，以及应用先于 Proxy 的干净关闭顺序。
- Release：全 Unit/PG/Multiprocess/Full-app、Typecheck、ESLint、Build、Migration Fresh/Upgrade/Down-up/No-drift。
