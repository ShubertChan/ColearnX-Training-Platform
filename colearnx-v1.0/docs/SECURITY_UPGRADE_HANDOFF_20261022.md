# 2026-10-22 Node.js 安全升级交接

## 交接结论与范围

基于 `main` 的 `bc9bfe5fd3b000ad1a0335280d9a219b10658049`，修复分支为 `fix/node-security-20261022`。本次修改不包含数据库迁移。代码、测试与本机 Docker 验证完成不代表 Render、Pages 或部署同学的转码机已升级；线上状态必须按下方清单确认。

| 项目 | 本次变更 | 部署目标 |
| --- | --- | --- |
| Node.js | `.node-version` 从 22.22.2 升至 22.23.4；CI 同步读取该文件 | Render、CI、转码镜像统一 22.23.4 |
| npm 项目版本要求 | 五个 package.json 与锁文件声明 `^22.23.4 || ^24.22.1 || ^26.12.1` | 此次实际验证与推荐部署版本为 22.23.4；engines 声明不等于已升级 |
| API 请求体 | JSON、urlencoded、Stripe raw 解析器全部 `inflate: false` | 压缩请求体返回 415 / `UNSUPPORTED_CONTENT_ENCODING` |
| API 启动日志 | 输出实际 `process.version` | 以新实例启动日志证明运行版本 |
| 视频 Worker | 基础镜像固定 `node:22.23.4-bookworm-slim`，Build 操作增加 `--pull` | 重建镜像并替换旧容器 |
| 测试依赖 | Vitest 5.0.1 → 5.0.5，同步更新相关依赖锁定版本 | 使用 `npm ci` 安装 |
| Docker 验证 | 增加 `deploy/security-validation/Dockerfile` | 仅用于隔离测试，不能部署成线上服务 |

关闭的是**请求体**解压；浏览器接收 gzip/Brotli 压缩响应、HLS 视频播放不受这项开关影响。自定义客户端如果发送 gzip/br/deflate 请求体，需改成普通 JSON/表单，不能只删请求头而保留压缩后的内容。Stripe webhook 保留原始字节验签；新增测试同时验证正确签名与修改空白后的错误签名。

对应 Node.js 公告中的 Brotli RCE 为 CVE-2026-111497。关闭请求体解压仅减少入口，不能代替对 Node 内置 TLS、DNS、HTTP 客户端、Undici 等修复的运行时升级。

## 1. 发布前准备

1. 将修复分支提交并合并到当前 main，记录最终完整 SHA。若 main 已前进，先解决差异并重新通过 CI，不使用旧检查结果代表新提交。
2. 保留现有 GitHub staging Environment 审批、迁移账本只读检查、平台配置和组件基线检查。不要启用绕过这些检查的自动部署。
3. 记录当前 Render deploy ID、代码 SHA、实际 Node 版本；记录视频容器及镜像 ID。只记录版本信息，不导出环境变量或密钥。
4. 本次没有新增 migration。发布仍填写实际已批准的最后一个 migration 文件名，由现有只读预检确认；不要运行云端 migrate 或 seed。
5. CI 必须完成五组 npm audit、单元/组件/浏览器测试、类型检查、构建和本地 PostgreSQL 集成检查。`npm audit` 只检查 npm 依赖，不能证明 Node 运行时安全。

## 2. Render API：优先执行

在现有服务配置中核对：

- Repository：`ShubertChan/ColearnX-Training-Platform`，Branch：`main`。
- Root Directory：`colearnx-v1.0`，Runtime：原生 Node。
- 将 `NODE_VERSION` 设置为 `22.23.4`，与 `.node-version` 一致。环境变量优先级更高，旧值会覆盖代码文件。
- Build：`npm --prefix apps/api ci --include=dev && npm --prefix apps/api run build`。
- Start：`npm --prefix apps/api run start`。
- 保留数据库、OAuth、Stripe、R2、邮件等原有配置；无需轮换密钥或改变业务配置来完成本补丁。

按现有 `Deploy staging` 工作流发布最终 main SHA。`.node-version` 的变化会触发所有组件的检查，因此先完成第 3、4 节的独立组件核对，再如实填写 `external_components_reviewed`。网关没有业务代码变化不意味着可以伪造部署 SHA。

确认新实例启动日志出现 `Node v22.23.4`。若有 Render Shell，执行：

```sh
node -p 'JSON.stringify({node:process.version,openssl:process.versions.openssl})'
```

同时核对所有活跃实例均已替换。仅修改变量、通过构建或点击 Restart 都不能单独证明实例使用了新运行时。

