# CoLearnX R2 前端上传功能交接

## 1. 目的与部署基线

本交接用于在 CoLearnX staging 中接入 **Content Editor 的私有付费文件上传**。

- 前端：`https://staging.colearnx.net`
- API Base：`https://api-staging.colearnx.net/api/v1`
- 文件存储：Cloudflare R2 私有 Bucket
- 业务数据：Neon PostgreSQL
- API 运行时：Render 上的 Node/Express

R2 是对象存储，不是数据库，也不替代 Neon。文件本体进入 R2；文件归属、状态、大小、类型、购买授权等结构化信息进入 PostgreSQL。

## 2. 当前缺口

当前仓库尚未实现真实文件上传：

1. `src/App.jsx` 实际使用 `src/pages/CreatorPlatformPages.jsx` 中的 Content Editor 和 Course Editor。
2. 当前 Content Editor 仅创建标题、类型、积分价格等目录元数据，并明确提示私有上传尚未配置。
3. `src/api/catalog.js` 只有创建与提交接口，没有上传授权、完成确认、取消、替换或下载接口。
4. `src/context/PlatformContext.jsx` 仍可把 `externalUrl` 映射成 `storageUrl`，但当前页面没有对应字段。接入 R2 后不得再接受浏览器提供的永久存储 URL。
5. `src/pages/CreatorPages.jsx` 中虽然存在拖放区域，但该页面未接入当前路由，而且只保存 `file.name` 到前端状态/localStorage，文件字节从未上传。它只能作为视觉参考，不能作为已实现功能。
6. `src/api/client.js` 的 Axios 实例固定使用 JSON 请求头。R2 二进制直传不得复用这个实例。

## 3. 本轮明确范围

本轮只完成以下闭环：

- 已获批 Creator 在 Content Editor 创建一条 content draft。
- 每个 content version 绑定一个私有付费文件。
- 浏览器取得短时效预签名 PUT 地址后直接上传至 R2。
- Node API 在上传完成后检查对象，并把资产状态标记为 `ready`。
- 只有资产状态为 `ready` 的 content 才能提交管理员审核。
- 已购买用户通过 Node API 的授权检查取得短时效下载地址。
- Creator 可在草稿阶段取消、重试、移除或替换文件。

以下内容不在本轮：

- Course Editor 的课程视频、封面、课件或录播上传。
- 视频转码、HLS/DASH、缩略图生成和可信观看进度。
- 多文件内容包、分片/断点续传和超大文件 multipart upload。
- 公共 R2 Bucket、永久公开下载 URL 或 R2 自定义公开域名。
- 病毒扫描平台集成；如后端未提供扫描能力，本轮必须限制允许的文件类型，并在交付说明中记录该限制。

课程相关页面本轮保持原状，不得为了“看起来完成”而把课程文件写入 `content_versions`。

## 4. 推荐架构与完整流程

```text
Content Editor
  1. 创建 content draft，取得 contentVersionId
  2. 向 Node API 请求短时上传授权
        ↓
Render Node/Express API
  3. 校验登录、Creator 角色、草稿所有权、文件策略
  4. 为随机 object key 生成短时 presigned PUT URL
        ↓
浏览器 ──PUT 文件字节──> 私有 Cloudflare R2
        ↓
  5. 浏览器通知 Node API“上传完成”
  6. Node API 使用 HeadObject 校验对象大小、类型和状态
  7. PostgreSQL 将资产标记为 ready
        ↓
  8. 前端才允许提交管理员审核
```

R2 凭据只存在于 Render Secrets。前端只短暂持有一次性/短时效预签名 URL，不接触 R2 Access Key、Secret、Account ID 或 Bucket 管理权限。

## 5. 前端文件修改点

### 必须修改

- `src/pages/CreatorPlatformPages.jsx`
  - 只为 `ContentEditorPage` 加入文件选择、文件信息、上传进度、取消、重试、替换、移除和状态提示。
  - 把当前“创建并立即提交”的 content 流程拆成“创建草稿 → 上传并确认 → 提交审核”。
  - `CourseEditorPage` 本轮不得出现文件上传控件。

- `src/api/catalog.js`
  - 创建 content 时不再发送 `storageUrl`。
  - 保留既有 `/content` 和 `/content/:id/submit` 调用。

