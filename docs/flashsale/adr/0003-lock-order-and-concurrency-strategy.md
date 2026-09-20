# ADR-0003：锁顺序与并发策略

- 状态：已接受
- 日期：2026-09-19
- 适用范围：FlashSale Phase 1A 及后续阶段
- 关联设计：`docs/flashsale/technical-design.md` 第 8、11、12、13、15、18、19、20、23、24、26、27 节

## 上下文

FlashSale 的主要性能和正确性风险来自热门 Campaign/SKU 的并发争用。应用副本增加后，如果所有请求仍竞争同一 Capacity Row、Inventory Item 或 Cart Lock，副本数只会增加等待者、数据库连接占用和 timeout，不会线性提高有效提交吞吐。

系统还存在多 Item 请求、Expiry/Confirm/Cancel 竞争、Worker 接管、Payment UNKNOWN 和 Outbox 重试。如果不同路径以不同顺序获得多个锁，容易产生死锁；如果用一把 Campaign 大锁包住整个 Checkout，则支付或下游延迟会把临界区放大。只依赖 optimistic retry 又可能在突发流量下制造 retry storm。

需要同时定义跨模块事务边界、模块内部固定锁顺序、并发上限、超时、重试和僵尸 Worker 防护。

## 决策

1. 不存在覆盖整个 Checkout Saga 的全局锁或全局事务。Quota、Physical Inventory、Order 和 Payment 分阶段执行；跨阶段通过持久化状态、幂等和补偿收敛。
2. 任何数据库锁或 Medusa Locking Provider 锁都不得跨越以下边界：
   - 外部 Payment/HTTP 调用；
   - Redis Waiting Room 或消息发布；
   - Medusa 之外的另一个模块事务；
   - 长时间计算、sleep 或不受控重试。
3. MVP 的 Campaign Quota 使用 PostgreSQL 条件更新，不使用 Redis lock，也不使用覆盖完整 Workflow 的 campaign advisory lock。事务内只允许 Campaign/Rule 确认、幂等 Attempt、Capacity 更新、Hold/Movement、Attempt 状态和 Outbox。
4. 多 Item Quota 操作按 `(campaign_item_id, capacity_shard_id)` 升序处理。Advanced Sharding 中先按 Rendezvous/Consistent Hash 选择 Primary Shard；Primary 不足时最多探测一至两个已排序候选，禁止在事务中扫描或锁定全部 Shard。
5. Physical Inventory 的并发控制复用 Medusa：
   - MVP 在调用现有 Reservation Workflow 前，对去重后的 `inventory_item_id` 进行稳定升序排序，并使用多实例 Locking Provider；
   - Advanced 原子库存原语按 `inventory_level.id` 升序执行 `SELECT ... FOR UPDATE`，在锁内重新读取库存并一次性创建全部 Reservation；任一 Item 不足则整个库存事务回滚。
6. 不同时持有 Quota Row Lock 与 Physical Inventory Row Lock。顺序是先提交 Quota Hold，再进入 Inventory Reservation；Inventory 失败时通过幂等 compensation 释放 Quota。
7. Cart/Order Lock 沿用 Medusa `completeCartWorkflow` 约定。FlashSale 不复制其锁实现，也不在获得 Cart/Order Lock 后重新获得 Campaign 或 Inventory 锁。
8. 默认使用 PostgreSQL `READ COMMITTED + 条件更新/Row Lock + 固定顺序`。不把全局隔离级别提升为 `SERIALIZABLE`。唯一约束、Request Hash 和状态 CAS 负责幂等与冲突检测，锁不能替代这些约束。
9. `Confirm`、`Cancel`、`Expire`、Payment Reconciliation 等竞争状态转换使用 `WHERE state = :expected AND version = :version` 的 CAS。更新零行时必须重读最新状态并按事实继续或结束，不能覆盖新状态。
10. 短后台任务使用 `FOR UPDATE SKIP LOCKED` 和有界 batch。可能跨网络调用或长时间运行的任务使用 PostgreSQL Lease；每次获取/接管 Lease 都递增 `lease_epoch`，所有后续写入携带 fence token。旧 Worker 的更新必须影响零行。
11. 每层使用同一个请求 Deadline 递减预算，不为数据库、库存、支付和补偿分别重新获得完整 timeout。配置独立的：
    - admission queue timeout；
    - DB checkout timeout；
    - transaction/lock timeout；
    - payment timeout；
    - compensation/reconciliation budget。
12. PostgreSQL deadlock、serialization/lock timeout 只允许有限次数的 backoff + jitter 重试。超过预算返回稳定的 `LOCK_TIMEOUT_RETRYABLE` 或 `COMMIT_PLANE_OVERLOADED`，不进行无限重试。
13. API Process 采用有界 Global Semaphore 与 Per-campaign Semaphore；API 与 Worker 使用独立数据库连接池预算。总 Admission Budget 不得随 API Replica 数无约束增长。
14. Fixed Admission 是 MVP 默认策略。Adaptive Admission 只根据延迟、Pool Wait、Quota Transaction、Hot-key Lock Wait、timeout/5xx 和 Event-loop Lag 调节进入 Commit Plane 的速率，不参与配额或库存正确性。
15. 任何锁优化都以数据证明为前提。先测量 Hot-row service time、row/lock wait、DB pool wait 和 goodput，再决定是否由 `K=1` 演进到固定 Capacity Shards。

## 理由

