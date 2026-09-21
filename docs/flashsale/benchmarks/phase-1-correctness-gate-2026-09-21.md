# Phase 1 并发正确性验收报告

- 验收日期：2026-09-21
- 被测提交：`a3ea114968b0262bc14edb2f7a1229453ae533da`
- 被测分支：`codex/flashsale-phase-1a`
- 结论：**通过**
- Release Evidence：`eligible=true`

## 1. 验收范围

本次验收关闭技术方案中 Phase 1 的正确性退出条件：Quota 为 50，向同一 PostgreSQL 提交
500 个并发 Allocation Command，使用 4 个独立 Node 子进程，连续执行 10 轮，并要求：

- 每轮恰好 50 个 Hold、450 个容量耗尽拒绝；
- Capacity、Subject、Hold、Attempt 和当前 Outbox Event 不发生不变量漂移；
- 同一 Idempotency Key 的并发重放只产生一个 Logical Attempt；
- 正式 Allocation Reconciler 对每个场景返回零问题；
- Checkout 响应丢失重放和不同 Key 的同 Cart 竞态只产生一个 Order 和一个 Reservation；
- Outbox 多发布者 Claim、Worker 崩溃接管和旧 Epoch Fencing 继续通过。

验收命令：

```powershell
$env:DB_HOST = "localhost"
$env:DB_PORT = "5432"
$env:DB_USERNAME = "postgres"
$env:DB_PASSWORD = "postgres"
corepack yarn workspace @medusajs/flash-sale-plugin test:phase1:gate
```

## 2. 运行环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows x64 `10.0.26200` |
| CPU | Intel Core i7-14650HX，24 Logical CPUs |
| 内存 | 34,049,220,608 bytes |
| Node.js | `v24.14.0` |
| Yarn | `3.2.1` |
| PostgreSQL | `16.15` |
| Worker | 4 个独立 Node 子进程 |
| 每 Worker 数据库连接池上限 | 8 |
| 调用方式 | Child Process stdio + Direct Handler |
| 根 `yarn.lock` SHA-256 | `fae053aa8ab0ea8ef12358bb4e26e936d3a84e75b6031e58ef4fe1f79ad6b3ff` |

## 3. 十轮结果

| 轮次 | 本轮总耗时 ms | 50/500 竞争耗时 ms | Held | Capacity Exhausted | Unexpected | 重复业务身份 | Reconcile Issues | Same-key Replay |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 10,431.137 | 5,977.027 | 50 | 450 | 0 | 0 | 0 | 19 |
| 2 | 8,957.245 | 5,052.373 | 50 | 450 | 0 | 0 | 0 | 19 |
| 3 | 9,415.196 | 5,441.683 | 50 | 450 | 0 | 0 | 0 | 19 |
| 4 | 9,508.028 | 5,445.430 | 50 | 450 | 0 | 0 | 0 | 19 |
| 5 | 8,861.873 | 5,097.859 | 50 | 450 | 0 | 0 | 0 | 19 |
| 6 | 9,027.453 | 5,000.733 | 50 | 450 | 0 | 0 | 0 | 19 |
| 7 | 9,362.876 | 5,321.164 | 50 | 450 | 0 | 0 | 0 | 19 |
| 8 | 8,647.716 | 4,771.930 | 50 | 450 | 0 | 0 | 0 | 19 |
| 9 | 8,595.410 | 4,461.935 | 50 | 450 | 0 | 0 | 0 | 19 |
| 10 | 8,908.506 | 4,846.263 | 50 | 450 | 0 | 0 | 0 | 19 |

50/500 主竞争场景汇总：

- 提交的竞争 Attempt：5,000；
- 成功 Hold：500；
- Capacity Exhausted：4,500；
- Unexpected Result：0；
- Quota 与 Same-key 证据中的 Duplicate Business Identity：0；
- 所有被测 Allocation 场景的 Reconciliation Issue：0；
- 20 路 Same-key 场景每轮均为 1 次首次执行、19 次 Replay；
- Allocation 多进程套件：3/3 通过；
- Checkout Full-app：12/12 通过；
- Gate 端到端耗时：269,914 ms，包含 Allocation、插件构建和 Checkout Full-app。

## 4. Review 结论

两轮独立 Review 检查了 SQL 断言、正式 Reconciler、报告原子发布、旧报告清理、干净 SHA、
Checkout 单副作用证据、Windows/POSIX 可复现性和 GitHub Actions 配置。修复后结论为：

```text
P0 = 0
P1 = 0
P2 = 0
P3 = 0
```

## 5. 证据边界

本门禁是数据库多进程并发正确性测试，不是 HTTP 吞吐基准。500 表示每轮同时调度 500 个
Direct Handler 调用，实际数据库并发受 4 × 8 的连接池上限约束；耗时不得换算为生产 RPS、p95
或容量上限。Checkout 的零重复 Order 证据来自 Full-app 响应丢失与同 Cart 竞态回归，不代表执行了
500 路 HTTP 下单。

Phase 1 仍只承诺模块本地原子 Outbox、Redis Queue Acceptance 和至少一次投递语义，不承诺
Exactly-once Delivery、Production Consumer Inbox、跨模块全局顺序、Payment UNKNOWN 自动恢复或
Redis HA。这些能力按技术方案进入 Phase 2 及后续阶段。
