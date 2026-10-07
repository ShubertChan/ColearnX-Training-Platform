# W6 实施说明与验收手册 —— 安全事件监控看板

本文件配套 `W2-threat-model.md`、`HANDOVER.md` 与本次代码改动，说明**做了什么、
为什么这样做、怎么验证它确实生效**。未经验证的安全控制在报告里等于零。

W6 不处置新的威胁编号——它把 W2 建好、却一直没有人类入口的 `security_events`
账本（F-12）变成管理员看得见的东西。HANDOVER.md 第 4 节把这一周写死为「安全看板」，
并说明 009 迁移里预留的 `risk_score` / `rule_hits` 列和四个索引就是为它铺的路，
所以**本周不改数据库结构**。

---

## 1. 本次交付

| 能力 | 说明 | 落点 |
|------|------|------|
| 聚合接口 | `GET /admin/security/summary`：时间窗内按严重度/类型计数、每日趋势、重点指标、被攻击账号与来源数 | `apps/api/src/admin/security-dashboard.ts` |
| 事件流接口 | `GET /admin/security/events`：按严重度/类型筛选、游标分页、最新在前 | 同上 |
| 看板页面 | KPI 卡片 + 每日趋势柱图 + 高频事件类型 + 可筛选分页的事件表 | `src/pages/AdminSecurityDashboardPage.jsx` |
| 读取侧 step-up | GET 版的 `withStepUp` 封装，复用现有二次验证设施 | `src/api/security.js` |
| 纯函数与测试 | 游标编解码、趋势零填充、严重度标签、类型美化 | `security-dashboard.test.ts`、`utils/securityDashboard*.js` |
| 导航与路由 | 管理员导航新增「Security Monitor」，`/admin/security` 路由 | `Layout.jsx`、`App.jsx` |

---

## 2. 三条设计约束（破坏了会静默失效）

### 2.1 看板只读指纹，绝不吐原始 IP/UA

账本里 `actor_ip_hash` / `actor_ua_hash` 是带 pepper 的 HMAC（F-05），本身不可反查。
事件流接口再把它截断成 12 位的关联前缀（`source`）才下发——够用来判断「这几条是不是
同一来源」，但不给任何可反推的材料。`context_json` 在写入时已被 `taxonomy.ts` 的
`sanitiseContext` 剥掉密钥与原始标识，接口按存储原样转发，不做二次拼装。

### 2.2 看板读取被当作高危操作，叠加 step-up

两个接口都在 `authenticate → requireRole('admin') → requireAdminMfa` 之上再加
`requireStepUp`（ASVS 3.7.1）。理由：事件流聚合了全平台的认证与访问控制痕迹，
一个被借用的管理员会话若能随意浏览它，等于拿到一份「谁在被攻击、哪些账号已被锁」
的地图。这与上面付费内容预览路由 `previewContentAsset` 的把关一致。

GET 请求默认不走 `mutateApi`，因此前端新增 `getWithStepUp`：用现有 `withStepUp`
包住 GET，弹一次身份确认、缓存短期凭据、过期自动重试一次，并附上 `X-Step-Up-Token` 头。
管理员取消弹窗不是错误，页面给出「确认身份后加载」的平静再入口，而非报错墙。

### 2.3 读取用只读快照，多个聚合彼此自洽

`summary` 的四条聚合查询跑在同一个 `withReadOnlySnapshot`（REPEATABLE READ READ ONLY）
事务里，保证 KPI、趋势、类型分布读的是同一时刻的账本，不会出现「总数和分项对不上」。
计数一律 `::text` 取出再经 `safeMetric` 解析，拒绝 JSON 无法精确承载的数字。

---

## 3. 验证清单

每一条都要**实际执行并留存输出**，作为周报与答辩证据。

### 3.1 构建与单测（必须先全绿）

```bash
npm --prefix apps/api run typecheck      # 后端类型检查
npm --prefix apps/api run test           # 新增 security-dashboard.test.ts
npm run build                            # 前端构建（含严格 CSP）
npm test                                 # 前端 node 测试（含 securityDashboard.test.js）
npm run test:components                  # 含 AdminSecurityDashboard.test.jsx
```

### 3.2 权限闸门（三道都要挡住）

```bash
# 无 admin 角色 → 403；admin 但未绑定 MFA → 403 MFA_ENROLMENT_REQUIRED；
# admin + MFA 但无 step-up 头 → 401 STEP_UP_REQUIRED
curl -s -i -H "Authorization: Bearer <member-token>" \
  "$API/api/v1/admin/security/summary" | head -n 1      # 期望 403
curl -s -i -H "Authorization: Bearer <admin-no-mfa>" \
  "$API/api/v1/admin/security/summary" | head -n 1      # 期望 403
curl -s -i -H "Authorization: Bearer <admin-mfa>" \
  "$API/api/v1/admin/security/summary" | head -n 1      # 期望 401 STEP_UP_REQUIRED
```

### 3.3 不泄露 PII

用一个带 step-up 头的管理员请求拉 `events`，确认响应里：
`source` 只有 12 位十六进制、无任何点分 IP、`context` 里无邮箱/令牌/密钥字段。

```bash
curl -s -H "Authorization: Bearer <admin-mfa>" -H "X-Step-Up-Token: <proof>" \
  "$API/api/v1/admin/security/events?limit=5" | jq '.data[0]'
```

### 3.4 页面手测

以管理员登录 → 侧栏「Security Monitor」→ 弹出身份确认 → 输入验证器码 →
看板加载：KPI 卡有数、趋势柱图随窗口变化、点某个事件类型会把事件表筛到该类型、
严重度分段（All / Medium+ / High+）切换会重拉事件、翻页「Load more」可续取。
故意点「取消」身份确认 → 看到平静的再入口而非报错。

> 造数据：触发几次失败登录、一次账号锁定、一次限流，`security_events` 就会有料，
> 看板即可见。

---

## 4. 给 W7 的接续点

- `risk_score` / `rule_hits` 仍是 0 和空数组，W7 风控规则引擎写入后，事件流已经把
  这两列带在每行里，看板无需改接口即可展示。
- `summary` 的「被攻击账号数 / 来源数」就是 W7 撞库检测的第一批信号来源。
- 事件流的游标分页与筛选，可直接复用为 W7 规则命中回放的查询层。
