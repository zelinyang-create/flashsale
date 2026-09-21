# ADR-0011：Capacity Movement Ledger 基线与切换协议

- 状态：已接受（Phase 2A-2a 已接入事务 writer；生产激活仍等待 2A-2b）
- 日期：2026-09-21

## 背景

Phase 1 已经以 `Capacity` 的 `granted/held/consumed` 计数器作为在线事实来源。Phase 2
需要加入 append-only Movement Ledger，用于解释每一次配额桶转移、检测物化余额漂移，并为后续
重建和 Repair Audit 提供证据。已有环境可能包含活动中的 Hold 和已消费配额，因此不能从零开始
伪造历史 Movement，也不能在没有切换水位的情况下同时解释旧计数器与新账本。

## 决策

### 1. 这是配额转移账本，不是 Event Sourcing

在线决策仍读取和条件更新 `Capacity` Materialized Balance。`CapacityMovement` 仅记录四种受限转移：

- `hold`：`AVAILABLE -> HELD`；
- `consume`：`HELD -> CONSUMED`；
- `release`：`HELD -> AVAILABLE`；
- `expire`：`HELD -> AVAILABLE`。

它不承载任意领域事件，不重放整个 Campaign/Checkout 状态机，也不替代 Outbox。
`campaign_id` 和 `subject_id` 只用于审计过滤，不能把该表扩展成通用会计分录。

### 2. 基线与 commit marker

`activateAllocationMovementLedger({})` 在单个 PostgreSQL 事务中：

1. 获取固定 namespace 的 transaction advisory lock；
2. 按 `Capacity.id` 顺序锁住全部 live Capacity；
3. 要求 Movement/Checkpoint/Control 三表物理全空，软删除行也视为已有历史而拒绝激活；
4. 校验 raw BigNumber、余额方程、live Policy，以及 Hold 的 Capacity/Item identity、
   `raw_quantity` 与 HELD/CONSUMED 聚合和计数器一致；
5. 为每个 Capacity 写一条 `CapacityMovementCheckpoint`，保存 opening
   granted/available/held/consumed、Capacity Version、Item 和 Shard；
6. **不生成任何历史 Movement**；
7. 对按 `(capacity_id, id)` 稳定顺序排列的完整 checkpoint 不可变元组计算小写
   SHA-256 `checkpoint_digest`。元组覆盖 ID/Activation/Capacity/Item/Checkpoint Kind/Shard、
   四个 opening 数量、Capacity Version、Activation Time 和四个 raw JSON；
8. 最后写单例 `CapacityMovementControl`。Control 是 checkpoint 集合完整提交的 commit marker，
   `required_after` 是新 writer 必须产出 Movement 的切换水位，Control 保存该 digest。

幂等重放不是“Control 存在就成功”。它要求物理上恰好一条固定 ID 且未删除的
Control；所有 Checkpoint 都未删除、属于该 `activation_id`，并与物理 Capacity 一一覆盖；`cutover`
的 `activated_at = required_after`，`provision` 的 `activated_at >= required_after`；重算
`checkpoint_digest` 必须等于 Control 中的值。任何额外或软删除的
Control/Checkpoint、orphan 集合、identity/数量/内容漂移、不兼容 schema，均 fail closed。
通过后才返回原始 `activation_id` 和 `required_after`，不生成新水位。

### 3. transition_version 与 fingerprint

Movement 唯一键为 `(attempt_id, campaign_item_id, transition_version)`。其中
`transition_version` **等于该次配额转移完成后的 `PurchaseAttempt.version`**，不是独立自增序号，
也不使用表更新时间或投递次数。Hold 通常为 v2；从 `QUOTA_HELD` 直接 Release/Cancel/Expire
通常为 v3；经 `QUOTA_COMMITTING` 后的 Consume/Release 通常为 v4。Begin Settlement 等不改变
配额桶的 Attempt 转移也会增加 Version，因此 Movement 版本允许出现缺口。同一业务转移
的重试必须命中同一唯一键。

Fingerprint 对 schema、Capacity/Attempt/Campaign/Subject/Item、Transition Version、Kind、
from/to 和 lossless decimal quantity 做规范化 SHA-256。`fence_token` 必须**等于**该不可变
Movement identity tuple 的小写 64 位 SHA-256，Phase 2A-2 writer 用它做精确重放校验。
它不是 Worker Fencing epoch/lease token，不提供旧 Worker 隔离或互斥保证；“fence”名称不得
被引用为 Worker Fencing 已实现的证据。原始令牌和不稳定 JSON 不落库。

### 4. Phase 2A-1 基线与 Phase 2A-2a Writer 边界