- 将外部调用排除在临界区外，可以避免 Payment 或网络延迟放大 hot-key lock wait。
- Quota 与 Inventory 不同时持锁，消除了跨模块嵌套锁的主要死锁环路；代价由 Saga compensation 明确承担。
- 固定排序使多 Item 请求无论客户端输入顺序如何，都以相同顺序获取资源。
- PostgreSQL 条件更新把“检查剩余配额”和“占用配额”合并为一个原子操作，缩短单 hot row 临界区。
- `READ COMMITTED + Row Lock/CAS` 的行为和成本比全局 `SERIALIZABLE` 更可预测，也符合技术方案中的默认隔离级别。
- SKIP LOCKED 适合短队列任务；Lease + Fencing 可以阻止暂停后恢复的旧 Worker 覆盖新 Worker。
- 有界并发和统一 Deadline 在过载时保护数据库连接池，使系统快速拒绝而不是排队到超时。

## 替代方案

### 用一把 Campaign 分布式锁包住完整 Checkout

不采用。Inventory、Order、Payment 或消息延迟会延长持锁时间，单 Campaign 吞吐趋近 `1 / 完整 Checkout 延迟`，并放大故障影响。

### Redis Redlock 或 Redis Lua 作为最终并发控制

不采用。Redis 只属于 Admission Plane；它的锁或 counter 不能与 PostgreSQL Attempt、Medusa Inventory 和 Payment 原子提交，也不能作为安全边界。

### 全局 `SERIALIZABLE`

不采用。它会增加突发流量下的 transaction abort 和 retry storm，仍不能覆盖外部支付或 Medusa 之外的事务。需要强一致的局部更新使用明确 Row Lock、条件更新或 CAS。

### 只使用 optimistic concurrency，不进行 admission 或行锁

不采用。极端 hot key 会产生大量失败更新和重试，消耗连接池但不增加 goodput。Optimistic CAS 用于状态竞争，而 quota/inventory 的关键更新使用数据库原子更新或行锁。

### 按请求输入顺序锁多 Item

不采用。两个请求以相反顺序购买相同 Item 时会形成死锁。服务端必须规范化和排序，不能信任客户端顺序。

### 同时持有 Quota 和 Inventory 锁以追求跨模块原子性

不采用。两个模块没有一个稳定的共享事务契约，并会扩大锁范围。系统选择分别安全、通过 Saga 收敛，而不是伪装成全局 ACID。

### 无限重试锁超时或死锁

不采用。无限重试会在过载期间形成正反馈，挤占连接池并违反调用方 Deadline。

## 后果

### 正面后果

- Quota hot row 的临界区保持短且可测量。
- 多 Item 请求具有确定的锁顺序，死锁概率和复现难度降低。
- 外部支付慢或未知不会长期持有数据库锁。
- Worker 接管后，僵尸执行者不能提交新状态。
- 在过载时系统可以用 429/503 快速拒绝，保护 commit goodput 和数据库健康。
- Capacity Sharding 是否必要可以由 K=1/4/16/32 对照实验决定。

### 负面后果

- Quota Hold 与 Physical Reservation 之间存在可见的 Saga 中间状态。
- Inventory 失败后需要可靠 compensation；compensation 自身也必须可重试和对账。
- 固定顺序可能不是所有请求的最短路径，但优先保证可预测性和避免死锁。
- 多副本本地 semaphore 不是精确全局限制，需要 Waiting Room/Admission Window 控制总体预算。
- 锁 timeout 和有限重试会让一部分请求收到可重试错误，客户端必须遵守 Retry-After 和 Attempt 查询协议。

## 验证方式

1. Quota 并发：两个至四个独立进程竞争同一 Capacity，Quota 50、500 个 Attempt、至少 10 轮，要求零超发和零负数 bucket。
2. Hot-key 基准：记录 `S_quota`、row/lock wait、DB pool wait、goodput 和 p95/p99；比较 1/2/4 App，证明单 hot key 不因副本数虚假线性扩展。
3. 锁顺序测试：构造两个多 Item 请求，输入顺序完全相反；服务端排序结果必须一致，测试不得死锁或留下部分 Hold/Reservation。
4. 原子库存测试：多 Item 最后一项库存不足时，整个库存事务回滚，不留下部分 Physical Reservation。
5. 状态竞争测试：并发执行 Confirm、Cancel、Expire 和 Payment Success；只有一个 CAS 获胜，失败方重读后不回退状态。
6. Fencing 测试：Worker A Lease 过期，Worker B 接管并递增 epoch，随后恢复的 Worker A 更新必须影响零行。
7. Deadline 测试：注入 PostgreSQL 延迟、连接池耗尽和 Payment timeout，验证总耗时不超过统一 Deadline 预算，且无无限重试。
8. 故障注入：在 `after_quota_held`、`after_inventory_reserved`、`after_order_committed` 和 `after_payment_sent_before_response` 终止进程，恢复后无长期锁、无重复订单，并由 Expiry/Reconciliation 收敛。
9. Admission 对照：在 0.5 倍至 2–3 倍持续容量下比较 No Admission、Fixed 和 Adaptive，观察 goodput、429、5xx、pool timeout、lock wait 与 p99；所有模式必须保持正确性不变量。
10. Shard 决策门槛：仅当 K=1 的 row lock wait 被证明是主要瓶颈时进入固定 Shards；比较 K=1/4/16/32 的 goodput、deadlock retry、quota stranded 和 reconciliation mismatch。
