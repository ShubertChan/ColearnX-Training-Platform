# CoLearnX R2 + FFmpeg + HLS 在线视频需求文档

> 状态：V1 开发范围确认  
> 更新日期：2026-09-15  
> 代码基线：`colearnx-v1.0`，当前检出提交 `412bbfa`  
> 用途：团队分工、接口约定、开发范围与验收标准  
> 本文完整替代原 Cloudflare Stream 方案；文件名仅为保留现有文档入口

## 1. 功能目标与范围

在现有课程交付流程中增加自建录播视频能力：Trainer 将源视频直接上传到 Cloudflare R2，FFmpeg Worker 异步转为 HLS 并生成缩略图，Learner 购买后在站内播放。Express API 继续负责身份、订单、权限、播放授权、观看进度和退款判断，PostgreSQL 继续作为业务事实来源。

V1 固定范围：

- 每个 `course_run` 只有一个对外生效的主视频，但后台可保留多个不可变版本。
- 单视频最长 4 小时（14,400 秒），最终时长以 `ffprobe` 为准。
- 购买时绑定当时的视频版本；后续换片只影响未来订单。
- 在线视频不提供 source、HLS playlist 或 segment 的下载入口。
- 保留 React/Vite、Express/TypeScript、PostgreSQL、订单、积分、退款、角色权限和现有 R2 附件系统。
- V1 除 Cloudflare R2 外不新增任何必须付费的云服务；R2 即使当前用量落在免费额度内，也不得描述成永久免费。
- FFmpeg、hls.js、pg-boss 等采用开源免费软件，但“软件免费”不代表运行它的 CPU、内存、磁盘、电力和运维没有成本；V1 用本地/自有计算资源承担这些成本。
- 不使用 Cloudflare Stream、Mux 或其他按存储/播放量收费的视频 SaaS；不包含直播、DRM、多主视频、章节视频、字幕制作和视频编辑。
- Hovod、Superstreamer 仅作分层架构参考，不直接 fork。

## 2. 当前代码基线

以下为当前仓库的实际情况：

- `course_delivery_assets` 已保存 R2 课程附件及 MP4 元数据，浏览器用预签名 `PUT` 直传，API 用 `HeadObject` 验证。
- `CourseEditorPage.jsx` 由 Trainer 手填 `totalDurationSeconds`；通用上传器允许多个文件，MP4 上限为 100 MiB，不适合作为 4 小时视频的最终流程。
- `CourseVideoPlayer.jsx` 直接播放 R2 原 MP4 预签名 URL，尚无 HLS 生命周期和分片鉴权。
- `course_video_progress_sessions` 只保存 session 累计秒数，`course_access_progress` 再累加各 session；当前实现不能对跨 session、跨设备的相同观看区间去重。
- `order_items` 已冻结价格、退款政策、交付方式和买家说明，但没有冻结视频版本；delivery 当前读取课程下的 ready 视频。
- 现有 `recorded-media-10pct-no-download-v1` 和积分账本已覆盖 10% 判断、附件下载证据及全额积分冲正，应继续复用。

因此，本次保留附件交付路径，替换在线播放路径，并新增视频版本、转码任务及真实观看区间。

## 3. 新的视频架构

```text
Trainer
  ↓ Direct upload
Private Cloudflare R2（source）
  ↓ durable job
本地/自有电脑 Docker FFmpeg Worker
（ffprobe → HLS + Thumbnail → validate）
  ↓
Private Cloudflare R2（versioned output）
  ↓ 每个 manifest/segment 请求均鉴权
HLS Delivery Gateway
  ↓
hls.js / Video.js
  ↓
Learner

Player heartbeat → Express API → PostgreSQL watched intervals
                 → unique watched ratio → refund eligibility
```

边界约定：

- React 不接触 R2 密钥、对象 key 或 FFmpeg，只消费 API 契约。
- Express 不转发上传或播放字节；它负责上传授权、任务创建、购买鉴权、播放会话、heartbeat 和退款。
- FFmpeg Worker 是运行在本地或自有电脑 Docker 中的独立后台进程，通过现有 Neon PostgreSQL/pg-boss 领取持久化任务；V1 不购买 Render Background Worker 或其他转码云服务。
- R2 默认私有，生产环境不得使用公开 `r2.dev`。只预签 master playlist 不足以保护子 playlist 和 segment。
- HLS Gateway 使用 Cloudflare Workers Free Plan + R2 Binding，校验短时 token/cookie 后读取 R2；不购买 Workers Paid Plan。所有 HLS 对象请求必须鉴权，不能由 Express 代理视频流量。

