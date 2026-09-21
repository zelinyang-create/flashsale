# Phase 1 正确性门禁运行手册

## 目标与边界

本门禁用于给 Phase 1 的并发正确性收口提供可复核证据。它包含两个串行门禁：

1. Allocation 多进程正确性测试：4 个 Node worker，每轮提交 500 个进程内 allocation command，
   quota 为 50，共运行 10 轮；逐轮检查数据库精确计数、业务身份重复、内部不变量和正式
   reconciliation 结果。
2. Checkout full-app 回归：复用现有 full-app 测试，验证响应丢失重放和不同幂等键的同购物车
   竞态最终都只产生一个 Order；同时验证 Reservation 和 PurchaseAttempt 的断言。

这里的 500 个请求是 **进程内 Allocation command**，不是 500 路 HTTP 下单压测。报告中的耗时只用于
定位异常和比较同环境下的运行波动，不能解释为 HTTP 吞吐量、容量上限或生产性能结论。

## 前置条件

- 从仓库根目录运行命令。
- 已安装仓库依赖，并能使用仓库固定的 Yarn 3.2.1。
- PostgreSQL 已启动，且当前用户可以创建和删除测试数据库。
- `DB_HOST`、`DB_USERNAME`、`DB_PASSWORD` 已指向测试 PostgreSQL。若端口不是 5432，另设
  `DB_PORT`。

本地 Docker PostgreSQL 的常见配置如下。

PowerShell：

```powershell
$env:DB_HOST = "localhost"
$env:DB_USERNAME = "postgres"
$env:DB_PASSWORD = "postgres"
corepack yarn workspace @medusajs/flash-sale-plugin test:phase1:gate
```

POSIX shell：

```sh
DB_HOST=localhost \
DB_USERNAME=postgres \
DB_PASSWORD=postgres \
corepack yarn workspace @medusajs/flash-sale-plugin test:phase1:gate
```

## 产物与发布规则

默认最终产物为：

```text
packages/plugins/flash-sale/artifacts/phase1/phase1-correctness-gate.json
```

runner 启动时会删除旧的最终产物和 candidate。Allocation 测试只能写 candidate；只有
Allocation 全套测试、插件构建和 Checkout full-app 回归全部以退出码 0 完成，并且 candidate
存在且声明 4 worker/10 轮通过时，runner 才会原子发布最终 JSON。任一步失败都会删除 candidate
和旧的最终产物，并返回非零退出码，因此失败运行不会留下看似成功的陈旧报告。

可用 `FLASH_SALE_PHASE1_REPORT_PATH` 覆盖最终路径。

PowerShell：

```powershell
$env:FLASH_SALE_PHASE1_REPORT_PATH = "C:\temp\phase1-gate.json"
corepack yarn workspace @medusajs/flash-sale-plugin test:phase1:gate
```

POSIX shell：

```sh
FLASH_SALE_PHASE1_REPORT_PATH=/tmp/phase1-gate.json \
corepack yarn workspace @medusajs/flash-sale-plugin test:phase1:gate
```

仓库默认路径下的 `artifacts/` 已被插件 `.gitignore` 排除，避免本地证据误入源码提交。

## Source state 与 release evidence

runner 在任何测试开始前记录 branch、HEAD，以及 tracked、staged、untracked 三类工作区变化；明确的
报告 target/candidate 路径不计入 dirty 判断。若 Git 元数据不可用或工作区不干净，测试仍可运行并
如实记录结果，但最终报告的 `release_evidence.eligible` 必须为 `false`，不能把这次 `passed` 当作
干净提交对应的 release evidence。需要正式证据时，应清理工作区后重新运行。

最终报告还记录 Node、Yarn、操作系统、CPU、内存、PostgreSQL 版本和根 `yarn.lock` SHA-256，
方便判断两份结果是否来自可比较环境。

## 结果判读

- `passed=true`：本次 Allocation 与 Checkout 两套测试都通过。
- `release_evidence.eligible=true`：测试开始时源码状态可解析且工作区干净；此字段与 `passed`
  必须同时满足，报告才可作为 release evidence。
- `allocation_gate.configuration.transport=child_process_stdio` 且
  `invocation=direct_handler`：明确四个独立子进程通过 stdio 接收任务并直接调用 Handler，不是 HTTP 压测。
- `allocation_gate.configuration.timing_not_for_throughput=true`：耗时不得换算为吞吐量。
- `checkout_full_app.evidence`：一个 Order 的证据来自现有 full-app 测试中的订单、预留和尝试记录
  断言，不代表执行过 500 路 HTTP 订单测试。
