> **Status update (2026-09-03):** This is an earlier design handoff, not the deployment source of truth. The current implementation supports safe, sequential multiple files per content draft. Use [API.md](API.md) and [R2_UPLOAD_DEPLOY_CHECKLIST.md](R2_UPLOAD_DEPLOY_CHECKLIST.md) for the current contract, deployment steps, CORS requirements, and recovery procedure.

# CoLearnX R2 私有文件上传后端交接

## 1. 目标与当前现状

本交接用于完成 CoLearnX Content Editor 的真实私有文件上传和付费后受控下载。

当前架构为：

- React 前端部署在 Cloudflare Pages，当前 staging 地址为 `https://staging.colearnx.net`；
- Express/Node API 部署在 Render，当前 API origin 为 `https://api-staging.colearnx.net`；
- PostgreSQL 业务数据库部署在 Neon；
- Cloudflare R2 仅用于保存文件对象，不替代 Neon PostgreSQL；
- Render API 通过 R2 的 S3-compatible API 访问 R2，不能使用仅适用于 Cloudflare Workers 的 R2 Binding。

仓库当前尚未实现真实文件上传：

- `content_versions.storage_url` 只是 nullable `text` 占位字段；
- `course_delivery_options.asset_reference` 只是 nullable `text` 占位字段；
- `POST /content` 仍允许客户端提交任意 `storageUrl`；
- `submitContent` 尚未要求内容版本必须存在可用文件；
- 没有 presigned PUT、上传完成确认、受控下载、管理员预览或孤儿对象清理端点；
- 前端 `CreatorPlatformPages.jsx` 明确提示私有文件上传尚未配置；旧 `CreatorPages.jsx` 只记录文件名，不是真实上传。

## 2. 本轮范围

本轮仅实现 Creator Content 的单个主文件：

1. Creator 创建内容 draft；
2. Creator 请求短期 presigned PUT URL；
3. 浏览器直接把文件上传到私有 R2 bucket，不经过 Render 传输文件正文；
4. 浏览器通知 API 上传完成；
5. API 使用 `HeadObject` 校验 R2 对象后，将 asset 标记为 `ready`；
6. 只有关联了 `ready` asset 的内容版本才能提交管理员审核；
7. Admin 可获取短期预览地址；
8. 已购买用户可在权限校验后获取短期下载地址。

本轮不包含：

- 课程视频托管、转码、HLS 或观看进度；
- 多文件内容包；
- 公开封面图上传；
- 病毒扫描服务；
- “浏览器确实下载完全部字节”的可信回调。

R2 只是对象存储。若后续需要课程视频播放和可信观看进度，应单独采用 Cloudflare Stream 或完整的视频处理方案。

## 3. Cloudflare R2 基础设施要求

创建独立的私有 staging bucket，例如：

```text
colearnx-staging-assets
```

要求：

- 不开放 public access；
- 不配置公开自定义域名；
- R2 API Token 仅授予此 bucket 的 Object Read/Write 权限；
- staging 与 production 使用不同 bucket 和凭据；
- 保留/配置未完成 multipart upload 的终止规则；数据库中的过期 pending、orphaned 和 `delete_pending` 记录仍由应用维护任务对账清理；
- CORS 仅允许正式 staging 前端来源，例如 `https://staging.colearnx.net`；
- CORS 方法仅开放 `PUT`、`GET`、`HEAD`，允许 `Content-Type`，暴露 `ETag`；
- 不要把 R2 Token、Access Key、Secret、signed URL 放进 GitHub、聊天、截图或前端环境变量。

## 4. 后端依赖和环境变量

在 `apps/api` 增加依赖：

```text
@aws-sdk/client-s3
@aws-sdk/s3-request-presigner
```

建议环境变量如下：

```env
OBJECT_STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=<Cloudflare account id>
R2_ACCESS_KEY_ID=<bucket-scoped access key id>
R2_SECRET_ACCESS_KEY=<bucket-scoped secret access key>
R2_BUCKET_NAME=colearnx-staging-assets
R2_REGION=auto
R2_SIGNED_UPLOAD_TTL_SECONDS=600
R2_SIGNED_DOWNLOAD_TTL_SECONDS=300
CONTENT_UPLOAD_MAX_BYTES=26214400
CONTENT_VIDEO_UPLOAD_MAX_BYTES=104857600
CONTENT_STORAGE_QUOTA_BYTES=524288000
CONTENT_PENDING_UPLOAD_LIMIT=3
```

