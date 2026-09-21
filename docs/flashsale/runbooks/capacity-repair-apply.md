# Capacity Repair Apply Runbook（Phase 2A-3d-2）

## 当前能力

当前已实现受控的 Apply Handler/Store、Capacity Version CAS、append-only receipt 与 Repair Outbox 原子提交；
生产 scheduled reconciliation 仍为只读，且尚未开放通用 Service/API。未经可信 Approval Verifier 接入和下述
发布门禁，不得启用 Apply，也不得直接向 Apply 审计表或 Capacity 表写 SQL。

新 dry-run Plan 为 schema v2，并记录同快照 Capacity Version；升级前 Plan 保持 v1，Action Version 为 NULL。
v1 仅支持读取和 exact replay，禁止审批和 Apply。

滚动升级期间数据库保留 `plan_schema_version DEFAULT 1`：旧 3c producer 不提供新列时只能生成 v1/NULL，
新 producer 显式生成 v2/version。确认所有 producer 已升级前不得启用 Apply；未来是否移除默认值必须通过独立
contract migration。迁移重跑会在表级锁内恢复全部命名 CHECK，但不会修改不符合约束的审计行；此类行会让
迁移失败并触发审计调查。

## Outbox 上线门禁

Apply 会提交 `flash_sale.capacity_repair.applied.v1`。生产启用 Apply 之前必须先完成以下步骤：

1. 部署能识别该严格 envelope 的 Dispatcher；
2. 部署 Repair Subscriber，并把其稳定 subscriber ID 加入
   `FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON`；
3. 验证 manifest 同时完整覆盖全部既有 quota 事件与 Repair 事件，再启动 Dispatcher；
4. 完成端到端验收后，最后启用 Apply 入口。

配置解析会在 Repair Subscriber 缺失时拒绝启动 Dispatcher。不得绕过完整性检查；否则未知 Repair 事件会在
旧 worker 中成为 poison event。若 Subscriber 未就绪，保持 Apply 关闭且不产生 Repair Outbox。

## 审批接入要求

- API 只接收 opaque credential/reference；Requester 必须来自认证上下文，不从自由表单信任；
- Verifier 固定允许的算法、Key、Issuer、Audience、Tenant、Purpose、Permission Version，拒绝
  `alg=none`、远程 `jku/x5u` 和未知 Key；
- Claims 必须绑定 Plan schema v2、Campaign、Plan ID、Evidence Digest 和完整有序 Action Set；
- Approver 与 Requester 必须不同，审批尚未生效或已经过期立即拒绝；
- 原始 request identity、credential、reference、JTI 不得写数据库或日志；只记录 domain-separated digest。

## 每次执行前检查

1. Run 是 campaign-scoped、`planned/safe_repair/schema v2`；
2. 选择集合等于该 Run 全部物理 proposed Actions，数量 1–100；
3. Policy 与 Capacity 均为 CLOSED；
4. 按 ADR-0014 的锁序取得锁，在锁内重跑完整 root/facts/projector；
5. 只允许 held/consumed 及 raw mirror，禁止 granted、Subject 或 Ledger 变更；
6. Capacity CAS、Apply receipt 和 Outbox 必须同事务提交；任一步失败全部回滚。

成功后的 exact replay 只核验不可变 Apply receipt/Actions/Outbox，不依赖 Capacity 仍停留在刚修复后的版本；
这是为了允许后续合法业务生命周期继续推进。Outbox 的发布状态、租约、重试次数和发布时间属于可变投递字段，
不参与 receipt replay；事件身份、payload、hash、发生/创建时间和软删除状态仍须精确匹配。

## Schema guard 告警

`__capacity_repair_3d1_schema_guard__` 是迁移保留的软删除 Identity，不是业务审计。普通 live list 必须看不到它。
以下任一情况按 P0 处理：

- guard 缺失、字段或固定时间漂移；
- guard 出现在 live list；
- 3d-1 已安装但 3c named-down 可以成功；
- Apply 表存在物理行却能执行 3d-1 down。

处置：停止迁移、停止任何 Repair 操作，保留数据库快照与迁移日志，由数据库管理员和服务 Owner 共同核对。
生产运行角色不能拥有迁移 DDL 权限；迁移角色也不应持有审批签名 Key。

## 降级

正常降级必须先降 3d-1，再降 3c。3d-1 down 只接受：Apply 三表物理全空、所有 Plan 都是 v1、所有
Action Version 为 NULL、Identity/Run 闭合、guard 全字段精确。v2 Plan 或任一 Apply/soft-delete/tombstone
证据存在时均应失败；不得手工删除审计来强行降级。