- `src/context/PlatformContext.jsx`
  - 移除 content payload 中由浏览器提供的 `storageUrl`。
  - 不要让 `savePublishedItem` 在文件尚未 `ready` 时调用 submit。
  - 刷新 `/my/listings` 后应保留后端返回的资产状态与安全元数据。

- `src/styles.css`
  - 可复用现有 `.upload-zone` 风格，补充进度条、错误、成功、禁用、拖放激活和窄屏状态。

### 建议新增

- `src/api/uploads.js`
  - 封装上传授权、完成确认、查询状态、取消/移除和下载授权 API。

- `src/components/uploads/PrivateAssetUploader.jsx`
  - 负责文件选择、状态机、进度、取消、重试、替换与可访问性提示。

- `src/utils/uploadFile.js`
  - 使用独立 `XMLHttpRequest` 上传至预签名 PUT URL。
  - 使用 XHR 是为了可靠取得上传进度和执行 `abort()`。
  - 该请求不得附带 CoLearnX Bearer Token、CSRF Token、Cookie 或 JSON `Content-Type`。

- 对应的组件、API 与状态机测试文件。

不要把当前未接路由的 `CreatorPages.jsx` 直接重新启用。若需要复用其布局，应提取视觉样式或重写为受控组件。

## 6. 前后端 API 契约

以下路径均以 `/api/v1` 为前缀。成功响应沿用当前格式：

```json
{
  "data": {},
  "meta": { "requestId": "UUID" }
}
```

错误响应沿用：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Safe user-facing message",
    "details": {},
    "requestId": "UUID"
  }
}
```

所有发往 CoLearnX API 的写请求继续使用现有 Bearer Token、`X-CSRF-Token`，并按后端要求提供 `Idempotency-Key`。只有直传 R2 的 PUT 请求不携带这些 CoLearnX 凭据。

### 6.1 创建 content 草稿（现有接口）

`POST /api/v1/content`

```json
{
  "title": "Practical Prompt Guide",
  "contentType": "pdf",
  "pricePoints": 50
}
```

不得再提交 `storageUrl`、R2 object key 或 Bucket 名称。

```json
{
  "data": {
    "id": "content-uuid",
    "contentVersionId": "content-version-uuid",
    "status": "draft"
  },
  "meta": { "requestId": "UUID" }
}
```

### 6.2 请求上传授权（新增）

`POST /api/v1/content-versions/:contentVersionId/upload-intents`

```json
{
  "filename": "prompt-guide.pdf",
  "mediaType": "application/pdf",
  "sizeBytes": 2841032
}
```

如后端要求客户端校验和，可额外传 `sha256`；它不能替代服务端对象检查。本轮 staging 默认最大 `104857600` bytes（100 MiB），默认允许 PDF、ZIP、JPEG、PNG、WebP 和 MP4；精确 MIME 列表以后端最终契约为准。前端必须镜像该规则用于快速反馈，但后端校验才是安全边界。

```json
{
  "data": {
    "assetId": "asset-uuid",
    "method": "PUT",
    "uploadUrl": "https://temporary-r2-presigned-url.example",
    "expiresAt": "2026-09-01T12:05:00.000Z",
    "requiredHeaders": {
      "Content-Type": "application/pdf"
    }
  },
  "meta": { "requestId": "UUID" }
}
```

`uploadUrl` 只能保存在内存中，不能写入 localStorage、sessionStorage、日志、埋点、错误上报或页面 URL。

### 6.3 浏览器直接上传 R2

向响应中的 `uploadUrl` 发起 PUT：

```http
PUT <uploadUrl>
Content-Type: application/pdf