可从 `R2_ACCOUNT_ID` 派生 endpoint：

```text
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

本地开发默认 `OBJECT_STORAGE_PROVIDER=disabled`。当 provider 为 `r2` 时，配置校验必须要求所有 R2 凭据存在；日志和配置错误不得打印真实值。

S3 client 的关键配置：

```ts
new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});
```

建议把 R2 访问封装在独立模块，例如 `src/storage/r2.ts`。路由层不能直接持有凭据或拼接 endpoint。

## 5. 数据库 migration

新增 forward-only migration。当前已有 `004_email_verification.sql`，因此建议文件名：

```text
db/migrations/005_object_storage.sql
```

不要修改已经执行过的 `001`–`004` migration。

建议新增 `storage_assets`：

| 字段 | 建议类型与约束 | 说明 |
| --- | --- | --- |
| `storage_asset_id` | `uuid primary key default gen_random_uuid()` | 对外使用的 asset ID |
| `content_version_id` | `uuid not null references content_versions` | 此上传尝试所属内容版本；pending 阶段也可追溯 |
| `owner_user_id` | `uuid not null references users` | 上传所有者 |
| `storage_provider` | `text not null check (storage_provider = 'r2')` | 存储提供方 |
| `asset_purpose` | `text not null check (asset_purpose = 'content_primary')` | 本轮固定为内容主文件 |
| `bucket_name` | `text not null` | bucket 名称；API 响应不返回 |
| `object_key` | `text not null`，与 bucket 组成唯一键 | 服务端生成；API 响应不单独返回 |
| `original_filename` | `text not null` | 原始文件名，仅作展示和下载文件名 |
| `declared_content_type` | `text not null` | 初始化时声明并经 allowlist 校验的 MIME |
| `verified_content_type` | `text` nullable | complete 时从 R2 `HeadObject` 读取并复核 |
| `declared_byte_size` | `bigint not null check (> 0)` | 客户端声明大小 |
| `verified_byte_size` | `bigint` nullable | complete 时由 `HeadObject` 复核的大小 |
| `etag` | `text` nullable | `HeadObject` 返回值；不能当成可靠 SHA-256 |
| `checksum_sha256` | `char(64)` nullable | 若实现额外校验才写入；本轮不能宣称仅凭客户端值已验证 |
| `asset_status` | `text` | `pending`、`uploaded`、`ready`、`quarantined`、`orphaned`、`delete_pending`、`deleted` |
| `upload_expires_at` | `timestamptz not null` | 上传意图过期时间 |
| `created_at` / `updated_at` | `timestamptz` | 创建与更新时间 |
| `uploaded_at` / `verified_at` / `deleted_at` | `timestamptz` nullable | 生命周期审计时间 |

本轮单文件在 `content_versions` 新增 nullable `storage_asset_id`，并使用 `(storage_asset_id, content_version_id)` 复合外键指向 `storage_assets` 中相同内容版本的资产：

```text
storage_asset_id uuid nullable
foreign key (storage_asset_id, content_version_id)
  references storage_assets(storage_asset_id, content_version_id)
unique (storage_asset_id) where storage_asset_id is not null
```

保留原 `storage_url` 字段以兼容已有 schema，但新上传流程不得再由浏览器写入该字段，也不得在其中保存会过期的 presigned URL。后续确认无历史依赖后再通过独立 migration 退役它。

建议索引：

```text
storage_assets(content_version_id, asset_status, created_at desc)
storage_assets(owner_user_id, asset_status, created_at desc)
storage_assets(upload_expires_at) where asset_status in ('pending', 'uploaded')
```

`003_enterprise_access_and_query_hardening.sql` 已撤销 API role 的默认新对象权限，因此 `005` 必须显式授予 `colearnx_app` 所需的最小 `SELECT, INSERT, UPDATE, DELETE`；不要授予 `CREATE` 或 owner 权限。若使用 identity/sequence，也必须显式授予相应 sequence 权限。

## 6. Object key 规则

Object key 必须由服务端生成，客户端不能传完整 key。建议格式：

```text
staging/content/<owner-user-id>/<content-version-id>/<random-uuid>
```

可保留经 allowlist 判断后的扩展名，但不要把未经处理的原文件名直接放入 key。必须防止：

- `../`、反斜杠和控制字符；
- 同名覆盖；
- 用户猜测其他用户路径；
- 覆盖已经提交或发布的对象。

每次替换 draft 文件都生成新的随机 key。内容提交后 asset/key 视为不可变。

## 7. API 契约

以下所有 API 位于 `https://api-staging.colearnx.net/api/v1`，复用现有 Bearer access token、CSRF、错误响应和 request ID 规范。不要在配置或文档中继续使用旧的 `pages.dev` 或 `onrender.com` 地址。

