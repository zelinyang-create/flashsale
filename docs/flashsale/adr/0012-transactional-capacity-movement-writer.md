# ADR-0012：事务内 Capacity Movement Writer 与精确重放

- 状态：已接受（Phase 2A-2a）
- 日期：2026-09-21

## 背景

Phase 2A-1 建立了可验证的 opening baseline，但没有把在线余额变更写入 Movement。若 Balance、Attempt、
Hold、Movement 或 Outbox 分属不同事务，任一崩溃窗口都可能产生无法解释的余额；若 fresh transition 在
唯一键冲突后按 replay 处理，还可能提交第二次余额变化。

## 决策

1. 所有 Allocation 命令以 Movement Ledger shared transaction advisory lock 作为事务第一把应用锁；
   激活和降级检查使用同 namespace 的 exclusive 形式。
2. 保持既有业务锁顺序：Attempt → Subject → 按 Item/Shard 排序的 Capacity → Hold。
3. Hold 或 Settlement 完成最终 Attempt CAS 后，按 Item 顺序写 Movement，再写 Outbox；全部位于同一
   PostgreSQL 事务。
4. `transition_version` 使用结果 Attempt Version：Hold v2，Direct Cancel/Expire v3，Settlement
   Consume/Release v4；Begin Settlement v3 不移动 Bucket，所以 Ledger 允许版本缺口。
5. Movement 同时保存 numeric quantity、Medusa BigNumber `raw_quantity` 与不可变 tuple SHA-256。
6. Fresh path 的唯一键冲突无条件 fail closed。Replay path 必须验证 Capacity/Attempt/Campaign/Subject/
   Item、Version、Kind、Route、numeric/raw quantity 与 fingerprint；并按 `(attempt_id, transition_version)`
   读取含软删除行的物理全集，要求数量和 Item 集合与 Hold 完全闭合。额外、缺失、重复、部分或软删除
   Movement 均 fail closed。
7. Ledger 未激活时保持 Phase 1 行为；Ledger 激活后，每个被写 Capacity 必须有合法 Checkpoint。
8. 激活后 Provision 使用显式 `provision` Checkpoint 并在 Control 行锁下滚动全局 digest；热路径只验证
   目标 Checkpoint，不更新 Root。
9. `PurchaseAttempt.hold_movement_activation_id` 与 `terminal_movement_activation_id` 是持久化离散 binding。
   null 明确禁止对应 Movement；非 null 必须等于 Control Activation 并要求完整 Movement 集合。Fresh CAS
   与 binding 写入处于同一事务。

## Legacy Cutover

激活前已经存在的 Hold 被 opening checkpoint 吸收，不伪造历史 Hold Movement。激活后对该 Hold 发生的
Consume/Release/Expire 仍写真实终态 Movement。Replay 只依据上述持久化 binding 判断 Movement 是否
必须存在，绝不以 Hold/Attempt 的 wall-clock timestamp 与 Control 水位比较；因此数据库时间精度、人工
回填或等待锁期间的时钟位置不会改变账本语义。

## 证据与剩余边界

Phase 2A-2a 的真实 PostgreSQL 测试覆盖：

- Hold v2、Direct Release/Expire v3、Settlement Consume v4；
- 正常 replay、Movement 缺失或 raw 漂移 fail closed；
- 物理全集的额外/部分/软删除 Movement、binding 漂移 fail closed；
- Fresh Hold/Settlement 遇到预置完全相同 Movement 时全部余额回滚；
- 两 Item Hold/Consume/Release 的 exact set，以及第二 Item fresh 冲突的原子回滚；
- Movement 后、Outbox 前故障点的 Attempt/Hold/Balance/Movement/Outbox 全回滚；
- Legacy Cutover、并发 Provision Root、Activation 与 Writer 竞态守恒；
- v1 legacy root 精确重放，并在首次 Provision 原子升级为 kind-aware v2 root；
- 官方生成 migration、二次生成 no-drift、类型检查与插件构建。

跨进程 kill/crash、多个独立 Node 进程与更完整的 failpoint matrix 尚未由本 ADR 证明，归入 Phase 2A-2b。
Reconciliation、Rebuild 与 Repair 归入 Phase 2A-3。