<raw file bytes>
```

必须逐字使用后端返回的 `requiredHeaders`。不得额外附带 Authorization、Cookie、CSRF、Idempotency-Key 或自定义业务请求头。前端成功标准不是“PUT 返回 2xx”，而是后续完成确认接口返回 `ready`。

### 6.4 完成确认（新增）

`POST /api/v1/content-versions/:contentVersionId/upload-intents/:assetId/complete`

```json
{}
```

后端必须通过 R2 HeadObject 验证对象确实存在且大小/类型与 upload intent 一致。前端不得自己把资产状态设为 ready。

```json
{
  "data": {
    "assetId": "asset-uuid",
    "filename": "prompt-guide.pdf",
    "mediaType": "application/pdf",
    "sizeBytes": 2841032,
    "status": "ready"
  },
  "meta": { "requestId": "UUID" }
}
```

### 6.5 恢复当前资产状态

页面刷新、完成确认超时或重新进入草稿时，前端通过现有 `GET /api/v1/my/listings` 恢复服务器状态。后端需在本人 listing 的 content 记录中返回 `asset` 安全元数据（无资产时为 `null`）：

```json
{
  "asset": {
    "assetId": "asset-uuid",
    "filename": "prompt-guide.pdf",
    "mediaType": "application/pdf",
    "sizeBytes": 2841032,
    "status": "ready",
    "uploadedAt": "2026-09-01T12:03:24.000Z"
  }
}
```

该响应不得返回 object key、Bucket、R2 endpoint、永久 URL 或凭据。

### 6.6 取消、移除与替换（新增）

`DELETE /api/v1/content-versions/:contentVersionId/upload-intents/:assetId`

- 上传过程中点击“取消”：先调用 XHR `abort()`，再请求后端清理 pending 记录/残留对象。
- 移除已完成文件：只允许 Creator 本人对自己的 draft 操作。
- 替换文件：先请求新的 upload intent；新文件完成并验证后，由后端原子切换当前资产，再异步清理旧对象。
- 新文件上传失败时，原先的 ready 文件必须保持有效，不能先删旧文件。

前端不得直接调用 R2 DeleteObject，也不得接收或拼接 object key。

### 6.7 提交管理员审核（现有接口，新增门禁）

`POST /api/v1/content/:contentId/submit`

前端只有在资产状态为 `ready` 时才启用按钮；后端也必须独立执行同一门禁。浏览器状态不能作为安全依据。

资产缺失或未完成时，后端应返回：

```json
{
  "error": {
    "code": "CONTENT_FILE_NOT_READY",
    "message": "Upload and verify the paid file before submitting for review.",
    "details": {},
    "requestId": "UUID"
  }
}
```

### 6.8 购买后的私有下载（新增）

`POST /api/v1/content-versions/:contentVersionId/download-url`

Node API 必须先校验：

- 当前用户拥有有效 `content_access_grants`；或
- 当前用户是该内容的 Creator；或
- 当前用户是有审核需要的 Admin。

```json
{
  "data": {
    "downloadUrl": "https://temporary-r2-presigned-url.example",
    "expiresAt": "2026-09-01T12:10:00.000Z",
    "filename": "prompt-guide.pdf",
    "mediaType": "application/pdf",
    "sizeBytes": 2841032
  },
  "meta": { "requestId": "UUID" }
}
```

前端收到后立即打开或下载，并在链接过期时重新请求。不得缓存、分享或渲染成永久资源链接。未购买用户必须得到 403；公开 `/content` 接口不得包含下载地址或 object key。管理员审核预览使用独立的 `POST /api/v1/admin/content-versions/:contentVersionId/preview-url`，不得借用购买者下载接口。

## 7. 前端上传状态机

组件只能根据明确状态渲染，不使用多个互相冲突的布尔值。

| 状态 | 含义 | 主要 UI | 是否允许提交审核 |
| --- | --- | --- | --- |
| `idle` | 未选择文件 | 拖放区/选择文件 | 否 |
| `selected` | 已选文件、尚未请求授权 | 文件名、大小、类型；上传按钮 | 否 |
| `preparing` | 正在创建草稿或请求 intent | Spinner；禁用重复操作 | 否 |
| `uploading` | 正在 PUT R2 | 百分比、已传/总量、取消 | 否 |
| `verifying` | PUT 完成，后端正在 HeadObject 确认 | “正在验证文件”；不可再次提交 | 否 |
| `uploaded` | 后端返回 `ready` | 成功状态、替换/移除 | 是 |
| `error` | 任一步失败 | 可读错误、重试/重新选择 | 否；若替换失败且旧资产仍 ready，则旧资产仍可提交 |
| `cancelled` | 用户主动取消 | 已取消、重新上传 | 否 |

页面刷新后以服务器返回的资产状态为准。浏览器不能恢复本地 `File` 对象；如果服务端没有 ready 资产，应提示用户重新选择文件。

## 8. 进度、取消、重试与替换要求

### 进度

- 显示 `0–100%`、已上传/总大小。
- 使用 `aria-live="polite"` 播报关键状态，进度条带可访问名称。
- 不虚构进度；没有 `lengthComputable` 时显示不定进度。
- PUT 100% 后立即切换到“验证中”，不得先显示“上传成功”。

### 取消

- `uploading` 状态提供取消按钮。
- 取消调用 XHR `abort()`，UI 进入 `cancelled`，不显示为系统错误。
- 尽力通知后端清理；即使清理接口暂时失败，也不能继续提交审核。

### 重试

- 网络中断或预签名地址过期后，重新调用 upload-intents 接口获取新 URL，不盲目复用旧 URL。
- 完成确认超时时，先查询服务器资产状态；如果已经 `ready`，不得重复上传。
- 重试必须使用新的 `Idempotency-Key` 处理一个新的上传尝试；同一次 API 请求的安全重放则复用原 key，具体由 API 层统一管理。

### 替换

- 已有 ready 文件时先显示确认对话框，说明文件名和影响。
- 新文件被后端确认 ready 前保留旧文件。
- 替换成功后刷新服务器资产状态与 `/my/listings`。

## 9. Content Editor 交互与审核门禁

建议页面顺序：

1. 填写标题、内容类型和价格。
2. 点击“Save draft”并取得 content/contentVersion ID。
3. 选择文件并确认拥有发布权。
4. 上传并等待服务器验证。
5. 资产显示 `Uploaded and verified`。
6. “Submit for administrator review” 才可点击。

按钮门禁至少包含：

- Creator 角色有效。
- 内容仍为本人拥有的 draft。
- 必填元数据有效。
- 版权/授权确认已勾选。
- 服务器资产状态严格等于 `ready`。
- 当前不处于 uploading/verifying/replacing。

即使用户篡改 DOM 强行点击，后端仍必须返回 `CONTENT_FILE_NOT_READY` 或 403。

## 10. 错误处理

前端应优先显示后端安全 message，并根据 `error.code` 提供下一步操作：

| 错误码/场景 | 前端行为 |
| --- | --- |
| `AUTH_REQUIRED` | 尝试现有会话恢复；失败则要求重新登录并保留草稿标识 |
| `CREATOR_ROLE_REQUIRED` | 显示需要已批准 Creator 身份，不自动重试 |
| `CONTENT_UPLOAD_FORBIDDEN` | 显示无权修改该草稿，不自动重试 |
| `CONTENT_ACCESS_DENIED` | 下载时显示未购买或无有效授权 |
| `CONTENT_VERSION_NOT_FOUND` | 刷新 listing；仍不存在则返回列表页 |
| `CONTENT_FILE_TOO_LARGE` | 显示允许的最大值，要求重新选择 |
| `CONTENT_FILE_TYPE_NOT_ALLOWED` | 显示支持的类型，要求重新选择 |
| `CONTENT_VERSION_NOT_DRAFT` | 禁止上传/替换，刷新 listing 状态 |
| R2 PUT 403/签名过期 | 获取新的 intent 后重试 |
| `UPLOAD_INTENT_NOT_FOUND` | 清理本地 attempt 并重新创建 intent |
| `UPLOAD_NOT_PENDING` | 刷新 `/my/listings`，按服务器资产状态恢复 |
| `UPLOAD_OBJECT_MISMATCH` | 提示服务器验证失败，要求重新选择/上传 |
| `CONTENT_FILE_NOT_READY` | 保持提交按钮禁用并刷新 listing 状态 |
| `OBJECT_STORAGE_UNAVAILABLE` | 保留草稿，提示稍后重试 |
| 网络中断/超时 | 提供重试；complete 超时先查询状态 |
| 用户取消 | 安静进入 cancelled，不显示红色系统故障 |

所有错误界面应显示可复制的 `requestId`，便于查 Render Logs；不得显示或记录预签名 URL、R2 响应签名、Cookie、Token 或对象 key。

## 11. 安全禁区

以下行为禁止：

- 把 R2 Access Key、Secret、Account ID、Bucket 管理凭据放进 Vite 环境变量、前端代码或 GitHub。
- 建立公共 Bucket，或把 R2 object key/永久 URL写入公开页面。
- 让浏览器自行指定 `storageUrl`、object key 或其他用户的 contentVersionId。
- 仅靠扩展名或浏览器 MIME 作为服务端文件验证。
- 把预签名 URL 写入 localStorage/sessionStorage、Sentry、Analytics、console 或截图。
- 在 R2 PUT 请求上附带 CoLearnX Authorization、Cookie 或 CSRF Token。
- 因为配置了 CORS 就认为完成了鉴权；CORS 不是安全边界。
- 在资产未被服务器确认 ready 前显示“上传完成”或允许提交审核。
- 为下载功能生成长期有效链接，或绕过 `content_access_grants`。
- 使用原始文件名直接作为 object key；object key 应由后端随机生成。

R2 CORS 只允许精确 staging Origin `https://staging.colearnx.net`，并只开放本流程需要的方法/请求头。不得使用 `*` 搭配宽泛权限。