### 7.1 初始化上传

```http
POST /content-versions/:contentVersionId/upload-intents
Authorization: Bearer <access token>
Idempotency-Key: <client-generated UUID>
Content-Type: application/json
```

请求：

```json
{
  "filename": "course-notes.pdf",
  "mediaType": "application/pdf",
  "sizeBytes": 4831021,
  "sha256": "optional-64-character-lowercase-hex"
}
```

成功响应：

```json
{
  "data": {
    "assetId": "uuid",
    "uploadUrl": "https://...short-lived-presigned-put...",
    "method": "PUT",
    "requiredHeaders": {
      "Content-Type": "application/pdf"
    },
    "expiresAt": "2026-09-01T12:10:00.000Z"
  },
  "meta": {
    "requestId": "uuid"
  }
}
```

服务端动作：

1. 校验登录用户具有 `creator` role；
2. 查询 `content_versions -> contents`，确认版本属于当前用户；
3. 确认 `contents.publication_status='draft'` 且 `content_versions.version_status='draft'`；
4. 校验文件大小、MIME、扩展名和文件名长度；
5. 生成随机 object key；
6. 插入 `storage_assets(asset_status='pending')`，并保存对应 `content_version_id`；
7. 生成 5–10 分钟有效的 presigned PUT URL；
8. 不记录 signed URL 和 R2 凭据。

同一用户、同一请求指纹和同一 `Idempotency-Key` 的安全重放必须返回同一个未过期 upload intent；同一 key 搭配不同指纹返回 409。用户明确开始一次新的上传/替换尝试时使用新的 key。complete 端点则通过 asset 状态实现幂等，重复确认已 ready 的同一对象应返回当前安全元数据，不重复创建资产。

当前规则为：`application/pdf`、DOCX、ZIP 和图片单文件最多 `26214400` bytes（25 MiB），`video/mp4` 最多 `104857600` bytes（100 MiB）；每位 Creator 的所有未删除文件合计最多 500 MiB，同时最多三个未完成上传。若 Windows 浏览器为 ZIP 报告兼容 MIME，必须在前后端契约中显式列出，不要退化为接受任意 `application/octet-stream`。不接受 `text/html`、JavaScript、SVG 或可执行文件，也不要仅信任文件扩展名。前端只做快速反馈，后端必须在创建 upload intent 前强制检查单文件大小、总量和未完成上传数。

### 7.2 浏览器上传

前端收到响应后直接：

```http
PUT <uploadUrl>
Content-Type: application/pdf

<raw file bytes>
```

文件正文不得通过 Express JSON 或 multipart 路由中转。当前 Express JSON body limit 为 1 MB，保持该限制即可。

### 7.3 完成上传

```http
POST /content-versions/:contentVersionId/upload-intents/:assetId/complete
Authorization: Bearer <access token>
Content-Type: application/json
```

请求可为空对象：

```json
{}
```

成功响应：

```json
{
  "data": {
    "assetId": "uuid",
    "status": "ready",
    "filename": "course-notes.pdf",
    "mediaType": "application/pdf",
    "sizeBytes": 4831021
  },
  "meta": {
    "requestId": "uuid"
  }
}
```

服务端必须：

1. 重新执行 creator、所有权和 draft 状态校验，不能相信初始化阶段的结果；
2. 确认 asset 属于该用户、该内容版本且当前为 `pending`；
3. 使用数据库中的 bucket/key 调用 `HeadObject`；
4. 对比 `ContentLength` 与数据库中的 `declared_byte_size`，一致后写入 `verified_byte_size`；
5. 对比/规范化 `ContentType`，一致后写入 `verified_content_type`；
6. 保存 ETag；
7. 将 asset 标记为 `ready`，设置 `uploaded_at`、`verified_at`、`updated_at`，并关联 `content_versions.storage_asset_id`；
8. 替换旧 draft asset 时，将旧 asset 标记为 `deleted` 并进入异步/补偿清理；
9. 整个数据库状态变更在事务中执行，并使重复 complete 安全幂等。

