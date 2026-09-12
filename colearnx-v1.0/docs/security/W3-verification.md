# W2–W3 实施说明与验收手册

本文件配套 `W2-threat-model.md`、`W2-asvs-gap.md` 与本次代码改动，
说明**做了什么、为什么这样做、怎么验证它确实生效**。
未经验证的安全控制在报告里等于零。

---

## 1. 本次处置的发现

| 编号 | 发现 | 处置 | 落点 |
|------|------|------|------|
| F-12 | 无安全事件记录与告警 | `security_events` 账本 + 统一埋点 + webhook 告警 | `009_security_events.sql`、`security/` |
| F-05 | `sha256(ip)` 可离线反查 | 全部低熵标识改为带 pepper 的 HMAC-SHA-256，并做域分离 | `security/fingerprint.ts` |
| F-07 | CORS 拒绝变成 500 + error 日志 | 改为 `ApiError(403, ORIGIN_NOT_ALLOWED)` | `app.ts` |
| F-01 | 登录时序侧信道枚举用户 | 无论账号是否存在都执行一次等价 argon2 校验 | `auth/credential-verify.ts` |
| F-02 | 无账号级失败锁定 | 渐进式锁定阶梯 + 时间衰减 | `auth/lockout*.ts`、`010_account_protection.sql` |
| F-04 | 口令策略薄弱、无泄露库比对 | NIST 800-63B 对齐策略 + HIBP k-匿名 | `auth/password-policy.ts`、`auth/pwned-passwords.ts` |
| F-03 | 重置流程缺冷却/强度校验/通知 | **保留 008 的流程**，补账号级冷却、服务端强度闸门、变更通知、清除锁定 | `auth/auth.ts` |
| F-24 | 重置口令无服务端强度校验 | 接入与注册共用的 `assertPasswordAcceptable` | `auth/password-gate.ts` |
| F-25 | 重置无账号级冷却 | 60 秒/账号 + 独立的 5 次/15 分钟限流器 | `auth/auth.ts`、`app.ts` |
| F-26 | 重置不校验邮箱已验证 | 未验证账号不签发链接，走验证重发路径 | `auth/auth.ts` |
| — | ASVS 7.2.2 访问控制决策未记录 | 独立中间件集中记录全部 403/429，注册于 `errorHandler` 之前 | `security/access-log.ts` |
| F-23 | 前端强制字符组成规则，与后端策略相悖 | 移除组成规则，改为与后端一致的清单式实时反馈 | `utils/passwordPolicy.js`、`AuthPages.jsx` |
| — | ASVS 2.1.8 无口令强度反馈 | 逐条清单 + 四档指示条 | `PasswordGuidance` |

---

## 2. 部署步骤

```bash
# 1) 生成 pepper 并写入 apps/api/.env
openssl rand -hex 32        # → SECURITY_HASH_PEPPER
# 告警通道：任意接受 JSON POST 的地址（Slack incoming webhook 最省事）
#          → SECURITY_ALERT_WEBHOOK_URL

# 2) 起依赖（新增 Redis，W5 才会被读取）
docker compose up -d postgres redis

# 3) 迁移
npm --prefix apps/api run db:migrate   # 应用 009、010

# 4) 单元测试
npm --prefix apps/api run test
```

**回滚**：008 与 009 都是纯增量的（只新增表/列，不修改既有行）。
如需回退，只要 `DROP TABLE security_events, auth_failure_counters;
-- 注意：password_reset_challenges 属于团队的 008，不要动`
并 `ALTER TABLE users DROP COLUMN password_changed_at;`，同时删除
`schema_migrations` 中对应两行即可。业务数据不受影响。

---

## 3. 验证清单

每一条都要**实际执行并留存输出**，作为周报与答辩证据。

### 3.1 F-01 时序侧信道（这是最容易在报告里出彩的一条）

改动前后各跑一次，对比两组分布：