## 12. 测试要求

### 单元/组件测试

- 文件类型与大小的本地预检查。
- 状态机每个合法转换以及非法重复点击。
- uploading 显示进度并可取消。
- PUT 2xx 后进入 verifying，而不是直接 uploaded。
- complete 返回 ready 后才启用提交按钮。
- complete 失败、超时和资产不匹配时禁止提交。
- R2 PUT 不含 Authorization、CSRF、Cookie 和 JSON Content-Type。
- 预签名 URL 不写入 Web Storage 或错误日志。
- 替换失败时保留旧 ready 资产。
- 取消与重试不会重复提交 content。
- Course Editor 不显示本轮上传控件。

### API Mock 集成测试

- create draft → upload-intent → PUT progress → complete → submit 的完整成功路径。
- intent 403/过期后取得新 URL 并重试。
- PUT 网络中断、用户取消、complete 超时后的恢复。
- 页面刷新后从 API 恢复 ready 状态。
- 未 ready 时 submit 返回 `CONTENT_FILE_NOT_READY`，UI 正确处理。
- 未授权用户不能获取下载链接。

### Staging 手工验收

1. Creator 上传允许类型和边界大小文件，进度可见。
2. 上传完成后 R2 有对象，数据库资产状态为 ready，但公开 API 不泄露 object key。
3. 直接访问 Bucket/猜测对象地址失败。
4. Member、其他 Creator 无法替换或删除该资产。
5. 未完成上传无法提交审核；完成后可提交并进入管理员队列。
6. 替换失败不影响旧文件；替换成功后旧对象按后端策略清理。
7. 未购买用户下载返回 403；购买者取得短时链接并可下载。
8. 链接过期后不可继续使用，重新请求可取得新链接。
9. Chrome、Edge 至少各跑一次选择、拖放、取消、重试和下载。
10. Render 与浏览器日志中不存在 Secret、Token、完整预签名 URL 或文件内容。