若对象不存在、大小不匹配、类型不匹配或状态不合法，返回明确 4xx；不得把 R2 SDK 原始错误、bucket/key 或凭据返回给客户端。

### 7.4 删除或替换 draft 文件

```http
DELETE /content-versions/:contentVersionId/upload-intents/:assetId
Authorization: Bearer <access token>
```

仅允许 Creator 本人删除自己的 draft asset。数据库先解除 draft 关联并标记 `delete_pending`，立即停止签发下载 URL，再调用 R2 `DeleteObject`；成功后标记 `deleted` 并设置 `deleted_at`。若 R2 删除暂时失败，应保留 `delete_pending` 供后台任务重试，不要恢复成可下载状态。

已 submitted、approved 或 published 的 asset 禁止由 Creator 覆盖或删除。内容更新必须创建新的 `content_version` 和新 asset。

### 7.5 提交审核 gate

现有：

```http
POST /content/:contentId/submit
```

必须增加服务端 gate：

- 当前用户是内容 owner；
- content 和 version 均为 draft；
- `content_versions.storage_asset_id` 非空；
- 对应 `storage_assets.asset_status='ready'`；
- asset owner 与 content creator 一致；
- asset 未软删除。

任一条件不满足时返回：

```text
409 CONTENT_FILE_NOT_READY
```

管理员发布时应再次检查 asset 仍为 `ready`，防止状态竞态。公开 `/content` 与 `/content/:id` 永不返回 bucket、object key、storage URL 或 signed URL。

### 7.6 管理员审核预览

```http
POST /admin/content-versions/:contentVersionId/preview-url
Authorization: Bearer <admin access token>
```

成功响应：

```json
{
  "data": {
    "assetId": "uuid",
    "filename": "course-notes.pdf",
    "mediaType": "application/pdf",
    "sizeBytes": 4831021,
    "previewUrl": "https://...short-lived-presigned-get...",
    "expiresAt": "2026-09-01T12:05:00.000Z"
  },
  "meta": {
    "requestId": "uuid"
  }
}
```

仅 `admin` 可调用。只为 `ready` asset 签发短期 GET，建议 5 分钟。响应使用安全的 `Content-Disposition`，不要让用户上传的原始文件名进入 HTTP header 而未转义。

本轮没有病毒扫描，因此 UI 和文档只能说明“文件已上传并可审核”，不能声称“文件安全”或“已经过扫描”。高风险格式应拒绝或强制下载，避免内联渲染。

### 7.7 购买者下载

```http
POST /content-versions/:contentVersionId/download-url
Authorization: Bearer <access token>
```

成功响应：

```json
{
  "data": {
    "filename": "course-notes.pdf",
    "mediaType": "application/pdf",
    "sizeBytes": 4831021,
    "downloadUrl": "https://...short-lived-presigned-get...",
    "expiresAt": "2026-09-01T12:05:00.000Z"
  },
  "meta": {
    "requestId": "uuid"
  }
}
```

每次签发前必须重新查询授权，允许以下任一情况：

- `content_access_grants.user_id` 为当前用户，并且 `expires_at IS NULL OR expires_at > now()`；
- 当前用户是该内容的 Creator owner；
- 当前用户具有 `admin` role。

普通用户没有有效 grant 时返回 403；内容未发布、asset 非 `ready` 或已删除时不得签发。

不要把永久 R2 URL写入订单、grant 或浏览器 localStorage。signed GET 建议 5 分钟有效，并尽量使用 `Content-Disposition: attachment`。

### 7.8 统一错误码

沿用现有 API 错误包装格式，建议至少定义：