## 3. 本地视频 Worker：重新构建，等待旧任务排空

从已经检出最终修复 SHA 的 `colearnx-v1.0` 目录，在转码机 PowerShell 执行：

```powershell
git rev-parse HEAD
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Stop
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Status
```

Stop 只发出优雅退出信号。等待状态确认为 stopped/exited，当前转码与上传完成后再继续；不要强杀正在处理课程的 Worker。然后：

```powershell
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Build
if ($LASTEXITCODE -ne 0) { throw 'Worker build failed' }
docker --context desktop-linux run --rm --network none colearnx-video-worker:local-batch node --version
```

输出必须为 `v22.23.4`。然后使用原有私有配置和工作目录启动：

```powershell
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Start
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Status
docker --context desktop-linux inspect colearnx-video-worker --format '{{.Image}}'
docker --context desktop-linux image inspect colearnx-video-worker:local-batch --format '{{.Id}}'
```

容器镜像 ID 与新镜像 ID 必须一致；若不一致，停止本次验收并检查 Compose 是否重建了旧容器。运行中的容器还可用 `docker exec colearnx-video-worker node --version` 核实。空闲 120 秒自动退出是原有批处理行为。`Start` 不会替换仍在运行的旧 Worker，不能省略排空步骤。

完成小视频上传、转码、播放和进度记录验收，记录镜像 ID 和实际来源 SHA 后更新 `VIDEO_WORKER_DEPLOYED_SHA`。

## 4. Pages、媒体网关与开发机

- Pages 是静态前端，按工作流发布已验证产物；不要在发布机临时重新安装依赖或重新构建。现有发布计划可能判定产物相同而保留已验证部署，这是允许的。
- 媒体网关运行在 Cloudflare Workers，不是自行维护的 Node 服务。本次修改其开发工具的 engines 元数据，没有修改网关业务代码；核对现有部署来源、权限和播放行为，记录真实 `MEDIA_GATEWAY_DEPLOYED_SHA`，按现有组件发布规则完成独立审核。不要直接用含 `REPLACE_WITH_*` 的模板配置发布。
- 开发机统一使用 Node 22.23.4；若其他项目需要 Node 24，至少升级至 24.22.1。本次测试使用独立下载并核对 SHA-256 的 Node 22.23.4，没有覆盖机器原有全局 Node 24.12.0。打开新终端用 `where.exe node` 和 `node -v` 检查 PATH。
- 仓库未发现 PHP 应用或 PHP 部署。本次没有安装 PHP。若另有 WordPress、phpMyAdmin 等，应单独升级到对应修复版 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12，或经供应商确认的回补版本。

## 5. 上线验收

以下只发送普通字符串，不包含漏洞利用数据。在 PowerShell 使用 `curl.exe`，避免别名差异：

```powershell
curl.exe -fsS https://api-staging.colearnx.net/health/live
curl.exe -fsS https://api-staging.colearnx.net/health/ready
curl.exe -i -X POST https://api-staging.colearnx.net/api/v1/reports -H 'Content-Type: application/json' --data-binary '{}'
curl.exe -i -X POST https://api-staging.colearnx.net/api/v1/reports -H 'Content-Type: application/json' -H 'Content-Encoding: br' --data-binary 'encoding-rejection-check'
curl.exe -i -X POST https://api-staging.colearnx.net/api/v1/reports -H 'Content-Type: application/x-www-form-urlencoded' -H 'Content-Encoding: gzip' --data-binary 'encoding-rejection-check'
curl.exe -i -X POST https://api-staging.colearnx.net/api/v1/payments/stripe/webhook -H 'Content-Type: application/json' -H 'Content-Encoding: br' --data-binary 'encoding-rejection-check'
```

预期：健康检查 200；普通匿名 reports 请求 401；三个带编码的请求 415，JSON 错误码 `UNSUPPORTED_CONTENT_ENCODING`。若返回 500、认证错误或代理生成的不同页面，需要核对新代码是否生效以及代理是否改变了请求。不要用上述无效压缩字符串去测试未打补丁的服务。

再完成以下业务验收并记录执行人和时间：

- 密码登录、Google 登录、刷新会话和退出。
- Stripe **测试模式**结账、有效 webhook、重复 webhook 不重复入账、退款通知。
- 课程附件上传与下载、视频转码与播放、权限和进度记录。
- 查看新实例 5xx、415、TLS 连接错误和 Worker 失败任务是否异常增加。

完成这些检查后，才能把“线上修复”标记为完成。

