# Staging CI/CD 操作指南

更新：2026-09-20。适用于包含 `017_video_order_course_integrity.sql` 的代码版本。

采用 **自动检查 + 人工批准发布**：PR 和 main 更新自动测试、构建；负责人从 main 手动运行发布。API 和前端锁定同一个完整 Git SHA，Pages 上传该次 CI 已检查的产物，不在发布时重新构建。

本文是仓库代码和操作要求，不是“GitHub Actions 已启用成功”的证明。首次使用仍需合并代码、配置受保护 Environment 和部署令牌、实际运行工作流。现有 Render/Pages 自动部署是另一条触发路径，启用前必须关闭，防止绕过检查。

## 1. 文件、语言与实现

| 文件 | 职责 |
| --- | --- |
| 仓库根目录 `.github/workflows/ci.yml` | PR、main push、手动和可复用 CI；测试、临时 PostgreSQL 集成检查、构建并保存产物。 |
| 仓库根目录 `.github/workflows/deploy-staging.yml` | 仅手动发布；同一环境串行运行，先 API 后 Pages，失败停止后续发布。 |
| `.node-version` | Node.js 22.22.0。 |
| `deployment/staging.json` | 公开域名、项目、支付/视频开关和媒体/上传来源。 |
| `deployment/package*.json` | 发布 CLI 独立锁文件，Wrangler 固定 4.129.1。 |
| `scripts/deployment/source-guard.mjs` | 核对仓库、main、完整 SHA 和迁移确认；拒绝排队期间 main 已变化的旧发布。 |
| `scripts/deployment/artifact.mjs` | 干净源码构建；生成及校验 release.json、迁移清单和文件 SHA-256。 |
| `scripts/deployment/render-deploy.mjs` | 对现有服务发布指定 SHA；轮询 Live，拒绝竞争部署，支持只读复核。 |
| `scripts/deployment/pages-preflight.mjs` | 只读核对目标、域名、自动部署设置；检查原部署是否被别人替换。 |
| `scripts/deployment/pages-deploy.mjs` | 用已安装且锁定版本的 Wrangler 上传已验证 dist。 |
| `scripts/deployment/smoke.mjs` | 检查健康、CORS、匿名权限、线上版本及每个静态文件实际哈希。 |
| `scripts/deployment/release-summary.mjs` | 输出脱敏结果和恢复参考标识。 |
| `apps/api/scripts/release-integration-check.mjs` | 临时 PostgreSQL 内测试迁移、历史数据、权限及认证链路。 |
| `apps/api/scripts/video-order-integrity-checks.mjs` | 回滚事务内测试跨课程约束及已购买视频版本不可改写。 |

除已注明的仓库根目录文件外，路径均相对 `colearnx-v1.0/`。

工作流用 YAML 编排。发布脚本使用 Node.js JavaScript ES Modules（`.mjs`），主要依赖内置 fs、path、crypto、child_process、fetch 和 AbortController；不是另一套 Express 后端。Cloudflare 发布使用 Wrangler CLI，Render 发布使用 HTTPS API。

## 2. 安全边界

- CI 只连接 runner 内临时 PostgreSQL 16，凭据是合成测试值，不连接 Neon。
- CI 会在临时测试库执行 migration；发布工作流不会执行云端 migration、seed、R2 清理或自动回滚。
- 不创建 Cron、数据库、域名、Worker 或转码服务器，不购买或升级资源。
- 安装、测试、构建步骤没有云平台 Secrets；GitHub 内置只读 token 不等于业务密钥。
- 依赖先安装，之后才向必要步骤提供平台令牌。
- 不提交真实 .env、数据库连接串、JWT/MFA/CSRF、Stripe、Resend 或 R2 密钥。
- 产物限定静态类型，拒绝 .env、source map、压缩包、服务端 Worker、符号链接及常见密钥格式。这不是完整秘密扫描器，仍需代码审查。

## 3. 一次性平台配置

### GitHub

