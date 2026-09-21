# FlashSale 多模块 Outbox Redis Dispatcher 运行手册

## 默认行为

Dispatcher 默认关闭。关闭时 Job 不会 Claim 事件。生产启用前必须同时满足：

- `projectConfig.workerMode` 为 `worker` 或 `shared`；
- EventBus Module 的 `resolve` 明确为 `@medusajs/event-bus-redis`；
- Allocation 启用时六种事件都出现在 Subscriber Manifest 中；Checkout Lane 启用时再精确加入七种 Checkout Event；
- 每个 Canonical Event 的 Exact Subscriber ID 集合与 Manifest 完全一致；Wildcard 不算；
- `mark timeout + safety margin < lease`。

Local EventBus、Server-only Mode、未知 Provider、空 Manifest 或不安全 Lease Budget 都会在数据库 Claim 前失败，
不会把事件移到 `PUBLISHING`。

## 配置

```text
FLASH_SALE_OUTBOX_DISPATCH_ENABLED=true
FLASH_SALE_CHECKOUT_OUTBOX_DISPATCH_ENABLED=true
FLASH_SALE_OUTBOX_CONCURRENCY=8
FLASH_SALE_OUTBOX_LEASE_SECONDS=30
FLASH_SALE_OUTBOX_MAX_ATTEMPTS=10
FLASH_SALE_OUTBOX_RETRY_AFTER_SECONDS=5
FLASH_SALE_OUTBOX_MARK_TIMEOUT_MS=2000
FLASH_SALE_OUTBOX_SAFETY_MARGIN_MS=2000
FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON=[...启用Checkout时为完整十三事件与Subscriber ID列表...]
```

Manifest 是严格 JSON Array；每项只允许 `event_name` 和非空、无重复的 `subscriber_ids`。`event_name` 必须精确覆盖：

```text
flash_sale.quota.held.v1
flash_sale.quota.rejected.v1
flash_sale.quota.settlement_started.v1
flash_sale.quota.consumed.v1
flash_sale.quota.released.v1
flash_sale.quota.expired.v1
flash_sale.checkout.prepared.v1
flash_sale.checkout.commerce_pending.v1
flash_sale.checkout.commerce_succeeded.v1
flash_sale.checkout.commerce_definitive_failed.v1
flash_sale.checkout.commerce_unknown.v1
flash_sale.checkout.completed.v1
flash_sale.checkout.canceled.v1
```

只启用 Allocation 时保留原六事件 Manifest，兼容 B1。启用 Checkout 后必须使用十三事件 Union Manifest；任一 Lane 的
Event/Subscriber 缺失、Wildcard-only、重映射或错误 ID 都会让整个 Tick 在双 Lane Claim 前失败。单一 Job 按全局
`FLASH_SALE_OUTBOX_CONCURRENCY` 轮转预算，不要再部署第二个 Checkout Dispatcher Job。

## Schema 与激活顺序

1. 先发布 Allocation/Checkout Outbox Schema；
2. 停止并排空旧 Checkout Writer；
3. 部署带 `business_version/outbox_stream_started` 的新代码；
4. 执行模块各自的 DB-clock Activation；
5. 注册全部 Exact Subscriber 并更新 Union Manifest，最后启用 Checkout Lane。

Legacy Checkout Row 在首次真实业务转换时启动 v1；Lease/Authorize/Takeover 不递增业务版本。不要在旧 Writer 仍运行时
提前激活，否则激活后缺事件会被正确地 Fail Closed。

Worker ID 由进程启动时生成；不要把 Pod/Request/Event ID 放入指标 Label。日志不得记录 Payload、Redis URL、PII、
原始异常、Event ID 或 Aggregate ID。

## Acceptance 与故障处理

Redis EventBus `emit` resolve 只代表 BullMQ Queue 接受。之后 Mark 失败时保持 `PUBLISHING`，不得调用 Failure；Lease
到期后由任意实例接管并以同一 Event ID/Hash 重投。Acceptance 之前的明确失败才回到 Pending/Dead Letter。

不要给 Redis EventBus 共享连接设置全局 `commandTimeout`，它会同时影响 BullMQ 的 Blocking Worker Command。
Dispatcher 也不对 reconnecting `emit` 施加假装能取消底层命令的外层 Deadline：断线时该 Tick 可以 Pending，进程内
Overlap Guard 将其限制为一个；数据库 Lease 仍允许其他实例到期接管。连接恢复后原调用可能晚到 Acceptance 并被
Epoch Fence，因此消费者必须使用稳定 Event ID/Hash 与 Transactional Inbox；不要把本 Dispatcher 描述为 Exactly-once。

当前观测性只有不含动态 ID/异常/URL/Payload 的每 Tick 结构化计数日志。Backlog、Lag、Publish Latency、Retry/Dead/
Fenced Metrics 尚未实现。

## 测试

测试必须显式提供专用 Redis URL，例如：

```powershell
$env:FLASH_SALE_TEST_REDIS_URL = "redis://127.0.0.1:56380"
$env:DB_HOST = "localhost"
$env:DB_USERNAME = "postgres"
$env:DB_PASSWORD = "postgres"
corepack yarn workspace @medusajs/flash-sale-plugin test:outbox:probe
corepack yarn workspace @medusajs/flash-sale-plugin test:outbox:full-app
```

Full-app Fixture 使用唯一 Queue 和 OS 动态端口 TCP Fault Proxy；Proxy 生命周期晚于 Medusa/EventBus shutdown，且不
执行 `FLUSHDB`/`FLUSHALL`。其中的
`allocationEventProbe`、Inbox、Effect、Cursor 和 Subscriber 均为测试专用，不会注册到生产 Plugin。它证明具体 fixture
的 Effect 去重，不代表生产 Consumer 已实现 Inbox，也不承诺跨 Allocation/Checkout 的到达顺序。
