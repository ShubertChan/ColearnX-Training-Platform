# 安全模块交接说明（W2–W3，基线 `79adbc4`）

给接手后续安全工作的同学。先读这份，再读 `docs/security/` 下的三份文档。

---

## 1. 这次改了什么

分两块：

- **W2 安全事件基础设施** —— 新增 `security_events` 表与配套写入、告警、
  保留期清理代码。目的是让攻击尝试变得**可观测**：原来的
  `admin_action_logs` 只记录成功的业务操作，且与业务同事务，回滚即丢，
  失败登录、越权、限流这些痕迹完全不落库。
- **W3 账号安全** —— 修复了 4 个实际漏洞（登录时序侧信道、无账号级锁定、
  口令策略过弱、无密码重置流程），并补齐了前端配套页面。

改动清单见 `docs/security/W3-verification.md` 第 1 节的表格，
每条都对应威胁模型里的一个编号（F-01、F-02…）。

---

## 2. 上手前必须知道的三件事

### 2.1 这些代码从未在真实数据库上跑过

已验证的只有**纯函数单元测试**（后端 45 项 + 前端 9 项，全绿）：
口令策略、锁定阶梯、HIBP 响应解析、指纹哈希、事件净化。

**未验证**的是所有需要数据库或网络的路径：

- `registerFailure` 的并发竞态（两个请求同时失败时计数是否正确）
- 重置令牌的单次使用竞态（同一 token 并发提交）
- HIBP 的实际网络往返
- 前端 JSX 是否能通过 Vite 构建（只做了括号平衡与导入检查，未编译）

**所以第一件事是**：

```bash
npm --prefix apps/api run typecheck   # 类型检查
npm run build                          # 前端构建
npm --prefix apps/api run test
npm test
```

四条全过之后，再照 `W3-verification.md` 第 3 节逐条手动验证。
那一节的每条都配了可直接复制的命令。

### 2.2 必须先生成 pepper，否则非开发环境起不来

```bash
openssl rand -hex 32     # 填入 apps/api/.env 的 SECURITY_HASH_PEPPER
```

这个值是 `security_events` 里 IP / UA / 邮箱指纹的 HMAC 密钥。
**不同环境必须用不同的值，绝不能进 git**。开发环境如果留空，
`env.ts` 会从 `ACCESS_TOKEN_SECRET` 派生一个，保证本地能跑起来，
但 staging / production 会直接启动失败——这是有意的。

一旦换掉 pepper，历史事件里的指纹就无法再和新事件关联。
所以**不要随意轮换**，要换就同时规划历史数据怎么处理。

### 2.3 迁移是纯增量的，但顺序不能乱

`009`、`010` 只新增表和列，不修改任何既有行，所以可以安全回滚：

```sql
DROP TABLE security_events, auth_failure_counters;
ALTER TABLE users DROP COLUMN password_changed_at;
DELETE FROM schema_migrations WHERE filename IN
  ('009_security_events.sql', '010_account_protection.sql');
```

但它们依赖 `db/init/001-roles.sh` 创建的三个数据库角色
（`colearnx_app` / `colearnx_migrator` / `colearnx_readonly`）。
在干净的库上必须先 `docker compose up postgres` 让 init 脚本跑完，
否则 `GRANT ... TO colearnx_app` 会报角色不存在。

---

## 3. 三条不要破坏的设计约束

接手改代码时，这三条如果被无意中破坏，安全控制会**静默失效**，
不会有任何报错提示你。

### 约束零：`lib/http.ts` 必须保持零运行时依赖

`ApiError`、`ok`、`errorHandler` 被几乎每个模块引用，所以 `lib/http.ts`
**导入什么，什么就变成全仓库的依赖**。

本次实施踩过一次：403/429 的安全事件记录最初写在 `errorHandler` 里，
于是 `lib/http.ts` 依赖 `security/events.ts`，后者依赖 `config/env.ts`，
结果任何只想用一下 `ApiError` 的单元测试都被迫需要完整环境配置，
三个原本通过的测试直接变红。

正确做法是现在这样：记录放在独立的 `security/access-log.ts` 中间件里，
注册在 `errorHandler` **之前**，只观察不响应。
以后要给错误路径加任何埋点，都走这条路，不要往 `lib/http.ts` 里加 import。

### 约束一：安全事件永远不能进业务事务

