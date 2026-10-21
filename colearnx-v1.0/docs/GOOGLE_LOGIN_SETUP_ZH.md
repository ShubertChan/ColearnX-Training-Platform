# Google 登录配置与部署交接

适用版本：新增 `021_google_sign_in.sql` 的版本。本文的 staging 地址来自仓库 `deployment/staging.json`；正式环境必须换成实际域名。

## 1. 功能和账号规则

- 登录页原有登录按钮、找回密码下方显示 Google 官方按钮，中英文切换立即更新按钮及提示。
- 首次使用 Google 的新用户确认条款和年龄政策后，自动创建 Member、个人资料和积分账户，不需要设置密码或再填注册表。
- 同一个邮箱以前用密码注册过：按忽略大小写的邮箱匹配，关联原来的 `user_id`。课程、订单、积分、角色和已验证账号的原密码全部保留。
- 关联后使用 Google 的稳定 `sub` 标识识别账号，Workspace 邮箱改名不会再创建一个账号，也不会自动覆盖平台邮箱。
- 已开启双重验证的账号仍须输入第二因素。暂停、删除、临时锁定账号不能通过 Google 绕过限制。
- 如果邮箱注册从未完成验证，Google 验证邮箱后会废弃之前未验证的密码。之后可通过“忘记密码”设置自己的密码，防止别人预先注册邮箱后保留入口。历史免验证账号的密码保留。
- 自动关联只支持 Gmail 和 Google Workspace。使用 Outlook、QQ 等外部邮箱创建的 Google 账号，请用平台邮箱/密码登录。Google 的 `email_verified` 对这些邮箱不能证明当前所有权，不能安全地只凭这个字段合并账号。详见 [Google 的服务端验证说明](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)。
- Gmail 的点号或 `+` 别名不会被擅自合并；“同邮箱”指忽略大小写后完全相同的地址。

## 2. 本次实现采用哪一种 OAuth 配置

使用 **Google Identity Services 官方按钮 + 弹窗 + ID token 服务端验证**。

浏览器通过 JavaScript callback 收到 Google 凭证，再提交给本平台 API。后端使用官方 `google-auth-library` 验证签名、签发方、Client ID、有效期、已验证邮箱和一次性 nonce。

因此本次只需 `GOOGLE_CLIENT_ID`，**不需要 Client Secret，也不需要配置授权重定向 URI**。不要套用另一个“后端授权码回调”教程填写 `/auth/google/callback`，本实现没有这条路由。参见 [Google 官方客户端配置](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)。

## 3. 你在 Google 控制台逐步操作

### 第 1 步：选择项目

