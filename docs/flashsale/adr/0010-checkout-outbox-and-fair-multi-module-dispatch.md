# ADR-0010：Checkout Outbox 与公平多模块调度

- 状态：Accepted
- 日期：2026-09-20
- 范围：Phase 1F-B2

## 背景

Allocation 已能原子产生并投递配额事实，但 Checkout 的业务结果只有当前状态，无法可靠发布；直接复用技术 CAS
`version` 又会把 Lease、Authorize 等非业务变化误当成业务事件。同时两个模块若各自注册 Job，会分别占满并发预算，
无法在一个实例内给低流量 Lane 最低服务份额。

## 决策

1. CheckoutExecution 使用独立 `business_version`/`outbox_stream_started`。新建从 `prepared@v1` 开始；Legacy Row 在第一次
   真实业务转换时从 v1 启动。技术 Lease/Authorize/Takeover 不发事件。
2. Checkout 独占 Outbox Event/Control 表与激活水位。业务状态 CAS、业务版本递增和 Append 共用 Checkout 自己的事务；
   不存在中央表、跨模块 FK、Union SQL 或共享 Transaction Manager。
3. Catalog 固定为 prepared、commerce_pending、commerce_succeeded、commerce_definitive_failed、commerce_unknown、
   completed、canceled 的 v1 事实。PENDING Takeover 不重复产生 commerce_pending。
4. 激活后每个读/重放/授权入口验证当前业务版本事件；Checkout Reconciliation 检查连续版本、Hash/Catalog 与状态转换。
5. 生产只保留一个 `flash-sale-dispatch-outboxes` Job。每个 Lane 只调用自身公开 Exact API；全局 Provider/Manifest 预检
   先于所有 Claim，任一启用 Lane 配置错误则所有 Lane 零 Claim。
6. 全局预算使用确定性轮转：C=1 逐 Tick 交替；C 足够时每 Lane 至少一个，余量轮转。Lane 故障相互隔离，但不承诺
   跨模块顺序。
7. 测试 Probe 把 `source_module` 放入 Inbox/Effect/Cursor Identity；它是 fixture，不随生产 Plugin 注册。

## 保证

- Checkout 业务事实与 Outbox Row 原子提交；响应丢失重放获得同一 ID/Hash。
- Allocation/Checkout 共用一个进程并发预算，且在持续积压时不会固定饿死某一 Lane。
- Redis 接受后 Mark 失败可由同模块 Lease Takeover 重投；旧 Epoch 无法提交。
- 测试 Probe 对同一 Source/Event 的重复投递只提交一次 Effect。

## 不保证

不保证 Production Consumer Inbox、Exactly-once Delivery、跨模块事件顺序、Redis 基础设施持久性/HA、Campaign Outbox、
Webhook Inbox、Payment UNKNOWN 恢复或跨 Region 一致性。Reconciliation 不重建迁移前历史；结构化 Tick 日志也不等价于
完整 Metrics/Alerting。

## 发布顺序

先发布 Schema，再停止/排空旧 Writer，部署新代码，最后分别执行 Allocation 与 Checkout 的 DB-clock Activation。
Checkout Lane 默认关闭；只有 Union Manifest 和所有 Exact Subscriber Registration 就绪后才启用。