## 6. Docker 故障处理记录

本机 Docker Desktop 4.88.1 启动失败，日志报告 `sailor-ingest.sock` 无法删除，Windows error 1920；Linux 引擎命名管道不存在。通过独立 Windows 进程启动后，Docker Engine 29.7.2 正常可用。没有执行 Factory Reset、删除 socket 目录、注销 WSL、清理镜像/卷或迁移虚拟磁盘。

该现象与 MSIX 应用子进程的 AppData 虚拟化问题一致；通常从 Windows 开始菜单启动 Docker 即可避免。自动化需要启动时，可在 PowerShell 使用已验证的独立启动方式（只在 Docker 完全退出后使用）：

```powershell
$startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -ClientOnly
$startup.ShowWindow = 0
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"C:\Program Files\Docker\Docker\Docker Desktop.exe"'
  ProcessStartupInformation = $startup
}
# 启动需要时间；以下返回版本后再使用 Docker。
docker --context desktop-linux version --format '{{.Server.Version}}'
```

这解决了本次启动问题，不宣称永久修复 Docker/MSIX 产品缺陷。若正常开始菜单启动也失败，应重新读取具体日志，不能套用清空数据的方案。

## 7. Docker 测试复现

从仓库根目录运行；容器名称若已存在，先核对归属，不能删除他人的容器。以下密码仅用于临时本地测试，不是部署凭据。

```powershell
docker --context desktop-linux build --pull -t colearnx-security-validation:20261022 -f colearnx-v1.0/deploy/security-validation/Dockerfile colearnx-v1.0
docker --context desktop-linux run --rm --network none colearnx-security-validation:20261022 npm run api:test
docker --context desktop-linux run -d --name colearnx-security-pg-20261022 --label colearnx.purpose=security-test-20261022 -e POSTGRES_USER=release_owner -e POSTGRES_PASSWORD=security-local-fixture-only -e POSTGRES_DB=colearnx_release_check_linux postgres:16
docker --context desktop-linux exec colearnx-security-pg-20261022 pg_isready -U release_owner
docker --context desktop-linux run --rm --network container:colearnx-security-pg-20261022 -e RELEASE_CHECK_DATABASE_URL=postgresql://release_owner:security-local-fixture-only@127.0.0.1:5432/colearnx_release_check_linux colearnx-security-validation:20261022 npm run release:database-test
```

等待 pg_isready 成功后再运行集成检查。每次完整迁移集成测试需要**全新的临时 PostgreSQL 集群**，不只是新的数据库，因为测试还会创建专用集群角色。测试脚本会核验 localhost 和专用数据库名前缀，不能指向 Neon/staging。

完整集成检查成功后，可在该临时集群依次运行以下检查；队列检查放在最后，其数据库名前缀与前面检查的允许列表不同：

```powershell
docker --context desktop-linux exec colearnx-security-pg-20261022 createdb -U release_owner colearnx_release_check_upload_retry_security
docker --context desktop-linux run --rm --network container:colearnx-security-pg-20261022 -e RELEASE_CHECK_DATABASE_URL=postgresql://release_owner:security-local-fixture-only@127.0.0.1:5432/colearnx_release_check_upload_retry_security colearnx-security-validation:20261022 npm --prefix apps/api run test:integration:upload-retry
docker --context desktop-linux exec colearnx-security-pg-20261022 createdb -U release_owner colearnx_release_check_video_security
docker --context desktop-linux run --rm --network container:colearnx-security-pg-20261022 -e VIDEO_START_CHECK_DATABASE_URL=postgresql://release_owner:security-local-fixture-only@127.0.0.1:5432/colearnx_release_check_video_security -w /workspace/colearnx-v1.0/apps/api colearnx-security-validation:20261022 node --import tsx scripts/video-start-integration-check.mjs
docker --context desktop-linux exec colearnx-security-pg-20261022 createdb -U release_owner colearnx_queue_test_security
docker --context desktop-linux run --rm --network container:colearnx-security-pg-20261022 -e COLEARNX_QUEUE_TEST_URL=postgresql://release_owner:security-local-fixture-only@127.0.0.1:5432/colearnx_queue_test_security colearnx-security-validation:20261022 npm --prefix apps/video-worker test
```

每条命令失败均应停止并检查原因，不能把最后一条成功当作前面全部成功。完成后核对 `colearnx.purpose=security-test-20261022` 标签，只停止和移除自己创建的测试容器及其匿名测试卷。不要执行全局 `docker system prune`。

## 8. 验证结果

