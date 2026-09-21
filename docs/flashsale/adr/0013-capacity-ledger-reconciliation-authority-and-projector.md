# ADR-0013：Capacity Ledger 对账权威层级与纯函数 Projector

- 状态：Accepted（Phase 2A-3a，仅契约与纯函数）
- 日期：2026-09-21
- 关联：ADR-0011、ADR-0012

## 背景

Phase 2A-2 已建立 Capacity Movement Ledger，但“有账本”不等于“账本在任何情况下都可覆盖在线状态”。
Checkpoint、Movement、Control、Attempt binding 和 Hold facts 可能分别完整，也可能以部分删除、身份漂移、
未知 schema 或错误 binding 的方式互相矛盾。若 Reconciler 在证据不闭合时自动补造或删除账本行，会把原始
事故证据改写成看似一致的新历史，反而失去恢复依据。

本 ADR 只定义权威边界、Issue taxonomy、输入输出契约和确定性 Projector。它不读取数据库、不落修复，
也不表示 Phase 2A-3 的数据库 Reconcile/Rebuild/Repair 已完成。

## 决策一：权威层级

1. 在线读写期间，`Capacity.granted/held/consumed` materialized counters 是服务请求的即时权威状态。
2. Checkpoint + Movement 只有在下列证据同时成立时，才可作为 **Capacity counter 重建证据**：
   - Control 是唯一 live singleton，schema 已知，Checkpoint digest/root 验证通过；
   - 全部物理 Capacity、Checkpoint、Movement 行参与检查，覆盖关系闭合，任何 soft-deleted 行均 fail closed；
   - Checkpoint identity、kind、opening conservation 与 raw decimal mirror 合法；
   - Movement 使用 tuple schema v1，identity、fingerprint、route、version、quantity/raw mirror 合法且无重复；
   - 每条 Movement 与 Attempt binding、Attempt state、Hold identity/state/quantity 相符；应有集合与物理集合相等。
3. 上述任一条件失败，Ledger 不能升级为重建权威；结果只能是 `manual_required`。
4. `SubjectAllocation` counter **不能声称由 Capacity Ledger 推导**。Movement 按 Capacity/Attempt 记账，没有
   Subject opening baseline/root；Projector 固定返回 `subject_counter_derivation = not_ledger_derived`。

## 决策二：永不自动修复 Ledger 历史

自动流程永不补造、删除、soft-delete、restore 或改写 Movement、Checkpoint、Control，也不自动修改 Attempt
binding。即使可以根据当前 Hold 猜出一条 Movement，也不能把猜测写回为历史事实。未知 schema、root mismatch、
物理覆盖缺口、identity drift、soft-delete、binding mismatch、Ledger 与 Hold facts 不一致、numeric granted drift
均为 `manual_required`。

仅当完整证据链已验证，且偏差严格局限于 materialized `held/consumed` 或二者的 raw mirror 时，才可标记为
`safe_repair` **候选**。候选不是执行授权：Campaign/Capacity 必须已暂停或处于 non-OPEN 范围，后续数据库
Repair 仍需锁、版本 CAS、审计记录和二次验证。在 OPEN 状态，同样的 counter drift 也归为 `manual_required`。
`granted` numeric drift 或 `raw_granted` mirror drift 永远不是 safe repair。

Attempt history 必须按完整状态矩阵验证，不能只看某一条 Movement 的 kind/version：PENDING v1 与 REJECTED
v2 必须没有 Hold、Movement 和 binding；HELD v2 与 COMMITTING v3 的 Hold 必须全部为 HELD；CONSUMED
v4、EXPIRED v3 的 Hold 和终态 Movement 必须分别一致；RELEASED 必须依据持久化 `settlement_id` 明确区分
direct v3 与 settlement v4，禁止猜测。Hold Movement 固定 v2，terminal Movement version 必须等于 Attempt
version。任一非空 binding 都要求完整 Hold 集合及逐 Item Movement 闭合；legacy Hold binding 为 null、但
post-cutover terminal binding 非空的组合仍合法。所有 Hold（包括 legacy）必须命中已加载 Capacity，且
`capacity_id/campaign_item_id` 同时一致。

