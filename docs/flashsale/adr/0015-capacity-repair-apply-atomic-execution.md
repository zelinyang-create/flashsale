# ADR-0015：Capacity Repair Apply 原子执行、幂等与 Outbox

- 状态：Accepted（Phase 2A-3d-2）
- 日期：2026-09-21
- 关联：ADR-0012、ADR-0013、ADR-0014

## 背景

ADR-0014 冻结了 Plan v2、可信审批和 append-only receipt Schema，但没有授权修改 Capacity。执行阶段必须在
在线 Writer/Provision 并发、响应丢失、事务重试和 Outbox 投递状态变化下仍保持可证明的原子性与幂等性。

## 决策

### 1. 单连接、单事务和固定锁序

Apply 先用 server-hashed request identity 获取有界 session advisory mutex，再在同一固定连接创建
`REPEATABLE READ` 可写事务。事务依次取得 Movement shared lock、Campaign lock、Policy、Control、Checkpoint、
Attempt、Subject、Capacity、Hold，最后才锁 Plan 审计行。新鲜执行显式要求目标 Campaign 至少一个 live CLOSED
Policy，每个 Policy 至少一个 live CLOSED Capacity；OPEN、非法状态、软删除或空 scope 全部拒绝。

所有业务锁取得后才重新扫描完整物理证据，并以 3b/3c 共用 projector 和 Plan v2 canonical evidence 核对完整
Action Set。调用方提供的 counter、version 或 classification 不作为权威输入。

### 2. 只允许安全 Counter CAS

自动 Apply 仅接受 `HELD_QUANTITY_DRIFT`、`CONSUMED_QUANTITY_DRIFT` 和对应 raw mirror 修复。每条 Capacity
同时比较 version、before logical/raw counter、live CLOSED 状态，再把 held/consumed logical/raw 更新为 Plan
expected 值并递增 version。Granted、Subject、Ledger、Policy 和 Plan 永不由 Apply 修改；任一 CAS 零行使整个
事务回滚。

### 3. Receipt 与 Repair Outbox 原子提交

Capacity CAS、不可变 ApplyIdentity/Run/Action receipt 和
`flash_sale.capacity_repair.applied.v1` Outbox 在同一事务提交。Repair envelope 固定
`aggregate_type=capacity_repair_apply`、`schema_version=1`、`aggregate_version=1`，payload 和 Action IDs 使用共享
canonical/hash 规则。Dispatcher 必须在 Apply 启用前部署对应 Subscriber manifest；缺少 Subscriber 时启动门禁
拒绝 claim，避免未知事件毒化旧队列。

### 4. 幂等重放和有界事务重判

成功后的同 request replay 只核验物理 Apply identity/run/actions 和 Outbox 不可变字段，不要求 Capacity 仍保持
刚修复后的 version，也不要求 Outbox 仍为 pending。投递状态、租约、重试和发布时间可合法变化；事件身份、
payload/hash、发生/创建时间及软删除状态不可变化。

不同 request 重复消费同一 Plan，或同 issuer/JTI 跨 Plan/Campaign 重用，均返回稳定
`REPAIR_APPLY_CONFLICT`。`40001`、`40P01` 以及仅限 Plan/JTI 两个命名唯一约束的 `23505` 最多重开一次全新
事务快照，再按 request→Plan→JTI 顺序重判；第二次序列化/死锁映射为 `LOCK_TIMEOUT_RETRYABLE`。其他
`23505` 原样 fail closed，绝不泛化为 replay。

### 5. 审批使用数据库时钟

可信 Verifier 的审批绑定在进入事务前完成；Store 在 CAS 前及 Outbox 后、commit 前分别使用
`clock_timestamp()` 重验 IAT/NBF/EXP。锁等待期间过期的审批不得提交任何 Counter、receipt 或 Outbox。

## 后果与边界

- 单次成功要么同时提交 Capacity、receipt、Outbox，要么全部回滚；
- 响应丢失可 exact replay，后续合法业务生命周期不会破坏 replay；
- 3d-2 已交付单进程真实 PostgreSQL 并发、回滚、过期和重放门禁；
- 多进程 kill/crash、连接 quarantine 故障注入、真实 Subscriber 端到端及生产演练仍属于 Phase 2A-3d-3。

