# ADR-0012：事务内 Capacity Movement Writer 与精确重放

- 状态：已接受（Phase 2A-2a/2b）
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
   Item、Version、Kind、Route、numeric/raw quantity 与 fingerprint；并一次读取 Attempt 下含软删除行的
   全部物理 Movement，按 state/version/binding/Hold 推导允许的 Version、Kind、Item 精确并集。额外、
   缺失、重复、部分或软删除 Movement 均 fail closed。
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

## 跨进程 Crash 协议

Phase 2A-2b 使用独立 Node 子进程和真实 PostgreSQL 连接，不用抛异常冒充进程崩溃。父进程发送
`execute_until_failpoint`，每个 crash 请求只允许一个业务操作；子进程在精确数据库写点命中后，先等待
stdout 的 `failpoint_reached` 完整写入回调，再永久挂起而不提交或回滚。父进程收到完整协议行后才执行
`child.kill()`；Windows 下由 Node 落到 `TerminateProcess`。测试不假设具体 exit code/signal，也不用 sleep
猜测连接清理，而是断言 kill 已成功发出、子进程随后退出，并用需要 exclusive advisory lock 的 Movement
Ledger 激活重放作为 rollback barrier。

竞态用例为每个 Worker 设置唯一 PostgreSQL `application_name`。持锁方在取得 shared/exclusive Movement
advisory lock 或 Campaign lock 后发送已 flush 的握手并暂停；竞争方发出后，父进程有界轮询
`pg_stat_activity` 与 `pg_locks`，只有观测到该竞争 backend 的 `wait_event_type='Lock'` 且存在未授予锁，
并确认该锁是未授予的 `advisory` lock、`pg_blocking_pids(contender_pid)` 明确包含唯一匹配的 holder
backend PID，才终止持锁进程。因而测试证明的是真实锁竞争与明确线性化，而不是池内其他连接或两个
Promise 可能串行执行的偶然结果。

若首次 kill 未发出或等待 exit 超时，Harness 保留原始错误并立即进入 failed：清除所有请求计时器，拒绝
pending/result/reach promises，使 `close()` 幂等返回；随后销毁 stdio、再次 best-effort kill 并仅短时有界
等待，避免异常路径退化为 120 秒 shutdown request 或遗留子进程句柄。

Failpoint 由独立 `AllocationFaultInjector` 契约定义，并按请求注入 Store/Producer：

- `after_first_capacity_movement_append`：两 Item 写入中第一条 `INSERT ... RETURNING` 成功后；
- `after_outbox_append_before_commit`：Outbox 已写入、事务提交前；
- `after_movement_writer_shared_lock`：Writer 已取得 Movement shared advisory lock；
- `after_movement_ledger_exclusive_lock`：Activation 已取得 Movement exclusive advisory lock；
- `after_provision_campaign_lock`：Provision 已取得 Campaign advisory lock。

## 证据与剩余边界

Phase 2A-2a/2b 的真实 PostgreSQL 测试覆盖：

- Hold v2、Direct Release/Expire v3、Settlement Consume v4；
- 正常 replay、Movement 缺失或 raw 漂移 fail closed；
- 物理全集的额外/部分/软删除 Movement、binding 漂移 fail closed；
- Fresh Hold/Settlement 遇到预置完全相同 Movement 时全部余额回滚；
- 两 Item Hold/Consume/Release 的 exact set，以及第二 Item fresh 冲突的原子回滚；
- Movement 后、Outbox 前故障点的 Attempt/Hold/Balance/Movement/Outbox 全回滚；
- Legacy Cutover、并发 Provision Root、Activation 与 Writer 竞态守恒；
- v1 legacy root 精确重放，并在首次 Provision 原子升级为 kind-aware v2 root；
- 官方生成 migration、二次生成 no-drift、类型检查与插件构建。
- 两 Item Hold 在第一条 Movement 已写入后被真实 kill，rollback barrier 后所有物理行和余额为零；同命令
  随后 fresh 成功，再次调用精确 replay；
- Consume 在 Outbox 已写入但未提交时被真实 kill，Attempt 保持 v3/COMMITTING，Hold、余额、Movement、
  Outbox 均停留在提交前状态，重试只产生一组 v4；
- 独立进程下 Activation/Writer、Active Provision/duplicate replay、First Activation/First Provision 的
  合法线性化、守恒和完整 Root。

完整矩阵与本机耗时见 `benchmarks/phase-2a-2b-movement-crash-matrix-2026-09-21.md`。这些证据证明的是
事务原子性和线性化，不是吞吐 SLA。Reconciliation、Rebuild 与 Repair 仍归入 Phase 2A-3。