检查日期：2026-10-22（Asia/Singapore）。Node 22.23.4；Docker Engine 29.7.2；PostgreSQL 16。未连接云端业务数据或发送真实支付请求。

| 检查 | 结果 |
| --- | --- |
| 五份锁文件 npm audit（含开发依赖） | 全部 0 vulnerabilities；前端 npm 11.6.2 复核及 npm 10 常规审计均通过 |
| API 单元/HTTP 回归（Windows 与 Docker Linux） | 两个平台各 314 通过、1 跳过；含 12 项新增请求体/Stripe 签名测试 |
| API 类型检查与编译 | Windows 与 Docker Linux 均通过 |
| 前端 Node 单元测试 | 180 通过 |
| Vitest 组件测试 | 20 文件、95 测试通过，实际 Vitest 5.0.5 |
| Chromium 浏览器回归 | 79 通过；测试过程中前端构建通过 |
| 中文翻译目录 | 1437 条检查通过 |
| 部署脚本单元测试 | 131 通过 |
| 正式前端产物 | 已提交的干净源码执行 `release:build` 与 `release:verify` 通过，生成绑定提交 SHA 的 `dist/release.json` |
| 媒体网关 | 13 测试通过，类型检查通过 |
| 视频 Worker | 本机类型检查通过；Docker 中 18 测试通过，包括真实 PostgreSQL 队列子测试 |
| Docker PostgreSQL 全量发布集成 | 40 组通过，含真实迁移、Google 认证、退款、低权限账号和 TLS 验证 |
| Docker PostgreSQL 上传重试 | 12 组通过 |
| Docker PostgreSQL 定时视频 | 17 组通过 |
| 生产视频 Dockerfile | `--pull` 构建通过；实际 Node v22.23.4、OpenSSL 3.5.9、UID 1000 |
| 视频容器冒烟 | 断网、只读、cap-drop ALL 下 FFmpeg 合成视频编码通过；tsx 加载 Worker 模块通过 |

API 跳过的是需要独立 ClamAV 服务的 live EICAR 测试，本次未运行 ClamAV。浏览器只运行 Chromium，未运行 Firefox/WebKit。Node 24/26 的修复版本列入 engines，但本次没有对这两个大版本做兼容性验证。

过程中的环境问题已处理：Windows 数据库检查因缺少 openssl 命令中断后，转到安装了 OpenSSL 的 Linux 镜像，在全新临时集群完整通过。旧临时集群中已有专用角色会触发保护性拒绝，因此没有绕过检查或删除角色，而是改用新集群。npm 10 的一次前端锁文件审计遇到 registry 400/旧端点回退错误，npm 11.6.2 复核成功；这类端点错误不能当作 0 漏洞。

线上 Render/Pages/网关发布、真实业务联调和部署转码机升级仍待部署同学执行。测试视频镜像标签为 `colearnx-video-worker:security-20261022`，未覆盖现有 `local-batch` 标签或启动云端任务。

## 9. 回滚与完成记录

不能回滚到存在漏洞的 Node 版本或旧视频镜像。若发现业务回归，应在保留修复版运行时与解压防护的基础上回退无关业务变更，重新构建、测试并发布。不要单纯点选旧 Render 部署或启动旧容器来恢复服务；旧产物可能携带旧 Node。此前压缩请求客户端需要调整时，应修客户端或临时限制入口，不能为了恢复流量关闭这次防护且继续使用旧运行时。

| 验收项 | 由部署同学填写 |
| --- | --- |
| 最终 main SHA / CI run | 待填写 |
| Render deploy ID / 实际 Node / 全部实例替换 | 待填写 |
| Pages deployment ID / 前端实际 SHA | 待填写 |
| Worker 镜像 ID / 实际 Node / 来源 SHA | 待填写 |
| 网关实际 SHA / 独立审核 | 待填写 |
| 健康检查 / 401 / 三类 415 | 待填写 |
| Google / Stripe sandbox / 上传与视频验收 | 待填写 |
| 发布人 / 验收人 / 时间 | 待填写 |

## 官方依据与故障参考

- [Node.js 2026-10-21 安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Node.js 22.23.4 发布说明](https://nodejs.org/en/blog/release/v22.23.4/)
- [Render Node 版本配置优先级](https://render.com/docs/node-version)
- [Vitest mocker 修复公告](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)
- [PHP 2026-10-21 公告](https://www.php.net/archive/2026.php#2026-10-21-5)
- [Docker 启动与 MSIX AppData 问题记录](https://github.com/openai/codex/issues/52698)（问题报告，不等于官方保证）
