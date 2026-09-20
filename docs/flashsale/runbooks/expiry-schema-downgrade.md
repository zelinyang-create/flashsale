# Expiry 状态 Schema 回滚 Runbook

适用场景：需要把包含 `quota_committing`、`quota_expired` / `expired` 状态的 FlashSale 数据库回滚到不认识这些状态的旧版本。

该 Schema **不能在存在 Expired 数据时直接执行 down migration**。旧约束不接受新状态，直接回滚会失败。下面的流程会进行有损但可审计的兼容转换：

该工具不会自动转换 `quota_committing`。这个状态可能已经越过物理库存或订单副作用边界，盲目改回 `quota_held` 或直接释放会破坏 Saga 事实。Dry-run 和 execute 发现任何 `quota_committing` Attempt 都会拒绝执行；必须先用原 `settlement_id` 完成 Consume/Release，或按 Checkout Reconciliation 进入人工处理。

- `PurchaseAttempt.quota_expired` 转为 `quota_released`；
- `AllocationHold.expired` 转为 `released`；
- `terminal_at` 和 `resolved_at` 保持不变；
- Attempt 的 `last_error_code` 写为 `SCHEMA_DOWNGRADE_FROM_EXPIRED`；
- 不修改 Capacity/Subject counter，因为 Expire 成功时配额已经从 HELD 归还。

## 前置条件

1. 进入维护窗口，停止所有 API 写请求。
2. 停止 Expiry、Checkout、Consume、Release 与其他 Allocation Worker。
3. 确认没有旧 Worker 或定时任务仍能写 Allocation 表，并确认 `quota_committing` 数量为零。
4. 备份数据库，并记录待回滚版本与目标版本。

## 操作顺序

在 `packages/plugins/flash-sale` 目录执行：

```powershell
$env:DATABASE_URL = '<postgres connection string>'
yarn migration:prepare-expiry-downgrade --dry-run
```

检查 JSON 报告中的 `attempts` 与 `holds` 数量。Dry-run 会先阻止任何未决 `QUOTA_COMMITTING`，再在单个事务中按 Attempt → Hold 顺序加锁并校验：每个 `QUOTA_EXPIRED` Attempt 必须至少有一个 Hold，且所有 Hold 都是 `EXPIRED`。发现不一致时工具会整体失败且不写数据。

确认报告后执行：

```powershell
yarn migration:prepare-expiry-downgrade --execute
```

然后按部署系统的标准流程：

1. 执行 Allocation 模块 down migration；
2. 验证旧 Check Constraint 已生效；
3. 部署旧版本应用；
4. 恢复 API 与 Worker；
5. 查询 `last_error_code = 'SCHEMA_DOWNGRADE_FROM_EXPIRED'` 的 Attempt，保留为审计证据。

## 语义说明

这是一项明确的语义降级：旧版本无法区分“主动释放”和“TTL 过期释放”，因此统一映射为 Released。审计标记和原终态时间仍可区分经过 Schema 回滚的记录。工具只用于离线维护窗口，不是公共 Module Command，也不能在业务写流量运行时使用。