## 4. 数据库调整

新增前向迁移，不修改已执行的 `001`–`013`。沿用 UUID、`timestamptz`、显式外键、CHECK、部分唯一索引和最小权限。

| 数据对象 | 调整 | 关键约束 |
| --- | --- | --- |
| `course_delivery_assets` | 保留附件；新增 `video_source` purpose，旧 `online_video` 仅作兼容/迁移 | source ready 仅表示原文件验证完成，不表示可播放 |
| `course_video_versions` | 新表：course run、source asset、version no、状态、权威时长/宽高、HLS bucket/master key/output prefix、thumbnail key、错误及时间戳 | 同一 course run 只能有一个 current + ready；不保存签名 URL |
| 转码队列 | 默认评估采用 `pg-boss`；`course_video_versions` 保存业务状态，仅在确有审计字段缺口时增加轻量 `video_transcode_jobs` 关联表 | 队列只能有一个 source of truth；禁止同时维护 pg-boss 和自研 claim/lease 队列 |
| `order_items` | 新增 `course_video_version_id`，FK `ON DELETE RESTRICT` | 新视频订单必须绑定购买时 ready/current 版本，之后不可改绑 |
| `course_video_progress_sessions` | 增加 video version、最后 sequence/position/heartbeat、服务端接收时间和会话状态 | 乱序、重放 heartbeat 不增加进度 |
| `course_video_watch_intervals` | 新表：order item、video version、区间起止秒、来源 session、确认时间 | 保存服务端接受的非重叠内容区间，支持合并和求和 |
| `course_access_progress` | 保留为 UI/退款聚合投影；watched seconds 改为毫秒精度 numeric | 可由 intervals 重算；`watch_percent` 仅展示 |

其他规则：

- 视频版本状态统一为 `upload_pending | queued | transcoding | ready | failed | superseded | delete_pending | deleted`；转码任务状态统一为 `queued | running | succeeded | retryable_failed | dead`。前后端不得另造同义状态。
- `course_runs.total_duration_seconds` 可保留为当前主视频的只读投影，但不再接受前端填写。
- HLS 分片不逐条入库；用包含 `course_video_version_id` 的不可变 R2 prefix 管理，新版本不得覆盖旧路径。
- 结账事务同时锁定课程和 current/ready 视频版本，写入订单 FK及退款快照中的权威时长。
- 上线前盘点现有 `asset_purpose='online_video'`：可确认的建立 version；不明确的保留兼容状态并人工处理，禁止自动把历史订单改绑到当前视频。
- 任何被 `order_items` 引用的视频版本都不能物理删除；历史订单、退款、积分和审计数据不得级联删除。

## 5. 后端职责与 API 约定

### 模块职责

- `storage`：保留附件能力；增加视频 source、multipart 和 R2 校验。
- `video`：视频版本、替换、状态、提交前校验及任务创建。
- `video-worker`：ffprobe、FFmpeg、上传产物、校验、重试和 staging 清理。
- `playback`：校验 buyer/order/enrolment/fulfilment/绑定版本，签发短时播放会话。
- `progress`：验证 heartbeat、合并区间、更新聚合投影。
- `refunds`：继续使用政策快照和积分账本，只读取后端观看及下载证据。

不要继续把上述逻辑全部堆入 `storage/course-delivery.ts`。

所有接口沿用当前认证、角色、统一错误结构和 `{ data, meta: { requestId } }`；创建类操作继续使用 `Idempotency-Key`。

| Method | Path | 责任 |
| --- | --- | --- |
| `GET` | `/courses/:courseRunId/video` | Trainer owner/Admin 查看版本和转码状态 |
| `POST` | `/courses/:courseRunId/video-upload-intents` | draft owner 创建单个 source 上传及视频版本 |
| `POST` | `/courses/:courseRunId/video-versions/:id/complete` | 验证 R2 对象后创建转码任务 |
| `POST` | `/courses/:courseRunId/video-versions/:id/retry` | 重试允许重试的失败任务 |
| `DELETE` | `/courses/:courseRunId/video-versions/:id` | 仅删除无订单引用且允许删除的草稿/失败版本，否则 409 |
| `GET` | `/order-items/:orderItemId/delivery` | 保留；返回附件、绑定视频、后端进度和播放器状态，不再返回原 MP4 URL |
| `POST` | `/order-items/:orderItemId/playback-sessions` | 返回 session、videoVersionId、manifestUrl、短时授权、expiresAt、权威时长和 resumeAt |
| `POST` | `/order-items/:orderItemId/progress` | 保留路径，body 改为 heartbeat，不接受客户端累计 watched seconds 作为事实 |