打开 [Google Cloud Console](https://console.cloud.google.com/)，登录负责平台的 Google 账号。用顶部项目选择器选已有 CoLearnX 项目，或新建 `CoLearnX Staging`。建议 staging 和正式环境分别管理客户端。

### 第 2 步：初始化 Google Auth Platform

在控制台搜索 `Google Auth Platform`，进入后点击 Get started（如果已初始化则直接打开 Branding）。

填写应用名 `CoLearnX`、用户支持邮箱和开发者联系邮箱。支持邮箱应由团队长期维护。

### 第 3 步：设置受众

在 Audience 选择 External，以允许普通 Gmail 用户登录。如果仅限组织成员才选 Internal。

开发阶段可保留 Testing，添加自己和部署同学作为测试用户；正式开放前检查 Audience 的发布状态并按控制台要求发布。是否需要品牌/域名审核以项目显示的 Verification 状态为准，不要假设“创建 Client ID 后就自动完成审核”。

### 第 4 步：设置应用品牌和域名

在 Branding 填写平台名称、支持邮箱、主页、隐私政策、服务条款。现有前端使用 HashRouter，staging 地址为：

| 项目 | staging 值 |
|---|---|
| 主页 | `https://staging.colearnx.net` |
| 隐私政策 | `https://staging.colearnx.net/#/privacy` |
| 服务条款 | `https://staging.colearnx.net/#/terms` |
| Authorized domains | `colearnx.net` |

先确认这些页面能够公开访问。若控制台的品牌审核要求可抓取的独立政策页面或域名验证，由域名负责人完成；不要填写不存在的 `/privacy` 静态页面来代替真实路由。Logo 可先不上传，避免把可选品牌审核误当成登录代码故障。

### 第 5 步：确认权限范围

在 Data Access 仅保留登录所需的 `openid`、email、profile 基础权限。不需要 Gmail 读取、Drive、Calendar 权限，也不需要开启 Gmail API。

### 第 6 步：创建 Web Client

打开 [Clients](https://console.cloud.google.com/auth/clients)，点击 Create client，Application type 选 **Web application**，名称可填 `CoLearnX Staging Web`。

在 **Authorized JavaScript origins** 每行添加一个来源：

```text
https://staging.colearnx.net
http://localhost
http://localhost:5173
```

这是网站前端地址。不要加 `/#/login`、`/api/v1`、末尾路径或通配符，也不要把 API 域名当成前端来源。正式环境另建客户端并填真实前端来源。测试时使用 `localhost:5173`，不要随意换成不同端口或 `127.0.0.1`。

**Authorized redirect URIs 留空**，因为本实现采用弹窗 callback。

点击 Create，复制以 `.apps.googleusercontent.com` 结尾的 **Client ID**。Client Secret 即使显示出来也不用于本功能，不要放到前端、GitHub 或聊天里。来源配置的规则见 [Google 管理 OAuth 客户端文档](https://support.google.com/cloud/answer/15549257)。

### 第 7 步：先在本地验证（可选）

在 `apps/api/.env` 中设置：

```dotenv
GOOGLE_CLIENT_ID=这里替换为真实ClientID.apps.googleusercontent.com
APP_ORIGIN=http://localhost:5173
API_ORIGIN=http://localhost:3001
```

保留项目已有的数据库、认证密钥等配置。按 [本地运行说明](LOCAL_RUNBOOK.md) 准备数据库，并用有迁移权限的连接执行 `npm run db:migrate`。前端使用 Vite 自带的 `/api` 代理；不要把 Google Client Secret 写进 `VITE_` 环境变量。

在 `colearnx-v1.0` 启动前端 `npm run dev`，另一个终端启动 API `npm --prefix apps/api run dev`，打开 `http://localhost:5173/#/login`。Vite 如果提示端口被占用，先解决占用，再测试已授权的 5173 来源。

## 4. 部署同学逐步执行

### 第 1 步：确认发布版本

将功能 PR 合入 main 后确认 `CoLearnX CI` 成功，记下完整 40 位 commit SHA。部署仍按现有流程手动操作：**push / PR 自动跑检查，部署不会自动发生**。

CI 已包含 Google 单元、组件、浏览器及真实 PostgreSQL 集成检查，也新增翻译目录检查。它使用本地生成的 RSA 测试签名，不访问 Google，不依赖真实 Client ID 或任何 OAuth Secret。

### 第 2 步：先应用数据库迁移

在可信的运维终端检出目标 SHA，进入 `colearnx-v1.0`，安装 API 锁文件依赖：

```sh
npm --prefix apps/api ci --include=dev
npm run db:migrate
```

执行前通过现有安全配置注入 `MIGRATION_DATABASE_URL` 和 `DATABASE_SSL`，连接目标 staging 数据库。使用原有 owner/migrator 账号，不要使用权限受限的 `colearnx_app` 账号跑迁移，也不要把连接串提交到 Git。

迁移脚本按顺序执行所有未执行迁移，本次新增应显示：

```text
Applied 021_google_sign_in.sql
```

此迁移仅新增 `google_identities`、`google_login_challenges`、索引和明确权限，不改历史迁移，不重建用户、课程或积分表。不要跑 seed，也不要手工伪造迁移账本。查询确认：

```sql
SELECT filename, applied_at
FROM schema_migrations
ORDER BY filename DESC
LIMIT 3;
```

最新应包含 `021_google_sign_in.sql`。如果目标版本已有更新迁移，则以该版本清单为准，不能机械地只填 021。

### 第 3 步：设置 Render API 环境变量

Render → 当前 staging API 服务 → Environment，增加：

```dotenv
GOOGLE_CLIENT_ID=从Google复制的真实ClientID.apps.googleusercontent.com
```

同时确认已有配置：

```dotenv
APP_ORIGIN=https://staging.colearnx.net
API_ORIGIN=https://api-staging.colearnx.net
```

保持已有的 `NODE_ENV`、Cookie、认证密钥、数据库等配置。Client ID 是公开标识，不是密钥，但仍集中在 API 配置，前端从 `/api/v1/auth/google/config` 读取。

保存变量时优先使用不立即发布的选项，让下面的受控 workflow 发布已验证的 SHA。若服务保存时自动重启，先确保迁移已完成，且没有覆盖当前发布版本。

**无需增加 GitHub OAuth Secrets；无需设置 Cloudflare `VITE_GOOGLE_CLIENT_ID`；无需重新把 Client ID 编译进前端。** Client ID 留空时，Google 入口隐藏，邮箱密码登录保持可用。首次仍需部署本 PR 的前端代码，才能有新按钮和 CSP。

### 第 4 步：运行原有部署 workflow

main 最新发布流程还要求实际云端迁移账本预检。先确认 GitHub `staging` Environment 已按 [STAGING_RELEASE_PREFLIGHT.md](STAGING_RELEASE_PREFLIGHT.md) 配置：

| 类型 | 名称 | 用途 |
|---|---|---|
| Secret | `STAGING_DATABASE_READONLY_URL` | 专用 `colearnx_release_reader` 的 Neon direct 只读连接 |
| Variable | `STAGING_DATABASE_HOST` | 核实过的 Neon staging direct 主机名 |
| Variable | `MEDIA_GATEWAY_DEPLOYED_SHA` | 实际已部署网关的完整源码 SHA |
| Variable | `VIDEO_WORKER_DEPLOYED_SHA` | 实际已部署转码服务的完整源码 SHA |

这些是现有部署预检要求，不是 Google OAuth 密钥。尚未配置时由数据库/部署负责人按上述文档建立专用最小权限 reader，不能用 owner 连接替代。工作流会核对全部迁移文件名、checksum、权限及发布前后账本一致性，仅勾选确认框不能绕过检查。

GitHub 仓库 → Actions → **Deploy staging** → Run workflow：

1. 分支选择 `main`。
2. 确认上面的云数据库迁移已完成后，勾选 `migrations_reviewed`。
3. `last_applied_migration` 填 `021_google_sign_in.sql`（如果目标版本有更新迁移，填该版本实际最新文件名）。
4. 本 PR 有 `db/` 变更，新发布计划会保守标记共享依赖组件需要人工审查。部署同学应确认迁移 021 仅新增 Google 认证表、现有网关和转码服务兼容，并核对实际部署基线；完成这项审查后才勾选 `external_components_reviewed`。如果从线上基线到目标版本还有其他媒体变更，应先单独部署/验收那些变更，不能只因为本功能没有改视频代码就直接勾选。
5. `force_web_release` 通常保持 false，本功能已有 API 和前端变更，会被计划识别。
6. 点击 Run workflow，等待 guard、validate、deploy 成功。

这条 workflow 会重跑 CI、读取实际迁移账本、按已部署基线计算组件变化。本功能涉及 API 和前端，正常会先发布目标 SHA 的 Render API，通过健康和 CORS 检查后，再发布已测试的 Cloudflare Pages 静态产物，最后复核账本。它**不会执行云数据库迁移或 seed，也不会替你发布网关和本机转码服务**。原有 Render/Cloudflare secrets、environment 审批机制沿用 [STAGING_CICD.md](STAGING_CICD.md)。

构建产物已经允许 Google 官方 SDK、frame、style 和连接路径，并允许登录弹窗通信。部署时不要用 Cloudflare 额外规则覆盖这些 CSP/COOP 响应头。

### 第 5 步：线上验收

先访问 `https://api-staging.colearnx.net/api/v1/auth/google/config`，确认 `data.enabled` 为 `true`、`clientId` 与 Google 控制台一致。

然后打开 `https://staging.colearnx.net/#/login`：

1. 切换 English / 简体中文，确认 Google 按钮和提示跟随切换。
2. 新 Gmail：点击 Google、选择账号、确认平台条款和年龄，成功进入账号；退出再登录，用户 ID 和钱包应保持一致。
3. 已注册并完成验证的 Gmail：先记录原个人资料、角色、积分及课程；用同邮箱 Google 登录，确认这些都保留。原邮箱密码登录也应继续有效。
4. 已启用 MFA 的测试账号：Google 返回后必须继续验证第二因素，不能直接进入平台。
5. 取消 Google 弹窗时，不应创建用户或改变已有表单内容。网络不可用时允许重试和原邮箱登录。
6. 在手机或窄屏下检查按钮可见且没有横向溢出。

必要时由有权限的部署人员查询自己的测试邮箱，确认一条用户记录及对应关联即可，不要把其他用户数据导出到 PR：

```sql
SELECT u.user_id, u.email, g.created_at AS google_linked_at
FROM users u
LEFT JOIN google_identities g ON g.user_id = u.user_id
WHERE lower(u.email::text) = lower('替换为自己的测试邮箱');
```

本地自动化验证使用替代 Google 证书/SDK 的测试夹具；**真实 Google 授权弹窗与线上域名配置必须在填入真实 Client ID 后人工完成上述验收**。

## 5. 直接发给部署同学的交接模板

```text
功能：CoLearnX Google 登录、同 Gmail 账号关联、首登自动创建 Member。
PR：填写本次 PR 链接
发布 SHA：填写合入 main 后的完整 SHA
前端：https://staging.colearnx.net
API：https://api-staging.colearnx.net
Google Cloud Project：填写项目 ID
Google Web Client ID：填写 .apps.googleusercontent.com 的 ID
Google Audience：填写 Testing / In production，注明测试账号是否可用
新增 API 环境变量：GOOGLE_CLIENT_ID
新增迁移：021_google_sign_in.sql
执行顺序：确认 CI → 用迁移连接执行 db:migrate → 配置 Render 变量 → 手动 Deploy staging → 真实 Google 验收
发布预检：确认 STAGING_DATABASE_READONLY_URL、STAGING_DATABASE_HOST 及两个媒体基线 SHA 已配置
共享迁移审查：确认媒体组件兼容后才勾选 external_components_reviewed
GitHub OAuth Secret / Client Secret / Redirect URI：均不需要
验收：中英文按钮、新 Gmail 自动建号、已有 Gmail 原 ID/积分/课程不变、原密码有效、MFA 生效
详细步骤：colearnx-v1.0/docs/GOOGLE_LOGIN_SETUP_ZH.md
```

## 6. 排障和回退

| 现象 | 检查 |
|---|---|
| 按钮不显示 | config 是否 `enabled: true`；是否部署了新前端；Client ID 是否保存到正确 Render 服务 |
| `origin_mismatch` / `invalid_client` | Web Client ID、Authorized JavaScript origins 与浏览器地址是否精确匹配；新配置可能需要等待生效 |
| `access_denied` | Google Audience、测试用户、组织管理员限制；用户主动取消也不会创建账号 |
| SDK 无法加载 | 网络是否能访问 Google；CSP 是否被额外覆盖；重试不会影响密码登录 |
| 弹窗空白或无法回传 | 浏览器弹窗限制；COOP 是否仍为 `same-origin-allow-popups`；是否使用了错误的 redirect 流程 |
| Cookie / nonce 过期提示 | 允许 Cookie 后点重试；10 分钟会话挑战过期；本地前端、APP_ORIGIN 使用一致的 localhost 来源 |
| Google 接口 500 / missing relation | 核对 migration 021、运行账号授权、后端实际 SHA；使用 requestId 查服务端日志，不复制凭证 |
| 外部邮箱 Google 账号提示用密码登录 | 安全策略所致：Google 对第三方邮箱不是当前权属证明；使用原邮箱密码 |

紧急停用时，在 Render 清空 `GOOGLE_CLIENT_ID` 并使配置生效，刷新登录页后 Google 按钮隐藏，已建立的平台会话不被主动撤销。保留迁移与账号关联数据，不要删除用户或钱包来“回退”。仅用 Google 新建的账号可通过“忘记密码”设置密码，但该恢复入口依赖原有邮件服务正常配置。
