# 本机按需转码：代码与操作说明

更新日期：2026-09-24。源码基线：`d86a38e`；代码准备后，已按用户确认完成云端专用账号、队列、密钥和 Render 配置。未合并其他分支、未推送 GitHub，也未发布本轮 API 源码修改。

## 1. 这次解决什么

原实现把本机转码 Worker 当作常驻服务：没有视频时仍轮询 pg-boss，定期清理也查询 Neon。API 虽然设置了 `supervise: false`，pg-boss 12.33.2 的队列缓存刷新仍会持续运行。因此，仅把视频转码放在本机，并不代表数据库不会持续消耗云端计算额度。

另外，原停止流程直接执行 `queue.stop()`，其默认等待时间为 30 秒；原 Docker 停止宽限期为 60 秒。长视频可能尚在转码/上传，进程就被关闭。

本轮改为可选择的批处理模式：手动启动，处理已有任务，队列空闲后退出。不新增 Redis、第二套数据库、收费任务调度器或云端转码主机。

## 2. 修改逻辑

### 本机 Worker

- 新增 `VIDEO_WORKER_IDLE_EXIT_SECONDS`。直接运行代码时不设置或设置 `0` 仍为常驻模式，兼容其他部署；本机 Compose 明确设置为 `120` 秒。
- 允许 `0` 或 `30..86400` 的整数，拒绝空值、负数、小数和错误单位。
- 用单调时钟计算空闲时间。长时间转码、下载、上传、写入状态的整个回调都算进行中的任务，不以“最后一次取任务”的时间直接结束它。
- 空闲到期后查询真实队列，而非有缓存的队列统计。`created`、`retry`、`active` 都属于未完成任务，包括延迟重试和等待恢复的失联任务。
- 查询失败不等于空队列：保留服务并输出不含连接串的诊断信息，需处理故障或请求停止。
- 检查期间有任务开始/结束，会作废这次空闲判断，防止并发条件下提前退出。
- 定期删除扫描不重置视频空闲时间，避免配置较长空闲期时永远无法退出；已开始的扫描仍必须完成后才能关闭数据库。
- 正常空闲退出和 `SIGINT`/`SIGTERM` 走同一流程：停止接新任务 → 等当前任务及 pg-boss 确认完成 → 等删除扫描 → 停队列定时器并关闭连接 → 关闭业务连接和 R2 客户端。
- 重复停止信号复用同一停止流程。排空期间保留任务心跳，防止长视频被误判为失联。
- 关闭不需要的 pg-boss 日程调度、LISTEN/NOTIFY 和索引重建；保留运行期间的任务租约/重试管理，不授予运行账号 DDL 权限。

正常自动退出后，新到达的任务仍持久保存在数据库，等待下次启动；自动退出与新任务入队之间没有全局锁，也不承诺停止之后的任务立即开始。

### Render API 生产者

- 每次入队创建短生命周期 pg-boss 客户端，提交后在 `finally` 中关闭。
- 不启用迁移、建表、监督调度或 LISTEN/NOTIFY；不需要 Owner 账号。
- 并发入队使用独立客户端，避免旧实现的共享启动标记竞争，或一个请求提前关闭另一请求的连接。
- 保留原队列名、视频版本单例键、5 次重试、30 秒重试延迟、6 小时任务上限。
- 启动或入队失败返回不含私密信息的 `503 VIDEO_QUEUE_UNAVAILABLE`，失败的启动也执行关闭。
- 若任务已经成功提交但关闭连接失败，记录错误，不把已提交任务谎报为未提交；此异常需要运维处理。
- API 关闭时等待已开始的入队请求结束。

短生命周期客户端比复用连接多一些连接建立开销，适合当前低频视频上传；不改变普通注册、登录或购买请求的数据库连接方式。

### Docker 与 PowerShell

- `deploy/local-video/compose.yaml` 是版本化配置，原 D 盘入口只引用它，避免两份配置逐渐不一致。
- 镜像使用新标签 `colearnx-video-worker:local-batch`，保留原镜像用于对比，不自动替换正在运行的容器。
- `restart: "no"`：空闲退出或故障后不自动重启，防止停了又继续查询数据库。
- 直接用 `node --import tsx` 运行进程，配合容器 `init: true` 接收信号，不隔着 npm 包装进程。
- 停止脚本只发送 `SIGTERM`，不会用短时限强杀；操作返回只代表“已请求排空”，不是“已停止”。必须检查状态后才能关机。
- 单个任务并发、4 CPU、6 GiB 内存、只读根文件系统、非 root 用户、日志 3 × 10 MB。
- 文件、缓存与测试工作目录限定在 D 盘；沿用已配置在 D 盘的 Docker 数据目录。Windows/Docker 自身少量系统元数据仍可能在 C 盘。