## 决策三：Schema 语义分离

- Control/Checkpoint Root schema v1：digest tuple 不含 `checkpoint_kind`，所有 Checkpoint 只能是 `cutover`。
- Control/Checkpoint Root schema v2：digest tuple包含 `checkpoint_kind`，允许 `cutover` 与 `provision`。
- Capacity Movement tuple schema 当前独立固定为 v1。它与 Root v1/v2 不是同一版本轴；Root v2 下的 Movement
  仍必须是 Movement schema v1。不得因数字相同或不同而互相推断。

纯函数 helper 明确编码上述 kind/version 关系；未知 Root schema、未知 Movement schema、未知 kind/route/version
全部 fail closed。

## 决策四：Projector 公式与数值语义

Projector 输入是已经过全局 root/物理集合验证的 Control、Checkpoint、Movement、Capacity、Attempt 与 Hold
快照。所有 quantity 均以 canonical decimal string 进入，并仅使用 `BigInt` 运算；禁止经过 JavaScript
`Number`。每个 Capacity 独立聚合，多 Item/多 Capacity 不共享累加器：

```text
expected.granted  = opening.granted
expected.available = opening.available - SUM(HOLD) + SUM(RELEASE) + SUM(EXPIRE)
expected.held      = opening.held + SUM(HOLD) - SUM(CONSUME) - SUM(RELEASE) - SUM(EXPIRE)
expected.consumed  = opening.consumed + SUM(CONSUME)
```

输出必须再次满足四桶非负且 `available + held + consumed = granted`。非法/负数/非 canonical decimal、
unsupported route/version/kind、duplicate Movement identity、Checkpoint 不守恒、Movement/Capacity identity
不一致均不得产生部分 projection，统一返回 manual-required issue。

## Issue 与结果契约

结果状态：

- `not_activated`：没有 Control，且没有任何 Ledger 物理行；
- `healthy`：证据链闭合，materialized Capacity 与 projection 一致；
- `drift`：仅存在满足暂停/non-OPEN 前提的 safe-repair candidate；
- `manual_required`：存在任何不可自动判断或不可安全覆盖的问题。

Issue classification 只有 `safe_repair` 与 `manual_required`。多个 Issue 混合时，`manual_required` 优先。
类型独立于 Phase 1 `AllocationReconciliationIssue`，避免把在线业务审计与 Ledger 历史可信度混为一谈。

## 后续 Repair 锁协议（预告，不在 2A-3a 实现）

后续数据库 Reconcile/Repair 至少需要：

1. 获取 Movement Ledger shared advisory lock，阻止与首次 Activation/Root 变更交叉；
2. 获取 Campaign lock，并锁定目标 Capacity、相关 Attempt/Hold；
3. 在同一事务重新读取全部物理证据并重跑 root/binding/facts/projector；
4. 仅对仍为 safe-repair candidate 的 materialized held/consumed/raw mirror 做 version CAS；
5. 写独立审计证据，提交后再次对账。任何条件漂移均回滚并转人工。

锁顺序必须与在线 Writer/Provision 协议一致，具体 SQL、批处理和恢复 Runbook 留待 Phase 2A-3b/3c。

## 后果

- 优点：不会用不可信 Ledger 覆盖仍在服务流量的在线状态；超大 numeric 无精度损失；Projector 可被大量
  单元测试和未来离线工具复用。
- 代价：很多“看似可修”的缺口会被保守地升级为人工处理；Subject counter 需要独立事实来源与恢复设计。
- 明确未完成：数据库 Reader、全局 root 重算、Reconcile Handler、Repair Writer、审计表、Runbook 和生产门禁。
