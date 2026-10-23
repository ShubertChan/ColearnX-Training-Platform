# W7 实施说明与验收手册 —— 风控规则引擎与资金侧风控

配套 `W2-threat-model.md`（发现登记册 §3.4、§4）与本次代码改动，说明**做了什么、
为什么这样做、怎么验证它确实生效**。未经验证的安全控制在报告里等于零。

W7 处置资金链路上两条一直空着的发现，用的全是前几周铺好的地基，**不改数据库结构**：
009 预留的 `risk_score` / `rule_hits` 列就是给这周的规则引擎用的，HANDOVER 第 4 节写明
`security_events` 与 `auth_failure_counters.lockout_count` 供 W7 消费。

| 编号 | 发现 | 本次处置 | 落点 |
|------|------|----------|------|
| F-22 | `point_ledger_entries` 无每日对账作业，账本失衡无人发现（6 高） | 只读对账作业：按账户用账本增量重算四个余额，与投影对比，失衡即记 `finance.ledger_imbalance` 事件 | `security/ledger-audit.ts`、`ledger-audit-run.ts` |
| F-21 | 资金链路无任何异常检测（9 严重） | 纯函数风控规则引擎 + 批量扫描：退款滥用 / 创作者自购刷单 / 买后秒退，命中即记 `finance.risk_flagged` 事件（带 risk_score、rule_hits） | `security/fraud-rules.ts`、`risk-sweep.ts`、`risk-sweep-run.ts` |

---

## 1. 设计约束（破坏了会静默失效）

### 1.1 检测，不拦截

风控扫描**从不**阻断线上购买或退款——它只读近期资金活动、命中规则就把风险事件写进
安全账本。这避免了"加风控反而误伤正常用户"的反向风险（威胁模型 §5 的同类教训）。
处置是"让异常可见"，与 F-12 把攻击尝试变可观测是同一思路。

### 1.2 账本是真相，投影要对得上

`point_accounts` 的四个余额（available/frozen/expired/blocked）是 `point_ledger_entries`
的投影；每笔交易的签名增量由 002 的触发器强制求和为零。对账把**每个账户的增量求和**
与投影逐项对比，不一致就是失衡——要么余额被改坏，要么有写路径更新了投影却没落账本。
两次读取放在**同一个只读可重复读快照**里，否则一笔正在提交的交易会被误报成失衡。

### 1.3 规则引擎是纯函数

`fraud-rules.ts` 不碰数据库、时钟、环境：给定每个主体在窗口内的聚合计数，决定命中哪些
规则、累加权重得 0–100 风险分、映射严重度。阈值和评分因此能被穷举单测。`risk-sweep.ts`
只负责把聚合查出来喂给它、把判定写成事件。

### 1.4 写入失败必须被上报，不能静默成功

作业的唯一目的就是把发现写进 `security_events`。请求路径用的 `recordSecurityEvent`
**故意永不抛错**（记日志失败不能把正常登录变成 500），但作业**不能**复用这个"吞错"行为，
否则写库失败会被悄悄吞掉、作业还打印成功，发现就丢了。所以作业改用会抛错的
`persistSecurityEvent`，逐条统计写入失败数（`recordFailures`）：有失败就在汇总里明确报出、
并以**非零码退出**，让调度器不会把它当成一次干净的运行。

### 1.5 作业以运行时角色只读运行

对账与扫描只 `SELECT` 账本/订单/退款，并 `INSERT` 一条 `security_events`——这些
`colearnx_app` 都有权限（009 给了 security_events 的 SELECT/INSERT）。无需 owner 连接，
与 retention 清理作业（需 owner 删除）不同。作业事件用系统指纹（无 IP/UA/请求号）落库。

---

## 2. 运行方式

```bash
# 账本对账（建议每日）：逐账户核对投影与账本增量
npm --prefix apps/api run security:ledger-audit

# 资金侧风控扫描（建议每日/每班）：窗口与阈值可用环境变量调
FINANCE_RISK_WINDOW_DAYS=30 FINANCE_RAPID_REFUND_SECONDS=300 \
  npm --prefix apps/api run security:risk-sweep
```

命中的 `finance.ledger_imbalance` / `finance.risk_flagged` 事件会直接出现在 W6 安全监控
看板（事件流、按类型分布、趋势；risk_flagged 带 risk_score 与 rule_hits）。

---

## 3. 验证清单

每条都要**实际执行并留存输出**，作为周报与答辩证据。

### 3.1 构建与单测（必须先全绿）

```bash
npm --prefix apps/api run typecheck     # 类型检查
npm --prefix apps/api run test          # 新增 ledger-audit / fraud-rules / risk-sweep 三份测试
```

### 3.2 对账能发现失衡

构造一个投影与账本不符的账户（或在测试库手动改一条 `point_accounts` 的余额），跑
`security:ledger-audit`，确认：输出报告失衡账户数 +1，且 `security_events` 新增一条
`finance.ledger_imbalance`（severity 3，context 含 pointAccountId 与逐项 projected/ledger/delta，
**无原始 IP/UA**）。

### 3.3 风控能命中三类行为

- 自购：让某创作者买下自己的 listing（order.buyer = order_item.seller）。
- 退款滥用：同一用户窗口内发起 ≥ 3 次退款申请。
- 买后秒退：下单后 5 分钟内发起退款 ≥ 2 次。

跑 `security:risk-sweep`，确认各自被标记：`finance.risk_flagged` 的 `rule_hits` 分别含
`self_purchase` / `refund_velocity` / `rapid_refund`，`risk_score` 与严重度符合预期
（自购 60/高，退款滥用 40/中，秒退 20/低，叠加封顶 100）。

### 3.4 不误伤、不泄露

确认正常用户（无命中）不产生事件；事件 context 里只有计数与原因文字，无邮箱/令牌/原始 IP。

### 3.5 写库失败会被上报且非零退出

临时让 `security_events` 的 INSERT 失败（例如回收 `colearnx_app` 的 INSERT 权限，或指向
一个只读副本），构造一个会命中的账户/用户后跑作业，确认：输出里 `event write(s) failed`
计数 > 0，进程**以非零码退出**，而不是打印一行干净的成功。单测已用假 pool 锁住这一点
（emit 抛错时计入 `recordFailures` 且作业不中断）。

---

## 4. 本周未处置的欠债（如实记录）

- **F-27**（6 高，原排 W4）：`privacy_requests.identity_verified_at` 仍在 `privacy.ts`
  中被无条件写入 `now()`，字段名声称已验证身份但流程无任何验证。该列是 `NOT NULL`，
  如实修复（改名 `submitted_at`，或改为可空并写 NULL）**需要一次迁移**，超出 W7「不改
  表结构」范围，建议单独一个带迁移的小改动处置。
- **F-16**（2 低，原排 W4）：`REFRESH_TOKEN_SECRET` 同时用于签注册续期 cookie，密钥用途
  复用。修复需新增独立密钥（环境变量）并改 auth 续期路径，留作单独小改动。

---

## 5. 给后续周次的接续点

- `risk_score` / `rule_hits` 现在被 `finance.risk_flagged` 真正写入，W6 看板已能展示；
  后续可在看板加资金风险的专项 KPI。
- `auth_failure_counters.lockout_count`（HANDOVER 列出的 W7 风险信号）可作为第四条规则
  并入 `fraud-rules.ts`，纯函数接口已经为此留好。
- 规则目前是批量检测；若要在退款/下单入口内联评估，`scoreActor` 可直接复用。