播放会话响应必须 `Cache-Control: private, no-store`。具体 token/cookie 传递方式由 playback 与 gateway 共同确定；前端不能拼接 R2 key，日志不得记录完整授权或预签名 URL。

发布与版本规则：

- online-video 课程只有在主视频 `ready` 后才能提交 Admin 审核。
- 上传完成不等于 ready；仅当 HLS 产物完整、校验成功且数据库事务完成后才可播放。
- 换片必须创建新版本。新版本 ready/current 后只服务未来订单，旧订单继续读取旧版本。
- 已退款/取消、无效 enrolment 或被禁用账户不得创建新播放会话。
- 删除使用 `delete_pending → R2 delete → deleted` 可重试流程；存在历史订单引用时禁止物理删除。

## 6. FFmpeg、HLS 与 R2 配合

1. API 生成受控的 version/source key，浏览器直传 R2；大文件使用 multipart，不复用当前 100 MiB 附件上限。
2. complete 后 API 校验 R2 metadata 并创建 durable job。
3. Worker 在隔离容器、有限临时磁盘和资源上限内处理不可信输入。先执行 `ffprobe`；损坏、无视频流、不支持或超过 14,400 秒直接失败。
4. FFmpeg 输出 H.264/AAC HLS master、一个或多个不高于原片的 rendition、segments 和 thumbnail。码率梯度由部署配置统一管理。
5. 先写版本 staging prefix；确认 playlist 引用、segments、时长和可解码性后，再发布到不可变正式 prefix 并把版本设为 ready。部分产物不能被播放器访问。
6. 重试覆盖同一 video version 且幂等；清理任务只处理数据库明确记录的 staging/orphan 候选。
7. Gateway 对每个 HLS 请求鉴权并配置精确 CORS。版本化 segments 可缓存，但不得存在绕过 gateway 的 R2 公开路径。

建议对象结构：

```text
course/.../attachments/...
video/{courseRunId}/{videoVersionId}/source/...
video/{courseRunId}/{videoVersionId}/staging/...
video/{courseRunId}/{videoVersionId}/hls/master.m3u8
video/{courseRunId}/{videoVersionId}/hls/...
video/{courseRunId}/{videoVersionId}/thumbnail/...
```

## 7. 观看进度与 10% 退款

### Heartbeat 与区间

- 连续播放时每 5–10 秒上报，并在 play、pause、seek/seeked、ended、页面隐藏和卸载前尽力补报。
- Heartbeat 只上报 session、单调 sequence、事件、当前位置、播放速率和客户端单调时间等观测值；不提交最终累计秒数、比例或退款资格。
- 服务端依据上一条已接受 heartbeat、两次服务端接收时间、位置变化、速率和 seek 状态判断连续播放。seek 只建立新基线，跳过区间不计入。
- 心跳断档、位置跳变、乱序、重放、超过真实经过时间或越界部分不计入；容差和最大 gap 由后端统一配置。
- 服务端写入可信 `[start, end)` 区间，并按 order item + video version 合并重叠/相邻区间。刷新、重试、重复观看、跨 session 或跨设备重看都不能重复增加 unique watched content。
- 浏览器事件不是密码学观看证明；V1 目标是服务端约束和一致证据，不宣称完全防作弊。

`POST /order-items/:orderItemId/progress` 的最小请求字段固定为：

```json
{
  "sessionId": "uuid",
  "sequence": 12,
  "event": "playing",
  "positionSeconds": 125.42,
  "playbackRate": 1,
  "clientMonotonicMs": 50321
}
```

`event` 只允许 `playing | pause | seeking | seeked | ended`。响应返回服务端确认的 `uniqueContentWatchedSeconds`、`durationSeconds` 和 `watchedRatio`；退款资格仍由退款 API结合附件下载证据最终判断。

```text
unique_content_watched_seconds = 服务端已接受观看区间的并集长度
watched_ratio = unique_content_watched_seconds / video_version.duration_seconds
```

### 退款规则

