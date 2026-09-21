# Phase 2A-2b Capacity Movement Crash / Race Matrix

- 日期：2026-09-21
- 数据库：真实 PostgreSQL，独立库 `medusa-flash-sale-allocation-movement-crash`
- 进程模型：Jest 父进程 + 两个独立 Node Worker
- 命令：`yarn test:movement:crash`
- 执行方式：`--runInBand`

## 协议

Crash 请求只包含一个业务操作。Worker 命中精确 failpoint 后，等待
`failpoint_reached` 协议行的 stdout write callback 完成，再永久 pending；父进程收到完整行后调用
`child.kill()`，要求返回 true，有界等待 exit，并立即观察 pending Promise 的 rejection；测试保存并断言
`kill_issued/exited_after_kill` 终止观测。Kill 后不使用 sleep，而是执行需要 exclusive advisory lock 的
Activation replay；它成功返回即证明旧事务连接已退出且 PostgreSQL 已完成回滚。

竞态用例的每个 Worker 使用唯一 PostgreSQL `application_name`。持锁 Worker 在精确锁内 failpoint 握手后
暂停，父进程派发竞争请求，并有界轮询 `pg_stat_activity`/`pg_locks`；只有观测到竞争 backend 的
`wait_event_type='Lock'`、未授予的 `advisory` lock，且 `pg_blocking_pids(contender_pid)` 明确包含 holder
Worker 唯一匹配的 backend PID 后，才真实 kill holder。Promise pending 本身不作为并发证据。

Harness 另有异常清理回归：注入首次 kill 未发出，断言原始错误同时拒绝 crash 与 pending result，`close()`
立即幂等返回；stdio 被销毁并 best-effort 再次 kill，exclusive Activation replay 证明旧事务连接已经释放。

所有物理行计数都不加 `deleted_at is null`，软删除行同样计入失败证据。测试不固定 Windows/Linux 的
exit code 或 signal。

## 矩阵

| 场景 | 竞争或崩溃点 | 必须成立的不变量 | 结果 | 本机耗时 |
|---|---|---|---|---:|
| A | 两 Item Hold：第一条 Movement `INSERT ... RETURNING` 后 kill | Attempt/Hold/Movement/Outbox 物理行均为 0，Capacity held=0；同命令重试 fresh 后 replay，最终恰好两条 v2 Hold | 通过 | 5.438s |
| B | Consume：v4 Movement 与 Outbox 已写、commit 前 kill | Attempt 保持 v3/COMMITTING，Hold/余额不变，无 v4 Movement/Outbox；重试后恰好一条 v4 Consume，随后精确 replay | 通过 | 4.027s |
| F | 注入首次 kill 返回 false | crash 与 pending result 保留同一原始错误；全部计时器清理，close 立即返回；best-effort kill 后 Activation replay 证明事务释放 | 通过 | 4.410s |
| C | Hold writer 已持 shared Movement lock；Activation 被观测为 Lock wait 后 kill writer | 被 kill 的 Hold 全回滚；Activation fresh；重试 Hold fresh 后 exact replay；`opening held=0 + Hold delta=2 = materialized held=2`，binding 非空 | 通过 | 4.179s |
| D | Active Provision 已持 Campaign lock；同命令 duplicate 被观测为 Lock wait 后 kill holder | 竞争方一次 fresh、重试一次 replay；恰好一个 Policy/Capacity/provision Checkpoint/Control，完整 Root 可重放 | 通过 | 4.036s |
| E | First Activation 已持 exclusive Movement lock；First Provision 被观测为 Lock wait 后 kill Activation | Provision fresh；重试 Activation fresh 并建立唯一 cutover Checkpoint；Provision exact replay；Root 可重放且无 Movement | 通过 | 3.832s |

套件总耗时为 36.939 秒。该数字只记录本机回归成本，不是线上吞吐或延迟 SLA。

## 结论与边界

矩阵证明：PostgreSQL 事务能在真实进程终止时原子回滚 Balance/Attempt/Hold/Movement/Outbox；数据库级
lock-wait 观测证明 shared/exclusive advisory lock 确实把 Activation、Writer 和 Provision 排成指定合法
顺序；重复 Provision 不会产生第二套 Capacity 或污染滚动 Root。

本矩阵不替代 Phase 2A-3 的 Reconcile/Rebuild/Repair，也不覆盖主机断电、PostgreSQL failover 或磁盘损坏。