Settings → Environments 创建 `staging`，限制部署分支为 main。若套餐支持，设置 Required reviewers 和禁止自我审批。私有仓库及不同套餐的保护能力可能不同，不应删除保护来绕过限制。[GitHub 环境配置文档](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Environment Secret | `RENDER_API_KEY` | 部署现有 Render API。 |
| Environment Secret | `CLOUDFLARE_API_TOKEN` | 指定账户的 Pages 编辑权限，无需 R2 对象读写。 |
| Environment Variable | `RENDER_SERVICE_ID` | `srv-daa333p42hec739cv710` |
| Environment Variable | `CLOUDFLARE_ACCOUNT_ID` | `f457ddb114ddef000e8d0c4cc4aa5a97` |

令牌只在安全页面配置，不发到聊天、PR、日志或截图。创建令牌属于新增访问权限，需要账户负责人确认；缺少配置应失败，不继续发布。[Cloudflare Direct Upload CI 文档](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)

### Render

| 设置 | 必须满足 |
| --- | --- |
| Repository / Branch | ShubertChan/ColearnX-Training-Platform / main |
| Runtime / Root | 原生 Node / colearnx-v1.0 |
| Node | 22.22.0；核对 NODE_VERSION 是否覆盖文件。 |
| Build | `npm --prefix apps/api ci --include=dev && npm --prefix apps/api run build` |
| Start | `npm --prefix apps/api run start`，也接受等效 `npm --prefix apps/api start` |
| Pre-deploy | 空，不隐式 migration 或 seed。 |
| Health Check | /health/ready |
| Auto Deploy | Off |

预检只读，不替用户修改配置。API 继续使用 Render 原有 Secrets：低权限 colearnx_app 的 DATABASE_URL、认证、R2、邮件和 Stripe test 配置。Owner 迁移连接不放入长期运行的 API。

公开配置核对：`NODE_ENV=staging`、`APP_ORIGIN=https://staging.colearnx.net`、`API_ORIGIN=https://api-staging.colearnx.net`、`DATABASE_SSL=true`、`DB_POOL_MAX=5`、`TRUST_PROXY=1`。本轮保留 `ENABLE_HOSTED_VIDEO=false`。

发布使用 Render API 的 commitId，不使用只取分支最新状态的 Hook。创建部署请求只发一次；超时等结果不明时先查平台，不自动重发可能重复创建部署的 POST。[Render 指定提交部署文档](https://api-docs.render.com/reference/create-deploy)

### Pages 与构建配置

现有项目 colearnx-staging，生产分支 main，自定义域名 staging.colearnx.net。这里的 Production 是 staging 项目的主地址，不是切换到正式生产环境。

使用 Direct Upload，GitHub 构建后上传 dist。控制台构建变量不会改写已上传 JavaScript。Git 集成须未启用或明确关闭自动部署；也应停止会覆盖同项目的其他自动上传来源。

`deployment/staging.json`：

```json
{
  "appOrigin": "https://staging.colearnx.net",
  "apiOrigin": "https://api-staging.colearnx.net",
  "apiBaseUrl": "https://api-staging.colearnx.net/api/v1",
  "pagesProject": "colearnx-staging",
  "pagesBranch": "main",
  "paymentsEnabled": true,
  "paymentProvider": "stripe",
  "hostedVideoEnabled": false,
  "mediaOrigins": [],
  "uploadOrigins": []
}
```

支付沿用现有 sandbox 配置，开关本身不能证明 Stripe 使用 test key，密钥模式需在平台核对。视频启用前必须配齐独立转码进程、私有 HLS 存储、网关、权限及 CORS/CSP 来源，不能仅改布尔值。

## 4. 云端迁移的独立检查

比较仓库 SQL 与云端 schema_migrations 的 filename、checksum、applied_at。/health/ready 的 SELECT 1 只证明连接可用，不能证明结构与代码匹配。

有待执行迁移时，审查 SQL 与旧、新 API 兼容性，准备恢复点，再用受控环境的 Neon Owner direct/unpooled 连接执行。不要导入本地数据库、重建云端库、改已执行 SQL 的 checksum 或顺手 seed。并非所有迁移只新增结构，例如历史脱敏迁移会修改数据。

手动发布必须同时填写：

```text
migrations_reviewed = true
last_applied_migration = 017_video_order_course_integrity.sql
```

将来出现 018 时填写当时仓库最后的文件名。该输入是人工确认，不是自动验证：工作流不持有 Neon 凭据，不查询云端 ledger，同名确认仍需人核对 checksum。

## 5. 发布执行顺序

1. PR / main push 自动执行 CI，人工审查代码和实际测试结果。
2. 核对云端迁移、平台目标和上一版恢复标识。
3. Actions → Deploy staging → Run workflow，选择 main，填写迁移确认和文件名。
4. guard 检查仓库、分支、HEAD 和远端 main；复用 CI 检查同一提交。
5. 生成 pages-SHA-run_id-run_attempt 构建产物，保留 7 天。
6. staging Environment 审批通过后下载本次产物，校验 SHA、配置、迁移清单及文件哈希。
7. 再查远端 main，拒绝排队期间过时的发布；预检 Pages，再部署 Render 指定 SHA。
8. API Live 后执行 API smoke；失败不继续 Pages。再次只读复核 Render SHA。
9. 核对 Pages 主部署 ID 与预检一致；ID 缺失或被替换都中止。
10. 上传原产物；检查线上 release.json 与全部公共静态文件哈希，最终再核对 Render SHA。
11. 保存脱敏发布证据 14 天，再进行必要的带账号业务验收。

固定 concurrency group 与 cancel-in-progress=false 防止工作流互相中断，但不能阻止管理员控制台发布，也不能完全消除检查之后的竞争窗口。团队仍需协调发布窗口。

可复用 CI 通过同仓库相对路径引用，避免测试流程引用另一个浮动分支。[GitHub 可复用工作流文档](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)

## 6. 本地验证

在 colearnx-v1.0 目录使用 Node 22.22.0：

```powershell
npm ci --include=dev
npm --prefix apps/api ci --include=dev
npm --prefix apps/video-worker ci --include=dev
npm --prefix apps/media-gateway ci --include=dev
npm --prefix deployment ci --ignore-scripts
npm test
npm run test:components
npm run api:test
npm run api:typecheck
npm run release:test
npm --prefix apps/video-worker run typecheck
npm --prefix apps/media-gateway run typecheck
npm run api:build
```

数据库测试另需隔离本地 PostgreSQL 16 与 RELEASE_CHECK_DATABASE_URL，数据库名须以 colearnx_release_check_ 开头。不要填 Neon/业务库连接，测试会修改测试库结构及合成数据。

浏览器回归使用本地 fixture：

```powershell
npm exec -- playwright install chromium
npm run test:e2e -- --project=chromium
```

发布构建前先审查并提交代码，要求 Git 工作区干净；测试输出目录已 ignore：

```powershell
$env:RELEASE_SHA = (git rev-parse HEAD).Trim()
npm run release:build
npm run release:verify
```

build/verify 不发布云端。构建脚本清理继承的 VITE 变量并显式设置受审配置；构建机仍不应保留未经审查的忽略文件或环境配置。清单包含完整提交、公开开关、规范化换行的 SQL checksum 和各文件 SHA-256。

release:smoke -- --api-only 是公开 API 只读检查。完整 release:smoke 比较线上版本与本地 dist，未部署版本失败是预期现象。render-deploy.mjs 无参数为真实发布命令，只有 --verify-only 才是只读复核。

## 7. 覆盖范围与本轮实测

2026-09-20，本地 Node 22.22.0 / PostgreSQL 16：

| 检查 | 结果 |
| --- | --- |
| 部署脚本模拟网络测试 | 80/80 |
| 前端 Node 单元测试 | 144/144 |
| 前端组件测试 | 32/32 |
| API 单元测试 | 176/176 |
| 隔离数据库集成检查 | 25 组通过，覆盖 001–017、历史数据、权限、认证/MFA 和订单视频约束 |
| API 类型检查、API/前端构建 | 通过 |
| 视频 Worker / 网关类型检查 | 通过，不代表已部署或视频链路可用 |
| actionlint 1.7.12 | 通过，未启用 shellcheck / pyflakes |
| 公开线上 smoke | f1edca3 通过，包含 API/CORS/匿名权限及前端 6 个文件哈希 |

Playwright Chromium 步骤已加入工作流，本轮未实际执行该套浏览器自动化用例，不得把配置存在写成测试通过。网站登录入口已做浏览器只读检查；本轮未重做真实支付、邮件、R2 上传或管理员验证器绑定。

本轮生产依赖 audit：前端 0 项；API qs 传递依赖 1 项 moderate，high/critical 均为 0。CI 以 high 为阻断阈值，不表示 moderate 没风险；本轮不自动 audit fix。大于 500 kB 的前端 chunk 提示仍需后续评估。

本地通过不等于 GitHub runner、Environment 审批和真实令牌链路已成功；首次云端 Actions 运行仍需验收。Actions、产物存储及已有云服务按额度计费，不保证无限免费。

## 8. 失败与恢复

Render 与 Pages 不是原子发布。API 更新后 Pages 失败，可能出现混合版本；先核对两端状态、SHA、失败阶段及上一版标识，不盲目重发。

不自动回滚代码或数据库。优先修复并通过新 PR 发布；确需恢复先确认旧代码兼容当前 schema，再恢复兼容的前后端组合。数据库修复采用受审 forward migration 或独立恢复计划，不删新列/迁移记录、不改 checksum、不 seed。

Neon 恢复分支不是独立导出的长期备份，也不等于已完成恢复演练；保留和计费需另行管理。