- `watched_ratio <= 0.10`：可申请退回该订单项的全部积分，不是只退 10%。
- `watched_ratio > 0.10`：不可退款；恰好 10% 可退，使用未四舍五入秒数比较。
- 不增加购买后 72 小时限制。绑定视频的订单使用录播媒体规则；无视频的 Local/Live 课程继续现有政策。
- 已下载课程中的受保护附件时，继续按现有规则判定不可退款。
- 创建退款申请时，后端在事务中锁定订单和证据，读取最新区间并冻结 eligibility snapshot；前端、Trainer、Admin 都不能覆盖自动资格。
- 批准后继续复用 `refunds/service.ts` 和 points ledger 全额冲正，并停止签发新播放会话；历史证据保留。

## 8. 角色流程

### Trainer

1. 创建 course run，选择 online video，不再手填时长。
2. 使用独立的单视频区域直传 R2，查看上传、排队、转码、ready/failed 状态。
3. ready 后提交现有 Admin 审核；附件仍走现有 `PrivateAssetUploader`。
4. 换片时上传新版本并重新审核；不得覆盖或直接删除历史购买者版本。

### Learner

1. 购买前看到“观看内容不超过 10%且未下载受保护附件，可申请全额积分退款”。
2. 结账绑定当时视频版本；delivery 返回绑定版本而非课程 current。
3. Player 创建短时会话并播放 HLS，heartbeat 自动同步，跨设备读取后端进度。
4. 退款页面只展示并提交 API 结论；退款批准后不能创建新播放会话。

### Admin

1. 审核时查看版本、权威时长、分辨率、thumbnail 和转码状态，只预览 ready 视频。
2. 查看失败/积压、孤儿对象和清理任务，可受控重试，不手改 watched seconds。
3. 退款审核显示购买视频版本、权威时长、unique watched seconds、比例、附件下载证据和 eligibility code。
4. 可下架 current 版本或课程，但不能物理删除历史订单引用的视频；操作进入现有审计日志。

## 9. 前端职责

- 新增单视频上传组件，与多附件 `PrivateAssetUploader` 分开；支持 multipart、取消/恢复、状态轮询和失败重试。
- 移除 Trainer 手填时长，显示服务端 ffprobe 时长和 4 小时校验结果。
- V1 默认用 `hls.js` 包装现有 `<video>`，原生 HLS 作兼容 fallback；若改用 Video.js，API、heartbeat 和权限契约不变，不能维护两套进度算法。
- Player 处理 loading、processing、expired、unauthorised、network error、授权续期、恢复位置及卸载清理。
- 只展示服务端确认的 unique watched seconds/ratio/refund status；本地采样不能直接改变退款 UI。
- Trainer、Learner、Admin 共用状态枚举和错误码；CSP/CORS 只允许正式 API/media 域名，监控脱敏 token 和 URL。

## 10. 团队职责与交付边界

### 10.1 前端职责

负责人：Frontend。

- Trainer：实现独立单视频上传器、multipart 恢复、转码状态、替换确认和 4 小时错误展示；附件上传器保持独立。
- Learner：接入选定的 HLS Player、播放授权续期、恢复位置、heartbeat 事件适配和错误恢复。
- Admin：实现视频审核预览、转码状态、退款观看/下载证据和运维状态展示。
- 维护前端 API adapter、共享状态/错误码类型、可访问性、移动端及跨浏览器行为。
- 交付组件测试和 E2E page objects。不得在浏览器计算最终退款资格，不得读取 R2 key/secret，也不得自行改变后端状态枚举。

前端开始联调前，Backend 必须提供 OpenAPI/JSON 示例、错误码和 mock；Frontend 不等待真实 FFmpeg 完成才开始页面开发。

### 10.2 后端职责

负责人：Backend，媒体处理部分由 Backend/Media 子负责人认领。

- Express：上传签名、course/video 状态 API、购买时版本绑定、播放会话、heartbeat、退款证据、角色权限、幂等和审计。
- Media Worker：ffprobe、FFmpeg 参数、HLS/thumbnail 产物、任务重试、超时、并发和 staging/orphan 清理。
- Gateway：验证每个 manifest/segment 请求的短时授权，不让 Express 代理视频流量。
- 保持现有 orders、points ledger、refunds、R2 attachments 和 publishing 流程兼容。
- 交付 API/Worker 单元及集成测试、稳定错误码、结构化日志和运维指标。

Backend 不负责页面退款判断或 UI 状态推断；Media Worker 不直接修改订单、积分或退款表。

### 10.3 数据库职责

负责人：Backend/DB。