```bash
# 不存在的邮箱 × 30 次
for i in $(seq 30); do
  curl -s -o /dev/null -w "%{time_total}\n" -X POST http://localhost:3001/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"nobody-'$i'@example.invalid","password":"WrongPassword123!"}'
done > /tmp/absent.txt

# 存在的邮箱、错误口令 × 30 次（换成你 seed 出来的账号）
for i in $(seq 30); do
  curl -s -o /dev/null -w "%{time_total}\n" -X POST http://localhost:3001/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"member@colearnx.test","password":"WrongPassword123!"}'
done > /tmp/present.txt

paste /tmp/absent.txt /tmp/present.txt | awk '{a+=$1; b+=$2} END {printf "absent %.4fs  present %.4fs  delta %.4fs\n", a/NR, b/NR, (b-a)/NR}'
```

**判定标准**：`delta` 的绝对值应落在同批次内部抖动的量级（通常 < 3 ms），
而不是 argon2 一次校验的量级（几十到上百毫秒）。
改动前该差值约等于一次 argon2 的耗时，改动后应被抹平。

> 注意：账号级锁定会在第 5 次失败后介入，所以测存在账号时请把
> `LOGIN_FAILURE_DECAY_HOURS` 临时调小、或每轮之间清一次
> `auth_failure_counters`，否则测的是锁定路径而不是校验路径。

### 3.2 F-02 渐进式锁定

```bash
for i in $(seq 6); do
  curl -s -X POST http://localhost:3001/api/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"member@colearnx.test","password":"Wrong-'$i'"}' | jq -c .error.code
done
```

必须同时成立：

- [ ] 6 次返回的 `code` **完全相同**，都是 `INVALID_CREDENTIALS`。
      一旦出现 `ACCOUNT_LOCKED` 之类的区分，锁定就变成了枚举 oracle。
- [ ] 第 5 次之后，即使输入**正确**口令也仍然返回 `INVALID_CREDENTIALS`。
- [ ] 等待 60 秒后，正确口令可以登录成功。
- [ ] 数据库中 `auth_failure_counters.locked_until` 已被写入。

```sql
SELECT consecutive_failures, locked_until, lockout_count
  FROM auth_failure_counters WHERE user_id = '<uuid>';
```

### 3.3 F-04 口令策略与泄露库

```bash
# 应被拒：短
curl -s -X POST .../auth/register -d '{"password":"Short1!", ...}' | jq .error.code
# → PASSWORD_TOO_SHORT

# 应被拒：归约后命中名单
# → PASSWORD_TOO_COMMON

# 应被拒：长度足够、不在本地名单、但在 HIBP 中
# 例如 "trustnobody2024" 这类真实泄露口令
# → PASSWORD_BREACHED

# 应通过
# → 202
```

- [ ] 断网后重试：注册**仍应成功**（失败开放），且
      `security_events` 出现一条 `auth.breach_check_unavailable`。
      这一条验证的是"失败开放没有变成静默失效"。

```bash
# 用抓包确认离开进程的只有 5 个字符的前缀，而不是口令或完整哈希
sudo tcpdump -i any -A host api.pwnedpasswords.com | grep -i "GET /range"
```

### 3.4 F-03 密码重置

- [ ] 对**未注册**地址请求重置 → `202 {"accepted":true}`
- [ ] 对**已注册**地址请求重置 → `202 {"accepted":true}`（两者的状态码、响应体、耗时量级须一致）
- [ ] 同一地址 60 秒内二次请求 → 仍是 `202`，但**不再发信**
- [ ] 重置链接使用一次后再用 → `PASSWORD_RESET_TOKEN_INVALID`
- [ ] 提交 `aaaaaaaa`（8 位，旧规则可过）→ `PASSWORD_TOO_SHORT`，**且令牌仍可用**
      （策略校验先于消费，弱口令不能烧掉用户唯一的重置链接）
- [ ] 对**未验证邮箱**的账号请求重置 → 仍是 202，但不发信，
      `security_events` 出现 `auth.reset_unverified_account`
- [ ] 重置成功后，**旧的 refresh cookie 立刻失效**：

```bash
curl -s -X POST .../auth/refresh -b "colearnx_refresh=<旧值>" -H "X-CSRF-Token: <旧值>" | jq .error.code
# → REFRESH_TOKEN_INVALID 或 REFRESH_TOKEN_MISSING
```