## 3. 代码文件

| 文件 | 用途 |
| --- | --- |
| `apps/video-worker/src/lifecycle.ts` | 空闲判断、并发保护、安全排空 |
| `apps/video-worker/src/worker.ts` | 把真实转码/清理/队列接到生命周期 |
| `apps/video-worker/test/lifecycle.test.ts` | 可控时钟与并发单元测试 |
| `apps/video-worker/test/queue.integration.test.ts` | 真实 PostgreSQL/pg-boss 集成验证 |
| `apps/video-worker/.env.example` | 无密钥配置模板 |
| `apps/video-worker/Dockerfile` | 可复现安装与直接 Node 入口 |
| `apps/api/src/video/queue-producer.ts` | 短生命周期入队客户端 |
| `apps/api/src/video/queue-producer.test.ts` | 并发、失败、清理与幂等参数测试 |
| `apps/api/src/video/queue.ts` | 真实 API 配置接线 |
| `apps/api/src/server.ts` | API 停机时等待入队结束 |
| `deploy/local-video/Manage-VideoWorker.ps1` | 构建、启动、排空、状态检查 |
| `deploy/local-video/Test-QueueLifecycle.ps1` | 创建并清理隔离测试数据库容器 |

语言/库：业务代码 TypeScript，运行时 Node.js，任务队列 pg-boss 12.33.2 + PostgreSQL，转码 FFmpeg；部署配置 YAML，Windows 操作脚本 PowerShell。测试用 Node.js 内置 `node:test` + `tsx`，不引入新业务依赖。

## 4. 后续运行方式

本机真实配置已保存到 D 盘受保护的 `config/private/worker.env`，不要复制到 GitHub 或聊天。其他环境需另外创建受限凭据，不应复用或提交该文件。

```powershell
# 在 colearnx-v1.0 目录执行；构建本身不读取云端密钥。
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Build

# 专用配置就绪后才执行。没有待处理任务时约两分钟后正常退出。
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Start
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Status

# 提前结束本次批次：先完成当前任务，剩余任务下次再处理。
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Stop
.\deploy\local-video\Manage-VideoWorker.ps1 -Action Status
```

现有 D 盘快捷入口：`Build-VideoWorker.ps1`、`Start-VideoWorker.ps1`、`Stop-VideoWorker.ps1`、`Get-VideoWorkerStatus.ps1`。

看到 `State=exited ExitCode=0` 才是正常停止；非零退出或 `OOMKilled=true` 必须排查。运行、排空期间不要让电脑休眠、关机或退出 Docker。断电、强杀、网络断开不能保证当前任务完成，后续依靠租约、重试与处理尝试 ID 恢复。

先上传视频、再启动本机批次最直接。服务不会通过网页自动唤醒已经停止的本机进程，也不创建 Windows 开机任务或定时检查。

## 5. 验证命令

```powershell
npm --prefix apps/video-worker test
npm --prefix apps/video-worker run typecheck
npm --prefix apps/api test
npm --prefix apps/api run typecheck
npm --prefix apps/api run build

# 需已构建 local-batch 镜像，并安装本机 API/Worker npm 依赖。
.\deploy\local-video\Test-QueueLifecycle.ps1
```

集成测试只接受本机回环地址和 `colearnx_queue_test_` 前缀的数据库；脚本使用 `--network none` 的临时 PostgreSQL 容器、无主机端口，测试容器共享它的网络。不会读取实际 `.env`、连接 Neon、读写 R2 或执行业务 seed；结束后只删除本次新建测试容器。

需要覆盖：API 入队后无残留连接/缓存刷新 SQL、并发入队、延迟重试仍算待处理、真实任务停止时等待确认、停止期间新任务保留到下批次、空队列自动退出后可重新运行。

### 本轮实际验证结果