- 编写新的 forward-only migration、运行账户 grants、CHECK/FK、必要索引和回滚/roll-forward 说明；不修改 `001`–`013`。
- 负责视频版本、订单绑定、播放 session、观看区间及聚合投影的数据一致性。
- 为所有新 FK 建索引；针对 current video、queued job、order/video intervals 等实际查询设计复合或部分索引，并用 `EXPLAIN ANALYZE` 验证，不盲目加索引。
- 定义 heartbeat 与退款并发时的锁顺序和事务边界，保证重复请求、跨 session 合并与退款快照一致。
- 提供历史 `online_video` 盘点、可重复 backfill、reconciliation 查询及迁移后校验。

若采用 `pg-boss`，由 DB 负责人审核其 schema、权限、清理周期和 Neon 连接方式；平台不得再实现第二套任务领取表。当前 API 的 Node 要求为 `>=22.0.0`，采用当前 pg-boss 前需把运行时基线核对到其要求的 Node 22.12+。

### 10.4 部署职责

负责人：Platform/DevOps，Backend/Media 配合。

- API 继续部署到现有 Render service；不得为视频功能新增单独付费的 API service。
- 构建本地/自有电脑使用的 FFmpeg Worker Docker image/Compose 运行方式；固定 Node 与 FFmpeg 版本并生成可追踪 artifact，不采购 Render Background Worker。
- HLS Gateway 部署到 Cloudflare Workers Free Plan，并通过 R2 Binding 读取 HLS；不得启用 Workers Paid Plan。
- 配置 R2 bucket/prefix、multipart CORS、media custom domain、Gateway binding、cache policy 和私有访问旁路检查。
- PostgreSQL 继续使用现有 Neon；pg-boss 使用同一 PostgreSQL，不增加 Redis、RabbitMQ 或其他队列服务。
- 前端继续使用 Cloudflare Pages；管理 secret、最小权限 R2 credentials、数据库连接、feature flag 和 staging/production 隔离。
- 配置本地 Worker 的 CPU/内存/临时磁盘/并发/超时、队列积压、断线恢复和优雅关停；数据库迁移必须先于使用新 schema 的进程。
- 建立 dashboard、告警、备份/恢复、任务重放、孤儿清理、部署回滚和 incident runbook。

Platform 不负责修改业务退款规则；生产 secret 不交给 Frontend 或测试日志。

### 10.5 测试职责

负责人：QA 维护总测试计划和发布门禁；Frontend、Backend、DB、Platform 分别维护自己层的自动化测试，不能把质量责任全部交给 QA。

- QA 建立需求—测试用例追踪表、测试数据、跨浏览器矩阵、staging E2E 和验收报告。
- Frontend 负责组件、播放器事件、上传恢复、错误状态、可访问性和浏览器兼容测试。
- Backend/DB 负责 API、权限、状态机、事务并发、区间合并、10% 边界、积分退款和 migration 集成测试。
- Media 负责真实 FFmpeg fixture、输出 manifest/segments、重试幂等、资源限制和损坏输入测试。
- Platform 负责部署 smoke test、Gateway 鉴权/CORS/cache、Worker 故障恢复、告警和 rollback 演练。

### 10.6 跨组接口

| 接口 | 提供方 | 消费方 | 合并前必须提供 |
| --- | --- | --- | --- |
| 视频状态/API/error code | Backend | Frontend、QA | schema、示例、contract test |
| Upload multipart contract | Backend storage | Frontend | create/sign/list/complete/abort 行为 |
| Transcode job payload/result | Backend | Media Worker | version ID、幂等键、状态迁移 |
| HLS output layout | Media Worker | Gateway、Player | master path、MIME、cache header |
| Playback auth | Backend/Gateway | Frontend | TTL、刷新、拒绝码、CORS 规则 |
| Heartbeat/进度响应 | Backend | Frontend、Refunds | request schema、去重和边界样例 |
| Migration/feature readiness | DB/Platform | 全组 | migration result、开关和回滚步骤 |

数据库字段、状态机、API schema 和 error code 是唯一共享契约；变更先更新契约和测试，不能用 UI 临时兼容掩盖差异。

## 11. V1 部署、运行与成本方案

### 11.1 成本硬边界

V1 是课程项目/MVP。**Cloudflare R2 是唯一允许产生新增云服务费用的组件。** 其他能力必须使用免费开源软件、本地/自有计算资源，或当前已经在使用的云服务额度；不得为了视频功能新增付费实例、付费队列或按播放量收费的 SaaS。

