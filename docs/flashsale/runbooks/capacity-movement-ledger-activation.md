# Capacity Movement Ledger 激活 Runbook（Phase 2A-1）

## 当前状态

**禁止生产激活。** Phase 2A-1 只提供可测试的 baseline 内核；只有 Phase 2A-2 在线 writer 已部署，
并确认与激活共享 advisory lock 和 Capacity 锁顺序后，才允许执行
`activateAllocationMovementLedger({})`。

## 激活前检查

1. 数据库迁移已完成，三张 Movement 表存在；
2. Allocation Reconciliation 为 healthy；
3. Phase 2A-2 writer 已在所有实例启用，并能在同一事务更新 Balance、Attempt/Hold、Movement 与 Outbox；
4. 没有旧版本实例继续绕过 writer；
5. Movement/Checkpoint/Control 三表物理全空；软删除行、预先写入的 Movement 或 orphan
   Checkpoint 也会使首次激活 fail closed；
6. 已安排只允许一次切换的维护窗口。

## 成功判据

- 返回固定 `activation_id`、`required_after`、`schema_version=1`；
- `checkpoint_count` 等于切换时 live Capacity 数；
- Control 只有固定 ID `allocation-movement-ledger` 一行；
- Checkpoint 每个 Capacity 恰好一行；
- Control 中 `checkpoint_digest` 等于按稳定顺序对全部 Checkpoint 完整不可变元组重算的
  小写 SHA-256；
- 激活不会新增 `CapacityMovement`；
- 再次执行只有在 Control 和完整 Checkpoint 通过精确重放校验后，才返回相同水位且
  `replayed=true`。

## Fail-closed 情况

下列情况不得删除 Control/Checkpoint 后强行重跑：

- Counter 与 Hold 聚合不一致；
- Capacity/Hold 的 BigNumber raw 值与 numeric 值不一致，或 Hold 的 Capacity/Item identity 不一致；
- 首次激活前三表存在任何物理行，包括软删除行或预先写入的 Movement；
- 物理上不是恰好一条未删除的固定 ID Control；
- Checkpoint 存在但 Control 缺失，或 Checkpoint 包含 orphan/软删除/其他 Activation 的行；
- 重放时 Checkpoint 数量、Capacity/Item/Shard identity、opening 数量、raw 值、Capacity Version 或
  `activated_at = required_after` 不成立；
- 重算 `checkpoint_digest` 不一致；
- schema version 不受支持。

先冻结相关 Item，保留数据库证据并修复根因。Phase 2A-1 不提供自动 Repair。

## 版本与指纹语义

- `transition_version` 是转移后的 `PurchaseAttempt.version`：Hold 通常为 v2；直接 Release/Cancel/Expire
  通常为 v3；经 Begin Settlement 后的 Consume/Release 通常为 v4。
- Begin Settlement 不改变配额桶却会增加 Attempt Version，所以 Movement 版本有 gap 是正常的；
  不得为了“连续”而重写版本。
- `fence_token` 必须等于对不可变 Movement identity tuple 计算的 SHA-256，它只用于精确
  重放校验，不是 Worker Fencing epoch/lease token。

## 旧数据升级

允许对已有 Phase 1 Capacity/Attempt/Hold 数据执行向上迁移。迁移只新建三张空表，必须
验证旧表的行和字段逐列不变。不能在 migration 中伪造历史 Movement；必须另行执行本文档
开头所述的受控激活。

## Schema 降级（只允许空且未激活的环境）

1. 停止所有 API 和 Worker，建立离线维护窗口；
2. 运行 `migration:preflight-movement-downgrade`。该命令在单事务中取激活 advisory lock，并对
   Movement/Checkpoint/Control 三表取 `ACCESS EXCLUSIVE` 锁，按物理行数检查；
3. 仅当三表行数都是 0 时，立即执行 migration down；
4. 任一表有行（包括软删除行）、存在 Control/激活证据或已有 Movement 时，终止降级，
   不得删行后强行迁移。

独立 preflight 事务返回时锁会释放，因此仍要求先停止全部 writer。除此之外，两个 Movement
migration 的 `down` 是经过审计的生成器例外：它们会在各自迁移事务内按固定顺序取得三表
`ACCESS EXCLUSIVE`，再次检查所有物理行，并在非空时拒绝删除摘要列或表。这一内嵌 guard 关闭了
direct down 的检查/删除 TOCTOU；preflight 只承担提前诊断。除这两处 guard 外，不手改生成迁移。
