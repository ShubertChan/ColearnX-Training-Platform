# 安全补项：第 5 周人机验证、第 7 周来源与充值风控

这次补的是原计划第 5、7 周的缺项。第 9 周的盘点记录描述的是当时的状态。原有 Redis 限流、单账号失败锁定、MFA、退款和积分对账继续生效。

## 第 5 周：人机验证

密码登录、注册、申请重置密码分别使用 `login`、`register`、`forgot_password` 三个动作。Google 登录使用 `login`，新账号确认条款并注册时需要新的 `register` 凭证。有效的 Google 身份或 MFA 不替代这项校验。重置邮件发出后的单次重置链接仍按原流程校验。

前端从 `GET /api/v1/auth/human-check` 读取公开配置；没有 secret、没有前端构建密钥。启用后，表单等验证通过才允许提交，每次提交都消耗凭证。过期、脚本加载失败或验证不可用时可以重试。API 在账号查询、发邮件或创建会话之前调用 [Cloudflare Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)，只接受当前动作以及 `APP_ORIGIN` 前端主机名匹配的成功结果。缺失、伪造、过期、重复或错用的凭证返回 403；验证服务不可用时返回 503。新增的安全事件不会保存凭证、密码或原始邮箱/IP。

**上线时需要管理员做的事：** 在 Cloudflare 为实际前端主机名创建 Turnstile widget，在 API 服务同时设置 `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY`，确认 `APP_ORIGIN` 指向该前端，然后重启 API。先部署支持该 widget 的前端（构建出的 CSP 只增加了 Cloudflare challenges 的脚本与 iframe 来源）。两个配置都空表示未启用；只配置一个会使 API 拒绝启动；staging/production 禁用 Cloudflare 的公开测试密钥。切换后可从配置接口检查 `enabled: true`，在实际域名完成三种表单，并用无凭证直接请求验证返回 403。未配置正式密钥时不应报告线上防护已启用。

## 第 7 周：四条规则

| 识别什么 | 如何计数 | 处置和面板事件 |
| --- | --- | --- |
| 跨账号撞库 | 同一来源 10 分钟内密码失败的不同邮箱数。真实和不存在的账号合并计数；反复试同一个邮箱只算一个目标。 | 5 个目标记录 `auth.credential_stuffing`；8 个起拒绝该来源的登录 10 分钟（429，带 `Retry-After`）。不锁被尝试的其他账号。 |
| 批量注册 | 同一来源 10 分钟内尝试注册的不同邮箱数，含 Google 验证身份后明确确认注册的请求。 | 5 个目标记录 `auth.registration_burst`；8 个起拒绝该来源注册 10 分钟，在创建用户或发送邮件前生效。 |
| 短时间登录换网 | 同一用户最近 15 分钟内两次完成登录的来源网段不同。IPv4 使用 /24，IPv6 使用 /64；已注册 MFA 的账号只在通过第二因素后计入。 | `auth.login_network_changed`，允许登录并告警。切换移动网络或 VPN 也可能触发；不能据此判定地理位置或盗号。 |
| 高频充值 | 同一用户 10 分钟内至少 5 张不同充值订单实际到账。只统计验签、金额等字段都匹配且已入账的订单。 | `finance.topup_velocity`，正常到账并告警；待付款、失败、过期窗口和重复回调不增加计数。 |

前两条在 5 个目标时，已启用 Turnstile 则记为 `challenge`（每个后续请求仍须提供新凭证）；未启用时记为 `allow` 并记录异常。8 个目标时两种配置都执行 `deny`。原第 3 周的 `lock` 仍由单账号连续失败触发。相同来源、规则、处置在窗口内只记一次告警，拒绝期间的请求不会延长冷却。学校、公司共用出口时可用安全面板复核阈值。

来源取 Express 按现有 `TRUST_PROXY` 配置解析出的地址；反向代理必须按实际跳数设置，并防止客户端直接伪造转发头。IPv4 来源按地址、IPv6 按 /64 归组；邮箱规范化后使用 HMAC。各实例通过 PostgreSQL 共享同一个窗口，观察、判断和告警记录按来源或用户串行处理。管理员可在第 6 周的安全事件面板按事件、风险分和处置查看；外部通知使用原告警阈值及去重设置。