## 13. 验收标准

本轮只有同时满足以下条件才算完成：

- Content Editor 上传的是实际文件字节，而不是只记录文件名或 URL。
- 文件存放在私有 R2，业务与授权数据仍在 Neon。
- 浏览器从未获得长期 R2 凭据。
- 上传具备真实进度、取消、重试、替换与错误恢复。
- 后端完成确认之前，前端不显示成功也不允许提交审核。
- 后端也强制执行 ready 门禁与所有权检查。
- 已购买用户通过受控流程下载，未授权用户不能取得下载链接。
- Course Editor 视频/封面未被误标为本轮完成。
- 前端构建、现有测试和新增测试全部通过。
- staging 只使用 `https://staging.colearnx.net` 与 `https://api-staging.colearnx.net/api/v1`。

## 14. 前端同学需提交的交付物

1. 一个独立分支与 PR，说明本轮仅实现 Content Editor 私有文件上传。
2. 实际修改/新增的前端文件清单。
3. 与后端最终一致的 API 字段与错误码；若契约调整，同步更新 `docs/API.md`。
4. 组件测试、API Mock 集成测试及通过结果。
5. `npm test` 与 `npm run build` 的通过结果。
6. staging 手工验收记录：成功、取消、重试、替换、未授权下载和链接过期。
7. UI 截图或短录屏，但截图中不得出现预签名 URL、Token 或 Secret。
8. 部署所需的**变量名称清单**，不得提供真实 Secret 值。前端原则上只需要既有：

   ```text
   VITE_API_BASE_URL=https://api-staging.colearnx.net/api/v1
   ```

9. Cloudflare Pages 部署所对应的 commit SHA 与构建记录。
10. 已知限制、回滚方式及尚未完成事项；明确写出课程视频/封面与视频播放进度不在本轮。

前端 PR 不得包含 `.env`、R2 凭据、数据库连接串、预签名 URL 样例真值、数据库导出或用户上传的测试文件。