| HTTP | Code | 使用场景 |
| --- | --- | --- |
| 401 | `AUTH_REQUIRED` | 未登录或 access token 无效 |
| 403 | `CREATOR_ROLE_REQUIRED` | 上传用户没有 Creator role |
| 403 | `CONTENT_UPLOAD_FORBIDDEN` | 非 owner 操作内容版本或 asset |
| 403 | `CONTENT_ACCESS_DENIED` | 无有效购买 grant 且不是 Owner/Admin |
| 404 | `CONTENT_VERSION_NOT_FOUND` | 内容版本不存在；不得借此泄露其他用户私有记录 |
| 404 | `UPLOAD_INTENT_NOT_FOUND` | upload intent 不存在或不可见 |
| 409 | `CONTENT_VERSION_NOT_DRAFT` | submitted/published 版本尝试上传、替换或删除 |
| 409 | `UPLOAD_NOT_PENDING` | 非 pending asset 调用 complete |
| 409 | `UPLOAD_OBJECT_MISMATCH` | `HeadObject` 的大小或 MIME 与 intent 不一致 |
| 409 | `CONTENT_FILE_NOT_READY` | 未完成上传就提交审核或发布 |
| 413 | `CONTENT_FILE_TOO_LARGE` | 超过对应文件类型的配置上限 |
| 413 | `CONTENT_STORAGE_QUOTA_EXCEEDED` | Creator 的总文件配额不足 |

| 429 | `CONTENT_UPLOAD_PENDING_LIMIT` | 已有三个未完成上传 |

| 503 | `OBJECT_STORAGE_UNAVAILABLE` | R2 暂时不可用；不返回 SDK 原始错误 |

客户端可以根据稳定 `code` 显示提示，不应解析英文 message。

## 8. `first_accessed_at` 约定

`content_access_grants` 已有 `first_accessed_at`，但当前退款服务没有读取内容下载证据。由于 presigned GET 由浏览器直接访问 R2，Render API 无法可靠判断客户端下载是否完整完成。

本轮明确采用以下约定：

> 成功签发购买者 download URL，即视为首次访问该内容。

下载端点应在同一数据库事务中：

```sql
UPDATE content_access_grants
SET first_accessed_at = COALESCE(first_accessed_at, now())
WHERE content_version_id = $1
  AND user_id = $2
  AND (expires_at IS NULL OR expires_at > now());
```

Owner/Admin 预览不得修改购买者的 `first_accessed_at`。

若未来产品要求“只有完成实际下载才阻断退款”，必须增加受控代理下载、Cloudflare Worker 回调或可靠事件采集，不能仅依赖 presigned URL。退款模块也需单独增加内容访问证据读取；本轮不得宣称已经实现完整内容下载退款判定。

## 9. 安全、审计与日志

必须遵守：

- bucket private；
- Access Key/Secret 仅放 Render Secrets；
- Token 限定单个 staging bucket；
- signed URL 尽量短期；
- 不在日志、审计详情、错误响应、数据库公开字段中保存 signed URL；
- 不记录 R2 Secret、Authorization header 或原始文件正文；
- object key 服务端随机生成；
- 文件大小和 MIME 同时在初始化与 complete 阶段校验；
- 上传和下载端点使用现有认证与 mutation rate limit；
- 增加每用户并发 pending 数量和总文件配额，防止滥用和成本攻击；
- 用 UUID、asset ID、content version ID、结果状态和 request ID 记录结构化日志；
- 审计日志可记录 `content.upload.initialized`、`content.upload.completed`、`content.upload.deleted`、`content.download.granted`，但不得记录 signed URL 或 secret；
- 不允许上传 HTML、脚本、SVG、可执行文件等可主动执行内容；
- 原文件名只作为元数据保存，展示和 header 输出前必须转义；
- ETag 在 multipart 场景不等于文件 MD5，不能当作密码学完整性证明。

## 10. 孤儿对象与补偿清理

至少实现以下清理策略：

- `pending` 超过 24 小时：删除 R2 对象（若存在），asset 标记 `deleted`；
- `deleted` 且 R2 删除失败：记录重试状态，由定时任务再次删除；
- R2 中存在、数据库不存在的对象：定期对账后进入隔离/删除流程；
- draft 替换文件时，旧对象不能继续被签发；
- 已发布对象不得原地覆盖；
- 数据库事务与 R2 操作不能组成真正的分布式事务，必须设计幂等 complete/delete 和可重试补偿。

可以先用受控 Render Cron/One-off Job 每 15 分钟执行 `npm --prefix apps/api run storage:reconcile`；不要在普通请求里扫描整个 bucket。

## 11. 前端接入要求

前端应修改实际使用的 `CreatorPlatformPages.jsx`，不要启用旧原型页面。

创建和上传顺序：

1. 调用 `POST /content` 创建 draft，取得 `contentVersionId`；
2. 调用 upload-intents API；
3. 使用原始文件执行 presigned PUT，并显示上传进度；
4. PUT 成功后调用 complete；
5. complete 返回 `ready` 后才能启用“Submit for review”；
6. 上传失败可重试，不重复创建内容 draft；
7. 管理员审核页只通过 preview-url API 预览；
8. Purchases 页面只通过 download-url API 获取下载地址。