| 组件 | V1 方案 | 新增云服务费用口径 |
| --- | --- | --- |
| Video storage/delivery objects | Cloudflare R2 Standard | 唯一允许产生新增费用；包含 source、HLS、thumbnail、Class A/B operations。当前免费额度不是永久承诺，按官方价格监控 |
| FFmpeg transcode | 本地/自有电脑 Docker Worker | 不购买云 Worker；FFmpeg 软件免费，但电脑、电力、磁盘、网络和人工运维属于自有运行成本 |
| Job queue | 现有 Neon PostgreSQL + pg-boss | 不增加 Redis、RabbitMQ、Cloudflare Queues 或其他付费队列；必须控制在现有 Neon 方案内 |
| Express API | 现有 Render service | 只在现有服务增加 routes/modules，不新建单独收费的 API 或后台服务 |
| HLS Gateway | Cloudflare Workers Free Plan + R2 Binding | 不购买 Workers Paid Plan；达到免费限额视为 V1 容量上限，不能自动升级付费 |
| Frontend | 现有 Cloudflare Pages | 不新增视频播放器托管服务；hls.js 随前端 bundle 发布 |
| Player/media software | hls.js、FFmpeg 等开源项目 | 无 SaaS 播放费；仍需遵守 license 和第三方依赖安全要求 |
| Video SaaS | Cloudflare Stream、Mux 等 | V1 禁止使用 |

“开源软件免费”只表示不采购其商业 SaaS 或订阅授权，不表示运行成本为零。V1 通过自有电脑和现有 Render/Neon/Pages 资源消化计算需求，从架构上不依赖任何新增付费计算资源。

### 11.2 本地 FFmpeg Worker

- Worker 以 Docker/Compose 长期运行在开发者或团队自有电脑，不需要公网入站端口。
- Worker 通过 outbound TLS 连接现有 Neon PostgreSQL/pg-boss 和 R2：领取 job → 下载 source → 本地临时目录转码 → 上传 HLS/thumbnail → 更新数据库状态。
- 默认单任务并发，避免占满课程项目电脑；CPU、内存、临时磁盘和最大转码时长通过环境变量限制。
- 使用独立最小权限数据库账号和只允许目标 video prefixes 的 R2 credentials；secret 只存本地安全环境配置，不进入 Git。
- 电脑关机、断网或 Worker 停止时，任务保留在 pg-boss 中并显示 `queued/retryable_failed`；课程继续不可发布，恢复 Worker 后自动重试，不丢任务。
- Worker 启动时检查 FFmpeg/ffprobe 版本、数据库迁移版本、R2 连接和可用磁盘；退出时停止领取新任务并完成/释放当前 lease。
- Platform 提供一页运行手册：首次安装、启动/停止、升级 image、查看失败、释放卡住任务、清理 temp 和轮换 secret。

### 11.3 Workers Free Plan Gateway 设计

Gateway 必须适合 Workers Free Plan，而不是先按付费能力设计再依赖升级：

- 仅执行短时签名验证、path/version 权限匹配、R2 `get` 和 streaming response；每个 segment 请求不得访问 Neon、Render API、KV、D1 或 Durable Objects。
- Token 由现有 Express 签发，Gateway 使用本地密钥验证；不得为每个 segment 发起远程授权查询。
- HLS VOD segment 建议使用约 8–10 秒，减少每观看小时的 Worker 请求数；具体值通过播放体验测试确定。
- master/variant playlist 和不可变 segment 使用合理 cache headers，但必须认识到经 Worker 的每个入站 HLS 请求仍会占用 Workers request quota。
- 当前 Free Plan 官方限制为每日 100,000 个请求、每次请求 10 ms CPU；上线前按当时官方文档重新核对。容量估算须预留非播放请求，并用 `可用日请求数 ÷ 单观看小时请求数` 得到 V1 每日观看小时上限。
- 监控日请求量和 CPU 超限，在 70%/90% 告警。不得自动切换 Paid Plan；接近容量时限制测试用户/播放量并由团队决定后续阶段。
- Gateway 必须 fail closed。达到免费额度或 Gateway 故障时宁可停止播放，也不能 fail open 绕过鉴权直连公开 R2。
- 不启用公开 `r2.dev`；source prefix 永不由 Gateway 暴露。

### 11.4 现有服务复用