- [ ] 重置成功后返回 `{"reset":true,"signInRequired":true}`，**不含 accessToken**
- [ ] 重置页打开后地址栏 `#/reset-password` 后面**不再带 token**
- [ ] 收到"密码已变更"通知邮件
- [ ] 重置成功后，此前的锁定被清除

```sql
SELECT consecutive_failures, locked_until FROM auth_failure_counters WHERE user_id = '<uuid>';
-- 应为 0 / NULL
```

### 3.5 F-12 安全事件账本

```sql
-- 事件是否在写入
SELECT event_type, severity, decision, count(*)
  FROM security_events
 WHERE occurred_at > now() - interval '1 hour'
 GROUP BY 1, 2, 3 ORDER BY 2 DESC, 4 DESC;

-- 关键属性：运行时角色不能删除自己的痕迹
SET ROLE colearnx_app;
DELETE FROM security_events;   -- 必须报 permission denied
RESET ROLE;

-- 关键属性：context 中不得出现任何明文敏感值
SELECT context_json FROM security_events
 WHERE context_json::text ~* '(password|token|secret|@)' LIMIT 10;
-- 应返回 0 行
```

- [ ] 制造一次 refresh token 重放（复制一个已轮换的 cookie 再发一次 refresh），
      确认 `session.refresh_reused` 落库且 webhook 收到 CRITICAL 告警
- [ ] 确认**业务事务回滚时安全事件仍然存在**（这是本表与
      `admin_action_logs` 的核心差别，值得单独演示一次）

### 3.6 F-07 CORS 拒绝

```bash
curl -s -i -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}' | head -1
# → HTTP/1.1 403，且服务端日志不应出现 error 级的 "Unhandled API error"
```

---

## 4. 单元测试覆盖

```
$ npm --prefix apps/api run test

lockout-policy      6 项   阶梯单调性、阈值边界、饱和上限、攻击者猜测速率上界
password-policy    15 项   长度按码点计、NFKC 归一化、归约后命中名单、
                          不按子串误杀、不施加字符组成规则
pwned-range         6 项   仅 5 字符前缀外发、填充项计为 0、畸形响应不抛异常
fingerprint         8 项   pepper 依赖性、域分离、长度边界、与 auth 的大小写一致
taxonomy           10 项   严重度取值域、密钥类字段剔除、深度与体积上限
```

> `lockout-policy.test.ts` 里那条"攻击者被压到每小时不到 1 次猜测"
> 是把安全属性本身写成断言，而不是只测函数返回值——这类测试在答辩时
> 比覆盖率数字有说服力得多。

**尚未覆盖**：需要真实数据库与网络的路径（`registerFailure` 的并发竞态、
重置令牌的单次使用竞态、HIBP 的实际往返）。这些归到 **W9** 的
`supertest` 集成测试套件，届时用 testcontainers 起临时 Postgres。
在此之前，按 §3 手动验证并留存输出。

---

## 5. 已知遗留与交接给后续周次的事项

| 事项 | 原因 | 周次 |
|------|------|------|
| 限流仍是进程内存态 | 需要 Redis store，本周只把 Redis 备好 | W5 |
| 告警去重是进程内 Map | 单实例下正确；水平扩容后须随限流一起迁到 Redis | W5 |
| ~~前端缺少 `/reset-password` 页面~~ | 已完成：`ResetPasswordPage` 挂载于 `/reset-password`，挂载即用 `history.replaceState` 抹掉 token | ✅ W3 |
| 无 2FA，重置流程缺少第二因子 | 依赖 W4 的 TOTP；届时重置应要求 TOTP 或恢复码 | W4 |
| 存量账号仍是 8 位口令 | 刻意做了祖父条款。`users.password_changed_at` 为 NULL 即表示"策略之前设置" | W4 起逐步提示 |
| 安全看板未建 | 数据已在写入，缺可视化 | W6 |

---

## 6. 一条写进报告会很吃亏的话

不要写"本系统已通过安全加固，不存在安全漏洞"。
按本次评估，仍有 **18 条 ASVS L2 条目不满足**、**12 条发现未处置**，
这些在 `W2-asvs-gap.md` 与威胁模型的登记册里都是可查的。
如实写"已处置 8 条、其余按周次排期、2 条书面接受风险"，
比一句无法支撑的结论可信得多，也更经得起追问。