`security/events.ts` 里的 `recordSecurityEvent` 用的是
`query()`（从连接池另取连接），不是 `client.query()`。
如果有人为了"方便"把它挪进 `withTransaction` 的回调里，
业务失败回滚的时候安全事件会跟着消失——而这正是它和
`admin_action_logs` 存在差别的唯一理由。

同理，它**永远不能抛错**。记日志失败不能把一次正常登录变成 500。

### 约束二：登录失败的响应必须完全一致

`auth.ts` 的 `login` 里，下面四种情况返回的
状态码、错误码、错误文案**必须一模一样**（都是 401 `INVALID_CREDENTIALS`）：

1. 邮箱不存在
2. 邮箱存在但密码错
3. 账号处于锁定冷却中
4. 密码正确但账号被停用

任何一种被改成可区分的响应，账号锁定就同时变成了**用户枚举 oracle**——
攻击者用错误码的差异就能批量筛出哪些邮箱是真实用户。

同样地，密码不能提前 return。`verifyPasswordConstantWork` 在账号不存在时
也要跑一次等价的 argon2 运算，这是为了抹平时序差异
（详见 `credential-verify.ts` 的注释）。

### 约束三之前：重置流程是团队写的，安全加固是叠加上去的

`forgotPassword` / `resetPassword` 的骨架来自 008，**不是安全组重写的**。
令牌摘要存储、`FOR UPDATE` 原子消费、重置后吊销全部会话这三点原本就做对了。
W3 只叠加了四样东西：账号级冷却、服务端强度闸门、未验证账号拦截、变更通知邮件。

改这两个函数时请分清哪部分是业务、哪部分是安全约束。
特别是 `resetPassword` 的**三段式结构**（先验令牌可用性 → 再校验口令 → 最后原子消费）
不能合并成一段：合并后弱口令会烧掉用户唯一的重置链接，
而把校验放到消费之后又会让无令牌的匿名调用者白嫖一次泄露库查询。

### 约束三：前端口令规则必须是后端的严格子集

`src/utils/passwordPolicy.js` 只做提示，**服务端才是权威**。

规则是：客户端可以比服务端**宽松**，绝不能比服务端**严格**。
宽松的后果是多一次往返并显示明确错误；严格的后果是静默拦掉合法口令，
而且不会出现在任何日志里——上一版代码就犯了这个错
（强制大写+数字，把所有 passphrase 都挡在门外）。

`passwordPolicy.test.js` 里有一条测试专门守着这个方向。

---

## 4. 后续周次的接续点

已经铺好的地基：

| 已有 | 后续谁会用 |
|------|-----------|
| `security_events` 表 + 埋点 | W6 安全看板、W7 风控规则引擎 |
| `auth_failure_counters.lockout_count` | W7 风险评分（重复被锁是风险信号） |
| `users.password_changed_at` | W4 区分新旧策略口令、提示存量用户 |
| compose 里的 Redis（已起，未被读取） | W5 分布式限流、告警去重迁移 |
| `security/alerts.ts` 的进程内去重 Map | W5 必须随限流一起迁到 Redis |

**W4 的具体任务**：TOTP 二次验证与恢复码、管理员强制 2FA、
高危操作 step-up 二次验证、会话列表与全设备登出（威胁模型 F-17）。
这些都挂在现有机制上，不需要动数据模型的骨架。

未处置的发现共 12 条，全部在
`docs/security/W2-threat-model.md` 的发现登记册里，
按风险分值和周次排好了序。**从最上面那条开始做**，不要按兴趣挑。

---

## 5. 已知的、有意为之的取舍

别把这几条当成 bug 去"修"，它们都有书面理由：

| 现象 | 理由 |
|------|------|
| 存量账号仍可用 8 位口令 | 祖父条款。强制几千人同时重置本身就是一次事故 |
| 登录页对口令长度**不做**任何校验 | 同上，前端拦截会把存量用户锁在门外 |
| HIBP 不可用时**放行**口令 | 失败开放。第三方宕机不应阻断全站注册；但会记录 `auth.breach_check_unavailable` 事件，让宕机可见而非静默 |
| 生产环境 Cookie 用 `sameSite=none` | 前后端跨域部署所需，有三重补偿控制，见威胁模型 F-13 |
| 注册接口对已存在邮箱返回 202 | 产品既定行为，收敛成本高于收益，已书面接受，见 F-19 |