- Frontend 继续部署 Cloudflare Pages；只增加 hls.js 和视频 UI。
- API 继续部署当前 Render service；只增加上传签名、播放会话、heartbeat 和视频管理模块。
- PostgreSQL 继续使用当前 Neon；pg-boss 与视频表使用同一数据库。若 heartbeat/queue 将超过现有额度，先优化、限制 MVP 流量或降低测试规模，不能擅自购买新数据库/队列。
- R2 设置精确 upload/media CORS；API、本地 Worker 和 Gateway 分别使用最小权限 secret。
- 保留 `ENABLE_HOSTED_VIDEO` 总开关。关闭时不得影响附件、订单、积分、权限和退款。
- 使用现有或免费监控能力记录上传、转码队列、R2 错误、Gateway 4xx/5xx、heartbeat 和退款指标；V1 不把付费监控平台列为必需依赖。

### 11.5 未来生产扩展（不属于 V1）

正式生产用户量或上传量增长后，可以保持相同 pg-boss job contract，把本地 FFmpeg Worker 替换为付费云 Worker/容器，并按实际流量评估 Workers Paid Plan、数据库扩容和专业监控。该迁移是未来独立决策，不是 V1 的依赖、DoD 或隐藏成本；未获批准前不得预先采购。

## 12. 测试范围与发布门禁

当前仓库前后端均使用 Node test runner，Backend 已有 Supertest。保留现有快速测试；只为 DOM、真实 PostgreSQL、Gateway 和跨浏览器 E2E 增加专用工具。

| 层级 | 必测内容 | Owner | 执行时机 |
| --- | --- | --- | --- |
| Frontend unit/component | 上传状态、player 生命周期、heartbeat event adapter、token refresh、退款文案不自行判断 | Frontend | 每个 PR |
| Backend unit/API | 权限、幂等、状态机、版本绑定、heartbeat 校验、区间并集、附件证据、10%/10%+边界 | Backend | 每个 PR |
| PostgreSQL integration | 全量迁移、FK/CHECK/grants、backfill、并发 heartbeat/refund、查询计划 | DB/Backend | 每个 PR |
| Media integration | 正常/损坏/无视频流 fixture、ffprobe、HLS 引用完整性、thumbnail、retry/timeout/idempotency | Media | PR 快速集 + nightly 真实转码 |
| Gateway integration | 无 token、过期、跨订单/跨版本 token、CORS、cache、R2 公开旁路 | Backend/Platform | 每个 PR + staging |
| Browser E2E | Trainer 上传→Admin 发布→Learner 购买/播放/seek/重看→退款；Chromium、Firefox、WebKit | QA | staging/release |
| Regression/operations | 现有附件、订单、积分、权限、退款；kill worker、任务接管、回滚、孤儿清理和告警 | QA/Platform | release |

测试数据要求：

- 使用团队自有或程序生成的小视频 fixture，不提交有版权或真实用户视频。
- 固定包含：短视频、不同分辨率、损坏文件、无音轨、无视频流、边界时长 metadata，以及 seek/重复/跨 session heartbeat 序列。
- PR 测试不得依赖 production secret；真实 R2 与 FFmpeg 全链路放在隔离 staging。
- 任何退款边界、历史版本访问、R2 私有访问或积分回归失败都阻止上线，不能人工跳过。

## 13. 开发顺序

1. 冻结表关系、状态、heartbeat body、播放授权、API 和错误码。
2. 增加视频版本、任务、订单 FK、session 和 watched intervals，并盘点历史数据。
3. 完成本地/自有电脑 Docker Worker、source 直传/multipart、ffprobe、FFmpeg、HLS/thumbnail 和 pg-boss 任务重试。
4. 完成 ready 发布校验、Admin 审核及结账版本绑定。
5. 部署受保护 Gateway，接入 hls.js/Video.js，验证所有 manifest/segment 鉴权。
6. 完成 heartbeat、跨会话区间并集、10% 退款和附件下载证据闭环。
7. 完成 Admin 运维、监控、对账、孤儿清理和审计。
8. 通过大文件、4 小时边界、断网、换片、历史订单和退款 staging E2E 后灰度开启。

## 14. Definition of Done