## 第 5 周其余计划项

- 不同 API 实例使用同一 `REDIS_URL`，按操作和来源共享限流配额和告警去重。单账号失败计数和锁定保存在 PostgreSQL。未配置 Redis 的单实例沿用内存计数，扩容前需配置共享 Redis 并验证跨实例 429。
- 预发和生产须明确设置代理跳数。本项目预发 API 的 Render 入口为一跳，启动时拒绝其他值。回归测试在转发链左侧插入伪造 IP，仍消耗同一来源的配额。
- 静态站点移除了脚本和样式中的 `unsafe-inline`。进度条使用原生控件，安全看板使用 SVG。API 和前端均发送两年 HSTS、`includeSubDomains` 和 `preload` 响应头，浏览器预加载名单登记另由域名所有者管理。
- Vite 依据最终字节为首屏 JS、CSS 加 SHA-384 SRI，并为按需导入的 JS（视频、HLS、支付等）生成带完整性元数据的 import map。CSP 仅放行本次构建的 import map 哈希。按需模块的哈希检查依赖浏览器支持 import map 的 `integrity` 字段。由 Google、Stripe 和 Cloudflare 独立更新的 SDK 使用各自官方 HTTPS 来源。
- MFA 两把密钥和事件指纹密钥统一使用同一校验函数。开发和测试沿用各自原有的派生标签，预发和生产要求显式配置。已有数据继续使用相同的密钥值。

## 第 7 周退款率与每日对账

预发发布前按仓库迁移流程读回 ledger 与校验和。此分支增加的唯一迁移是 [022_credited_topup_velocity.sql](../../db/migrations/022_credited_topup_velocity.sql)，给已到账充值的账号与到账时间建部分索引。若 ledger 正确停在 021，由迁移管理员单独批准并应用 022，再核对索引定义和 ledger。普通建索引可能等待或阻塞并发写入，应在合适的发布时间执行。CD 的人工确认不能替代这一步。

退款频次、买后秒退、创作者自购仍按原规则计分。新增 `high_refund_ratio` 按同一购买窗口的付费订单项计算，默认窗口 30 天。账号至少购买 5 个付费项，其中至少一半有获批退款时记录风险事件。一个订单项重复申请只算一次，已取消订单、免费项及窗口外的购买不进入分母。该规则只告警。

在现有 API 服务设置 `ENABLE_DAILY_SECURITY_AUDIT=true` 即可启用每日作业。API 启动和之后每 15 分钟检查一次，02:15 UTC（北京时间 10:15）后执行当天的检查。服务在当天稍晚恢复会补跑当天，多个实例通过数据库锁协调。作业检查每笔积分交易的借贷总和、每个账户的四种余额与账本投影，以及退款和自购风险。发现和当天的 `finance.daily_audit_completed` 完成记录同事务提交，失败回滚后重试。作业沿用受限的 API 数据库账号，无需另建计费的定时服务。

预发验收应核对三个事实：配置接口返回 `enabled: true`，真实域名上的登录、注册、找回密码均能获得并验证各自的凭证，安全账本出现当天的完成记录。用无凭证请求验证 403。前端要先具备 Turnstile 支持再启用 API 的钥匙；回退时先在 API 同时撤下两把 Turnstile 钥匙，再回退前端。仅停每日作业可将其开关设为 `false`。正式 secret 应保存在服务平台，不写入仓库或聊天记录。

## 如何复验

前端运行 `npm test`、`npm run test:components`、`npm run check:i18n` 和 `npm run build`；API 运行 `npm run api:test`、`npm run api:typecheck`。按仓库发布检查指引，给 `RELEASE_CHECK_DATABASE_URL` 指定全新的本机 PostgreSQL 16 测试库，再运行 `npm run release:database-test`；测试会覆盖真实 HTTP 路由、并发注册、撞库、冷却恢复、换网以及 Stripe 签名回调重放。测试验证器和付款签名均在本地生成，不访问正式 Cloudflare、Stripe、邮箱或生产数据。
