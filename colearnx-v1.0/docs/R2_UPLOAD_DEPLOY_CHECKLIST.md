# R2 上传部署与排障清单

此清单对应 Content Editor 的自动多文件上传。浏览器直接把文件传到私有 R2；Render API 只签发短期 URL、验证完成状态并保存元数据到 Neon。

## 本次代码行为

- Creator 可一次选择或拖入多个文件；页面会**逐个**上传，显示进度，完成后显示绿色勾，点击 × 即可删除。
- 支持 PDF、DOCX、ZIP、JPEG、PNG、WebP（每个最多 25 MiB）和 MP4（每个最多 100 MiB）。每位 Creator 所有未删除附件合计最多 500 MiB。
- 每一个文件都必须经 Render 的 `HeadObject` 验证后才是 `ready`；至少一个 `ready` 文件且没有正在上传的文件时，才可提交审核。
- 新文件不会覆盖已完成附件。兼容旧功能的“主文件”仍保留，但购买者/管理员可按附件 ID 请求受控 URL。
- 若浏览器在取得预签名 URL 后中断，同一草稿的下一次上传会自动回收这个未完成记录，避免 `CONTENT_UPLOAD_PENDING_LIMIT`（截图中的 “Finish or remove …”）把用户卡住。

本次没有新的数据库 migration：`storage_assets` 与现有 `005`–`007` migration 已支持一条内容版本关联多个文件。不要导入本地数据库、不要重跑 seed、不要修改已经执行过的 migration。

## 部署同学的步骤

1. 合并此 PR 后，Render 和 Cloudflare Pages 都必须从相同的最新 `main` 重新构建部署。
2. Render 环境变量必须保持：

   ```text
   OBJECT_STORAGE_PROVIDER=r2
   APP_ORIGIN=<当前 Pages 的完整 origin，例如 https://staging.colearnx.net>
   R2_ACCOUNT_ID=<secret>
   R2_ACCESS_KEY_ID=<secret>
   R2_SECRET_ACCESS_KEY=<secret>
   R2_BUCKET_NAME=<私有 bucket>
   R2_REGION=auto
   R2_SIGNED_UPLOAD_TTL_SECONDS=600
   R2_SIGNED_DOWNLOAD_TTL_SECONDS=300
   CONTENT_UPLOAD_MAX_BYTES=26214400
   CONTENT_VIDEO_UPLOAD_MAX_BYTES=104857600
   CONTENT_STORAGE_QUOTA_BYTES=524288000
   CONTENT_PENDING_UPLOAD_LIMIT=3
   ```

   R2 密钥只放在 Render 的 Secret 环境变量中，绝不能放入 Pages、`VITE_*`、Git、截图或聊天记录。

3. 在 Cloudflare R2 的私有 bucket 配置 CORS。`AllowedOrigins` 必须包含用户实际打开页面时浏览器地址栏里的**完整 origin**；若 `pages.dev` 和自定义域名都仍在测试，就同时列出两者。示例（将域名替换为真实值）：

   ```json
   [
     {
       "AllowedOrigins": ["https://staging.colearnx.net", "https://colearnx-staging.pages.dev"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["Content-Type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Bucket 必须保持私有，不能使用 `*` 作为生产 origin，也不需要为 Pages 设置 R2 凭据或公开 bucket 域名。

4. Pages 只设置并在修改后重新构建：

   ```text
   VITE_API_BASE_URL=<Render API 的完整 /api/v1 地址>
   ```

5. 发布后在 Render 的受控 Shell/Cron 使用同一组 Render 环境变量运行一次，并设置每 15 分钟运行一次：

   ```bash
   npm --prefix apps/api run storage:reconcile
   ```

   该命令只处理过期或已标记删除的对象；不要手工删除 Neon 的用户或内容记录。新代码会在同一草稿再次上传时立即处理旧的未完成记录。

## 验收与排障

1. 用 Creator 创建草稿，同时选两个小文件。应看到第一行进度，随后两行依次变成绿色勾；选择 DOCX 应被接受。
2. 点击任意已完成行的 ×。该行消失，R2 对象会被后端删除或进入安全的重试清理。
3. 上传时如果显示“网络连接中断”：
   - 先打开 `<Render API origin>/health/live`，确认 Render API 可访问；若不可访问，检查 Render 部署和 `VITE_API_BASE_URL`，重新构建 Pages。
   - 若 API 可访问但浏览器 DevTools Network 中 R2 `PUT` 是 CORS/status 0，检查 R2 CORS 的 origin 是否与 `location.origin` 完全一致，并确认允许 `PUT` 和 `Content-Type`。
   - 若 API 请求本身返回 401/403，重新登录并确认该账号已获批 `creator` 角色。
4. 若显示 “Finish or remove an existing upload before starting another one”，这是旧版本遗留的未完成 intent 到达安全上限，而不是文件格式错误。部署本 PR 后，在**同一草稿**重新选择文件即可自动回收该草稿的旧记录；若仍是其他草稿的过期记录，则让部署同学运行一次 reconciliation，切勿删除用户数据。
5. 只测试小文件后再测试 MP4。100 MiB 是单个 MP4 上限，不是无限视频上传；更大的视频需要后续的 multipart/Cloudflare Stream 方案。