- Trainer 可直传单个主视频到私有 R2；Express 不承载视频字节，大文件可可靠续传。
- Worker 幂等地产生可播放 HLS 和 thumbnail；损坏及超过 4 小时的视频被拒绝。
- FFmpeg Worker 可在本地/自有电脑 Docker 中长期运行，停机后任务不丢失，恢复后可继续处理；V1 不依赖付费云转码。
- 视频未 ready 时不能提交/发布；Admin 可安全预览权威媒体信息。
- 新订单绑定购买时视频版本；更换 current 后历史购买者仍播放原版本。
- 未购买、已退款/取消、无效 enrolment、过期会话无法访问受保护 HLS，R2 无公开旁路。
- seek 不计、重复观看不重复、请求重试不重复、跨 session/设备不重复。
- 后端按 unique watched/duration 判断：恰好 10% 可申请，超过 10% 拒绝，无新增 72 小时。
- 已下载附件时按现有规则拒绝；合格申请批准后退回全部订单项积分并停止新播放授权。
- 历史订单引用的视频不能直接删除；下架、失败重试、delete_pending 和孤儿清理可审计、可恢复。
- 数据库/API/Worker/组件测试和 staging E2E 通过；附件、订单、积分、权限及非视频退款无回归。
- migration、secret、CORS/CSP、feature flag、监控、告警和回滚步骤有运行记录；开发完成后同步 README、API、数据模型及部署文档。
- 成本验收通过：除可能产生费用的 R2 外，没有新增 Render service、Workers Paid、Redis/RabbitMQ、Cloudflare Stream、Mux 或其他必须付费的云服务。

## 15. 开源复用与实现参考

### 15.1 推荐直接采用或优先评估

| GitHub 项目 | 用途 | 本项目采用边界 |
| --- | --- | --- |
| [video-dev/hls.js](https://github.com/video-dev/hls.js) | 在 HTML `<video>` 上播放 HLS | V1 默认播放器引擎；CoLearnX 只实现业务 UI、授权刷新和 heartbeat，不自写 HLS parser |
| [videojs/video.js](https://github.com/videojs/video.js) | 完整播放器 UI/插件体系 | 仅当团队需要完整控件体系时替代 hls.js 方案；二选一，不同时维护两套 Player |
| [transloadit/uppy](https://github.com/transloadit/uppy) 的 `@uppy/aws-s3` | S3-compatible 直传、multipart、重试/恢复 | 优先 POC；由 Express 实现 signing endpoints，不引入 Companion，除非未来明确需要远程文件源 |
| [timgit/pg-boss](https://github.com/timgit/pg-boss) | Node + PostgreSQL 持久任务队列 | 默认队列候选，用于 retry/backoff/concurrency/dead-letter；采用后不再自研 claim/lease 队列 |
| [FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg) | ffprobe、转码、HLS muxing、thumbnail | 直接使用固定版本 CLI 和参数数组；不为简单调用自建转码器，也不引入无人维护的 wrapper |
| [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk) | Wrangler、Workers 测试和 Miniflare/workerd | 用于 HLS Gateway 开发、R2 binding 测试和部署，不自建 Worker runtime mock |
| [testing-library/react-testing-library](https://github.com/testing-library/react-testing-library) | React DOM 组件行为测试 | 补足播放器/上传器组件测试，侧重用户可见行为 |
| [microsoft/playwright](https://github.com/microsoft/playwright) | Chromium/Firefox/WebKit E2E | 用于 staging 的上传、播放、seek、授权到期和退款流程 |
| [testcontainers/testcontainers-node](https://github.com/testcontainers/testcontainers-node) | 真实 PostgreSQL/容器集成测试 | 验证 migration、约束、事务并发和 Worker；避免用内存数据库模拟 PostgreSQL |

### 15.2 只参考架构，不直接 fork

| GitHub 项目 | 可借鉴内容 | 不照搬内容 |
| --- | --- | --- |
| [superstreamerapp/superstreamer](https://github.com/superstreamerapp/superstreamer) | ingest→FFmpeg→多清晰度 HLS/CMAF→S3→hls.js 的模块边界、容器和播放抽象 | 广告、动态拼接、其 API/数据库和完整平台 |
| [Synapsr/Hovod](https://github.com/Synapsr/Hovod) | API/worker 分离、S3-compatible storage、转码状态、横向扩 worker 和管理界面 | MariaDB/Redis、AI/计费/评论等与 CoLearnX 重叠的业务系统 |

采用任何第三方项目前必须记录版本、license、维护活跃度、已知漏洞、bundle/image 大小和退出方案。不得直接复制未完成 license review 的代码；不得同时引入两个解决同一职责的框架。POC 通过后在 ADR 中记录“采用/不采用”及原因。

### 15.3 官方技术资料

- [FFmpeg HLS muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
- [Cloudflare Workers Free/Paid pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare R2 Workers Binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Cloudflare R2 public buckets/custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
