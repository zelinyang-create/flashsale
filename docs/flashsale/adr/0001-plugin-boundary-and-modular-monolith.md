# ADR-0001：FlashSale Plugin 边界与模块化单体

- 状态：已接受
- 日期：2026-09-19
- 适用范围：FlashSale Phase 1A 及后续阶段
- 关联设计：`docs/flashsale/technical-design.md` 第 3、4、5、6、7 节

## 上下文

FlashSale 需要在 Medusa 现有的商品、购物车、库存、订单、支付、锁和 Workflow 能力之上增加活动生命周期、准入、活动配额、购买尝试、幂等、补偿与恢复能力。该能力既不能复制 Medusa 的商业核心，也不能因为高并发场景而预先拆成多个独立业务服务。

如果直接修改 Medusa Core，FlashSale 领域概念会渗入通用模块，增加跟随上游升级、回合并和验证默认行为的成本。如果一开始拆成多个微服务，则需要额外处理部署、服务发现、跨服务协议、数据一致性和运维，而这些复杂度不能改善 Phase 1 的核心正确性。

当前仓库已经提供成熟的 Plugin、Module、Workflow、Locking、Inventory、Event Bus 和测试基础，因此应优先沿用这些扩展点。

## 决策

1. FlashSale 以一个 Medusa Plugin 交付，推荐根目录为 `packages/plugins/flash-sale/`。
2. 系统采用模块化单体，而不是业务微服务。一个代码库和一套发布物内包含以下逻辑边界：
   - Campaign Module：Campaign 生命周期、规则版本、Campaign Epoch、活动时间窗、单用户限购、Admission 参数和 Kill Switch；
   - Allocation Module：Purchase Attempt、Quota Hold、Capacity Pool/Shard、持久化幂等、Movement Ledger、Outbox 和 Reconciliation Audit；
   - Admission Port：Disabled、Fixed、Adaptive Policy 以及 Redis/In-memory Adapter；
   - Commerce Adapter：对 Medusa Workflow 和 Module Interface 的稳定适配；
   - Workflows、API、Jobs、Subscribers 和 Infrastructure：负责跨模块编排及基础设施接入。
3. Campaign Module 只保存 Variant、Location、Cart 等 Medusa 资源的 opaque ID，不导入 Medusa Product、Inventory 或 Order 的内部 Model/Repository。
4. FlashSale 不直接读写 Medusa 表，不复制 `complete-cart.ts`，不在 Medusa 上游模型中增加 FlashSale 专属字段。所有商业能力通过稳定的 Workflow 或 Module Interface 使用。
5. Route 只负责身份验证、Schema Validation、错误映射和 Workflow 调用；领域状态转换在 Module Service；跨模块同步编排在 Workflow；异步副作用通过 Outbox/Event 完成。
6. 仅在跨模块或可替换基础设施边界定义接口，包括 `AdmissionPolicy`、`QuotaRepository`、`InventoryReservationPort`、`PaymentCommandPort`、`EventPublisher`、`Clock`、`InvariantChecker` 和 `FaultInjector`。普通内部 Service 不为形式上的“解耦”增加接口。
7. API 与 Worker 使用同一个镜像，通过 `ROLE=api|worker|all` 选择运行角色。角色隔离用于连接池、CPU 和并发预算隔离，不表示拆分为独立业务微服务。
8. MVP 不修改 Medusa Core。若后续需要 `tryCreateReservationItemsAtomic` 等通用能力，必须满足：
   - 对非 FlashSale 调用者有通用价值；
   - 默认行为保持不变；
   - 有独立 Contract Test、多进程测试和 Backorder 兼容测试；
   - 由单独 ADR 记录，并优先形成独立上游 PR。

## 理由

- Plugin 边界让 FlashSale 代码与 Medusa 上游保持清晰差异，降低升级和 review 成本。
- 模块化单体保留本地事务、依赖注入和 Workflow 组合能力，适合单团队在约七至八周内完成。
- Campaign 与 Allocation 分离，可避免控制平面规则和高并发提交状态相互污染。
- Commerce Adapter 隔离 Medusa 内部实现，使 FlashSale 能复用现有库存、订单和支付能力，又不依赖内部表结构。
- 同镜像多角色部署可以提供运行时资源隔离，同时避免服务协议和多仓库管理成本。
- 只为真实边界定义接口，可测试且不过度抽象。

## 替代方案

### 直接修改 Medusa Core

不采用。它会把 Campaign、Admission 和 Allocation 概念加入通用商业模型，造成持续的上游合并负担。只有具有通用价值的原子库存原语可以在单独决策后进入 Core。

### 独立 FlashSale 微服务

Phase 1 不采用。它需要复制或远程访问购物车、库存、订单和支付事实，并引入更多跨服务失败窗口。当前吞吐瓶颈主要在 PostgreSQL hot row 和物理库存临界区，拆服务不会消除这些瓶颈。

### 多个 FlashSale 微服务

不采用。Control、Admission、Commit 是逻辑平面，不是强制的部署单元。将它们拆成多个服务会提前引入服务发现、协议版本、分布式 tracing 和独立发布成本。

### 单个扁平 Module

不采用。它虽然开发速度快，但会把低 QPS 的 Campaign 管理、高 QPS 的 Admission 和高正确性要求的 Commit 状态混在一起，使测试、依赖和资源预算难以隔离。

## 后果

### 正面后果

- FlashSale 增量集中，可单独构建、测试、发布和展示。
- Medusa 上游升级时，大多数冲突被限制在 Commerce Adapter。
- API 与 Worker 可以独立扩缩和分配数据库连接池，而不复制业务代码。
- 领域状态机、基础设施适配和跨模块编排具有明确归属。

### 负面后果

- 单体仍共享进程和数据库，错误的全局并发配置可能造成资源争用。
- Plugin 必须维护对 Medusa 稳定接口的兼容测试。
- 如果未来确实需要独立部署某个平面，仍需设计显式协议和数据所有权迁移。
- 同一仓库发布物较大，CI 必须使用 path-filtered job 控制反馈时间。

## 验证方式

1. 静态依赖检查：Campaign/Allocation 源码不得导入 Medusa 内部 Model、Repository 或直接 SQL 表名。
2. Contract Test：Commerce Adapter 针对使用到的 Medusa Workflow/Module Interface 建立契约测试。
3. Plugin 集成测试：Plugin 在不修改 Medusa Core 的情况下完成 Campaign 创建、Admission、Checkout、Expiry 和 Reconciliation 主路径。
4. 角色测试：同一镜像分别以 `ROLE=api`、`ROLE=worker` 和 `ROLE=all` 启动；API 角色不执行后台 job，Worker 角色不暴露 store/admin API。
5. CI 范围检查：FlashSale 变更运行 Plugin 定向 lint、typecheck、unit、integration、migration 和 HTTP smoke test。
6. Upstream 差异审查：若修改 `packages/core` 或 `packages/modules/inventory`，PR 必须引用新的 ADR，并证明默认行为、Contract Test 和 Backorder 场景不变。