前端不得保存或接触 R2 Access Key/Secret，也不得把 signed URL 长期存入 localStorage/sessionStorage。

## 12. 必须测试的场景

### 单元与 API 测试

- 非登录用户不能初始化上传；
- Member 或 Trainer 但非 Creator 返回 403；
- Creator 不能操作其他人的 content/version/asset；
- 只有 draft 可以上传、替换和删除；
- 超限文件、空文件、不允许 MIME、恶意文件名被拒绝；
- object key 由服务端生成且不重复；
- complete 对不存在的对象返回明确错误；
- `HeadObject` 大小或 MIME 不一致时不能标记 ready；
- complete 重试幂等；
- 没有 ready asset 时 submit 返回 `CONTENT_FILE_NOT_READY`；
- Admin 可预览，普通用户不能调用 admin preview；
- 有效 grant 可以下载；
- 无 grant、已过期 grant、已退款 grant 返回 403；
- Owner/Admin 可以预览，但不改变购买者 `first_accessed_at`；
- 首次签发购买者下载地址会设置 `first_accessed_at`，后续不覆盖首次时间；
- published asset 不能由 Creator 覆盖或删除；
- API 响应和日志不包含 R2 secret 或永久 object URL。

### 部署后 smoke test

1. Creator 新建内容并上传允许格式的小文件；
2. R2 bucket 可见对象，Neon asset 状态为 `ready`；
3. Creator 提交审核；
4. Admin 获取预览并批准；
5. Member 购买内容；
6. Member 获取短期下载地址并成功下载；
7. 未购买 Member 返回 403；
8. signed URL 过期后不能继续使用；
9. 替换 draft 后旧对象无法继续获得新 URL；
10. Render 日志中没有凭据和 signed URL。

合并前执行：

```powershell
npm ci
npm --prefix apps/api ci
npm run api:typecheck
npm run api:test
npm test
npm run api:build
npm run build
```

## 13. 文档与示例配置更新

实现时同步更新：

- `apps/api/.env.example`；
- `docs/API.md`；
- `docs/DATA_MODEL.md`；
- `docs/STAGING_RENDER_NEON.md`；
- `docs/LOCAL_RUNBOOK.md`；
- `README.md`；
- `DEPLOYMENT_HANDOFF.md`（如部署流程发生变化）。

只提交变量名和无密钥示例，不提交真实 `.env`、R2 Token、bucket dump、signed URL 或数据库导出。

## 14. 部署顺序

1. Cloudflare 创建私有 staging bucket、bucket-scoped Token、CORS 与生命周期规则；
2. 合并后端、前端、测试、文档和 `005_object_storage.sql`；
3. 用 Neon Owner 的受控 direct/unpooled 连接执行 `npm run db:migrate`；
4. 验证 `schema_migrations` 已记录 `005_object_storage.sql`；
5. Render Secrets 中添加 R2 环境变量；
6. 部署 Render API，检查 `/health/live`、`/health/ready`；
7. 重新构建部署 Cloudflare Pages；
8. 执行完整 Creator → Admin → Member smoke test；
9. 确认日志、数据库和浏览器均未泄露密钥。

不要运行 `db:seed`，不要重新导入本地数据库，不要覆盖现有用户或订单数据。

## 15. 后端交付物清单

后端同学需交付：

- 与数据库同学确认并评审 `005_object_storage.sql` 的最终字段、权限和兼容性；
- R2 storage adapter 与严格环境变量校验；
- upload-intents、complete、abort/delete、admin preview、entitlement download API；
- `submitContent` 和管理员 publish 的 ready-asset gate；
- `first_accessed_at` 签发即访问的实现；
- 上传/下载/所有权/状态/权限测试；
- 提供给前端同学的最终 API 契约、错误码和安全响应示例；
- `.env.example` 与相关文档更新；
- PR 中列明 migration、所需环境变量名、部署顺序、兼容性和回滚方案；
- 不包含任何真实密钥、signed URL、数据库连接串或数据导出。

安全回滚原则：代码可回滚到旧版本，但 `005` 不反向删除表或列；停止新上传时设置 `OBJECT_STORAGE_PROVIDER=disabled`，保留数据库元数据和 R2 对象，待问题修复后恢复。
