# ADR-0014：Capacity Repair Apply 契约与审计 Schema 冻结

- 状态：Accepted（仅 Phase 2A-3d-1）
- 日期：2026-09-21
- 关联：ADR-0011、ADR-0012、ADR-0013

## 背景

Phase 2A-3c 已能在一致快照中生成不可变 Repair Plan，但 Plan 只证明“当时存在一个候选修复”，并不授权改数。
Apply 必须同时解决历史 Plan 兼容、审批可信边界、重复消费、审计硬删除检测，以及与在线 Writer/Provision
一致的锁顺序。若在 3d-1 直接开放执行入口，后续很难在不破坏 3c exact replay 的前提下补齐这些约束。

## 决策

### 1. Plan schema 分代，不原地升级历史证据

`CapacityRepairRun.plan_schema_version` 明确区分两代 Plan：

- 升级前已有 Run 回填为 v1，已有 Action 的 `before_capacity_version` 保持 `NULL`；
- 新 dry-run 生成 v2，Action 从同一个 `REPEATABLE READ` 物理扫描取得 decimal string 形式的 Capacity Version；
- v1 replay 使用冻结 codec，剔除 `Capacity.version`、Action version 以及所有 v2 新 tag，再按历史 canonical
  规则核对；v1 可以读取和 exact replay，但永远不可 Apply；
- v2 Plan 才具有未来 Apply 所需的 version evidence。

该升级采用 expand/contract：expand 阶段数据库为 `plan_schema_version` 保留 `DEFAULT 1`，使尚未滚动完成的
旧 3c producer 继续写出 v1/NULL Action，而新 producer 必须显式写入 v2 与 Capacity Version。只有确认全部
producer 已升级，才允许部署 3d-2 Apply；默认值是否移除由后续 contract migration 单独决定。

### 2. 审批是可信适配器输出，不是客户端声明

Apply 命令只携带 opaque approval credential/reference。`RepairApprovalVerifier` 必须完成固定算法和 Key Allowlist、
签名、撤销、Issuer/Audience/Tenant/Purpose/Permission 校验；必须拒绝 `alg=none` 及远程 `jku/x5u` Key 发现。
Verifier 输出的可信 Claims 包含 Approver、Issuer、Audience、Tenant、JTI、IAT/NBF/EXP、Roles、Purpose、
Permission Version，以及绑定的 Plan v2、Campaign、Plan ID、Evidence Digest 和有序 Action Set Digest。

应用边界只做 defense-in-depth：时间窗、四眼原则和绑定相等性。Prepared Command 与持久化层只保留相互独立的
request identity、approval token、reference、JTI 与完整 claims digest，不携带原始 credential、reference、
request identity 或 JTI。调用方不能提交 before/expected counter、classification 或 version 作为权威事实。

### 3. Apply 审计独立、append-only

3c Plan Run/Action 保持不可变，不能把 `planned/proposed` 原地改写为执行状态。新增：

- `CapacityRepairApplyIdentity`：无 FK 的 identity tombstone，绑定 server-hashed request identity、ApplyRun ID、
  Command Digest；即使 ApplyRun 被硬删仍可检测；
- `CapacityRepairApplyRun`：`plan_run_id` 非 partial 唯一，防止换 identity 重复消费同一 Plan；固化 Plan/Campaign、
  Action Set、完整 Approval Claims、Requester、Reason、Ticket 与结果摘要；主事务只允许最终 `applied` receipt；
- `CapacityRepairApplyAction`：固化 Plan Action、Capacity、before/after version、numeric/raw counter 和 evidence digest。

所有 generated create/update/upsert/delete/soft-delete/restore 均禁用。FK 的 Delete Rule 为 `NO ACTION`。
当前 Medusa DML 对 relation 生成 `ON UPDATE CASCADE`；独立 Identity、稳定 ID 与未来 exact replay 负责把任何
级联改名识别为篡改，不能把级联当作合法业务操作。

### 4. 未来 3d-2 锁序

执行 Store 必须限定单 Campaign、Policy/Capacity 均为 CLOSED、Action 数量不超过 100，并依次：

1. request identity session advisory mutex；
2. 在同一固定连接建立 `REPEATABLE READ` 事务；
3. Movement Ledger shared advisory lock；
4. Campaign advisory lock；
5. Policy、Movement Control；
6. Attempt 按 ID、Subject 按 ID、Capacity 按 Item/ID、Hold 按 ID 加锁；
7. 锁内全量重算 root、facts、projection 与 Plan evidence；
8. 逐 Capacity version/before-values CAS，并在同一事务写 Apply receipt 与 Outbox。

任一证据变化、CAS 零行、超时或序列化失败都必须整体回滚。该顺序同时兼容 Provision 的
Movement→Campaign→Policy→Control→Capacity 和在线 Writer 的 Movement→Attempt→Subject→Capacity→Hold。

### 5. Schema compatibility guard

后继迁移在旧 Plan Identity 表写入一条固定、软删除、不可伪装成业务 ID 的 schema guard。安装时先取得三张
Plan 表的 `ACCESS EXCLUSIVE` 锁：零条候选才插入，一条必须全字段精确匹配，冲突或漂移立即失败；禁止
`ON CONFLICT DO NOTHING`。它使已发布的 3c named-down 在后继 Schema 存在时继续 fail closed。
迁移重复执行时还会按 Identity→Run→Action 对既有 Apply 表取得 `ACCESS EXCLUSIVE` 锁，逐个重建全部命名
CHECK；因此缺失或漂移约束会收敛，违反最终约束的既有审计行则使升级失败，迁移不会修改这些审计行。

3d-1 down 固定按 Plan Identity→Run→Action→Apply Identity→Run→Action 锁表；仅当三张 Apply 表物理全空、
全部 Plan 为 v1、Action version 全为 NULL、Identity/Run 闭合且 guard 精确时才删除 guard 和新增 Schema。
guard 缺失或漂移属于 P0，必须停止迁移和 Apply 调查数据库审计完整性。

## 本阶段边界

3d-1 只交付兼容 Schema、纯命令/审批绑定和审计模型，不暴露 Apply Service 方法，不更新 Capacity，不写
Outbox，也不实现锁、CAS、exact replay 或故障恢复。上述运行能力属于 3d-2；真实并发、kill/crash 和运维
演练属于 3d-3。v1 Plan、global Plan、OPEN Policy/Capacity、partial Action Set、manual-required 和 Subject/
Granted/Ledger 修复均不可 Apply。

## 后果

- 历史 3c evidence 保持可复核，不会因新增 Version 字段被静默重签名；
- 审批原文不会进入 Prepared、数据库或日志，未来 Store 只接受可信 Claims 的 canonical 承诺；
- 一份 Plan 只能产生一个成功 receipt，失败不在主事务中伪造持久状态；
- 代价是 3d-2 在真正执行前仍需实现锁内重算、CAS、Outbox 和 exact replay，当前 Schema 不能被宣传为自动修复。