Phase 2A-1 交付 schema、fingerprint 与基线激活内核。Phase 2A-2a 已让全部 Allocation 命令把同一
namespace 的 shared transaction advisory lock 作为事务第一把应用锁；激活使用 exclusive 形式。
Hold、Consume、Release、Expire 在最终 Attempt 更新后、Outbox 之前写 Movement，因此
Capacity/Subject/Hold/Attempt/Movement/Outbox 共同提交或共同回滚。

Fresh transition 的唯一键冲突一律视为不变量破坏，不能因为冲突行内容相同就继续提交第二次余额变更；
只有状态机已经处于结果态的显式 replay 分支才能验证 Movement。验证会一次读取同一 Attempt 的全部
物理 Movement（包括软删除行），再按 state/version/binding/Hold 推导允许的 Version、Kind 和 Item 精确
并集；extra version/kind/item、partial 或 soft-deleted 都
fail closed。激活前已存在并进入 opening baseline 的 Legacy Hold 不补造 Hold Movement；它在激活后结算
时只写真实发生的终态 Movement。

Attempt 以 `hold_movement_activation_id` 和 `terminal_movement_activation_id` 保存离散 binding：null 表示
对应转移明确禁止 Movement，非 null 则必须等于 Control Activation 且要求完整 Movement。Replay 不使用
Hold/Attempt timestamp 与切换水位做推断，避免时钟精度或回填改变语义。

Phase 2A-2a 仍不交付 Reconcile、Rebuild 或 Repair，也未完成跨进程 kill/crash 矩阵。因此生产环境继续
禁止激活；该限制在 2A-2b 证据完成后另行解除。

### 5. 激活后 Provision 与滚动摘要

`CapacityMovementCheckpoint.checkpoint_kind` 显式区分：

- `cutover`：激活事务捕获的既有 Capacity，`activated_at = required_after`；
- `provision`：激活后新建 Capacity，opening 必须为全额 AVAILABLE、HELD/CONSUMED 为 0、Version 为 1，
  且 `activated_at >= required_after`。

低频 Provision 已先取得 shared advisory lock；若 Control 已存在，再 `FOR UPDATE` 锁 Control，并在创建
任何新行前验证旧的完整物理 Checkpoint Root。新 Capacity
与 `provision` Checkpoint 在同一事务创建，然后读取全部物理 Checkpoint，按包含 `checkpoint_kind` 的完整
tuple 重算 digest，并以旧 digest 做 CAS 更新。Provision replay 锁定 Control、验证全局 digest 和目标
Checkpoint 集合。热路径不锁 Control 行、不重算全局 digest，只读取 Control 并验证目标 Capacity 的合法
Checkpoint，避免把全局 Root 变成热锁。

Root schema v1 是升级兼容格式：digest 不包含后来新增的 `checkpoint_kind`，并且只允许全部为 cutover。
当前新激活写 schema v2，digest 包含 kind。升级后代码可以精确重放 v1；首次 Active Provision 必须先验证
v1 Root，再以同一 Control CAS 同时升级 schema_version=2 与 v2 digest，不能用 SQL 重算替换旧审计承诺。

### 6. 旧数据升级与降级边界

从 Phase 1 Schema 向上迁移允许已有 Capacity/Attempt/Hold 数据；官方生成迁移添加三张空表、Control
`checkpoint_digest`、Checkpoint Kind 和 Attempt 的两个 nullable binding，不改写既有业务值。迁移本身
不代表账本已激活；基线只能由受控的激活命令
建立。

Schema Down 只能在 Movement/Checkpoint/Control 三表的**物理行数都为 0**时执行，所以
已激活、已写 Movement，或仅剩软删除历史的环境都不允许降级。必须先停止 API/Worker 写流量，
再运行 `migration:preflight-movement-downgrade`，通过后立即执行 migration down。为避免审计数据
被直接回滚删除，本 ADR 明确接受一个受审计的生成器例外：四个相关 migration（Movement 表、Digest、
Checkpoint Kind、Attempt Binding）的 `down`
在同一迁移事务中按固定顺序取得账本三表 `ACCESS EXCLUSIVE`；Attempt Binding 迁移还会锁
PurchaseAttempt 并拒绝任一非 null binding。重新检查包括软删除在内的所有物理行后，只有三表都为空且
binding 全空才允许删除 binding、checkpoint kind、摘要列或表。因此 direct down 也会 fail closed；独立 preflight 仍用于
停机窗口内的提前诊断，不是 down 的授权令牌。除这些 down guard 外，Migration 与 Snapshot 仍
由官方 generator 生成并通过 no-drift 检查。

## 后果

- 已有 Phase 1 数据可以零伪造历史地进入新账本；
- 激活失败不会留下带 Control 的半成品基线；
- BigNumber 的 raw representation 与 numeric 同时校验，避免 JavaScript Number 舍入；
- 增加一次受控维护切换，并要求 2A-2 writer 与该锁协议共同上线。