- Worker 生命周期单元测试：13/13 通过。
- API 全量单元/路由测试：193/193 通过，含新增入队客户端测试 8 项。
- Worker 与 API 类型检查、API 生产构建：通过。
- PowerShell 脚本语法与 Docker Compose 配置语法检查：通过。
- `git diff --check`：通过（只有 Windows 换行符提示）。
- 2026-09-24 恢复验证：Docker Engine 29.5.2 已正常响应，之前的启动阻塞已解除；没有重置 Docker 或删除既有容器。
- 新镜像 `colearnx-video-worker:local-batch` 构建成功，运行时 Node.js 22.23.3、FFmpeg 5.1.9，容器运行用户为 `node`；旧 `:local` 镜像保留。
- 隔离 PostgreSQL/pg-boss 集成测试连续执行两次均通过：4 个场景，加父测试共计 5 项通过、0 失败、0 跳过。验证了并发生产者关闭连接与缓存计时器、延迟重试阻止空闲退出、停止时等待正在执行的任务及队列确认、停止期间新任务留待下一批次，以及空闲退出后再次入队。只清理了本轮临时测试容器。
- 新镜像的无网络离线转码通过：13 秒合成视频生成 `master.m3u8`、2 个 `.ts` 分片和 `thumbnail.jpg`，FFprobe 时长校验与 FFmpeg 完整解码检查通过。所有测试文件和日志在 D 盘。
- 集成测试日志：`D:\comp\colearnx-video-local\runtime\logs\queue-lifecycle-test-20260924.log`。离线转码结果：`D:\comp\colearnx-video-local\runtime\work\tmp\offline-smoke-YXyQp1\result.json`。
- 普通 `npm --prefix apps/video-worker test` 仍会跳过没有显式配置隔离数据库的集成测试；上述集成通过结果来自明确执行 `Test-QueueLifecycle.ps1`，不是把跳过视为通过。

上述隔离集成测试使用真实 PostgreSQL/pg-boss 和模拟任务回调；FFmpeg 在另一项离线测试中验证。这些测试没有连接 Neon/R2，也不等于完整 Worker 已在真实云端视频任务中验证。

### 随后完成的云端配置与连接验证

- Neon 已创建 `colearnx_video_worker`、pg-boss schema version 42 与 `course-video.transcode` 队列，保留已应用的 17 条业务迁移，不运行 seed，不更改用户或订单数据。账号无超级用户/DDL 权限，不能读取 `users`、`orders`；仅允许视频元数据操作和队列运行。
- R2 专用 Object Read & Write 令牌只覆盖源文件与 HLS 两个项目桶；私有桶不开放匿名访问。密钥在 D 盘，ACL 仅限 ROG、Administrators、SYSTEM，不进入 Git。
- `Test-CloudWorkerConfiguration.mjs` 的 10 项检查通过：实际客户端 TLS/证书验证、角色权限、队列、两个桶的对象读写/删除、网关授权阻断和签名匹配。报告在 `D:\comp\colearnx-video-local\artifacts\cloud-worker-configuration-test.json`。两轮成功测试的 4 个微小测试对象已按精确 key 删除并确认不存在，未动既有文件。
- 正式容器 `colearnx-video-worker` 成功连接真实云端队列，空闲 120 秒后自行退出，`ExitCode=0`、`OOMKilled=false`、`RestartPolicy=no`。检查时云端视频版本和待处理任务均为 0；没有处理真实云端视频。
- Render 已配置网关地址、共享播放签名密钥、`VIDEO_SOURCE_MAX_BYTES=104857600`、`VIDEO_PLAYBACK_TTL_SECONDS=300`、`VIDEO_HEARTBEAT_MAX_GAP_SECONDS=30`；保留 `ENABLE_HOSTED_VIDEO=false`。API 队列连接按代码回退使用已有 `colearnx_app` 的 `DATABASE_URL`，不放入 Worker/Owner 连接串。
- 配置部署 `dep-daqf4467bikc7389sgv0` 已 Live，日志中 `/health/ready` 为 200；源码仍为 `f1edca3`。选择的是 **Save and deploy**，沿用现有构建，不是重新构建新源码；行为参见 [Render 环境变量文档](https://render.com/docs/configure-environment-variables)。Pages 本轮未重新部署。

## 6. 云端接入进度与发布门槛

专用账号、任务队列、R2 密钥、本机配置、网关签名及 Render 配置已完成。以下工作仍未完成，不能将本轮配置等同于完整视频功能发布：

1. 审核、提交并部署本轮 API 入队客户端修改；只修改本机 Worker 不会消除旧 API 的队列缓存定时查询。当前未推送 GitHub。
2. 核对匹配的前端、CSP 精确网关来源与功能开关。目前开关保持关闭，源视频测试上限为 100 MiB。
3. 获准后在受控 staging 测试窗口启用所需开关，用小型合成视频验证上传→入队→转码→播放、失败重试、人工停止、重启、MFA 预览与旧订单版本绑定；不要拿正常用户的视频做破坏性测试。
4. 验证授权续期、观看证据与退款门槛，验收完成后才对外开放视频功能。无需重复初始化队列、重跑迁移或 seed。
5. 空闲后检查 Neon 计算用量。网站访问、健康检查、其他后台任务也会查询数据库；本轮只减少视频队列引入的不必要空闲查询，不保证整个数据库一定休眠或永久免费。没有升级套餐或创建收费调度任务。
