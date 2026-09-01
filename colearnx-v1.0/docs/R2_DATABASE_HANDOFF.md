# CoLearnX R2 对象存储与 Neon 数据库交接

## 1. 目的与当前环境

本文可直接交给数据库/后端同学，用于在现有 staging 环境中增加 Cloudflare R2 对象存储元数据支持。

- 前端：`https://staging.colearnx.net`
- API：`https://api-staging.colearnx.net`
- API 运行时：Render 上的 Express / Node.js
- 关系数据库：Neon PostgreSQL
- 文件对象：Cloudflare R2 私有 bucket

本次只做向前兼容的“扩展（expand）”变更。已经执行并记录的 `001`、`002`、`003`、`004` **不可编辑、不可重命名、不可重算后覆盖**；新结构必须放入新的 `005_object_storage.sql`。

## 2. R2 与 Neon 的职责边界

### R2 保存

- 文件二进制内容，例如图片、PDF、课件、视频等。
- 对象自身的 HTTP metadata，例如 `Content-Type`、`ETag`。
- 由服务端生成的不可预测 object key 所指向的对象。

### Neon 保存

- 对象的业务归属、上传者、稳定 bucket/key、声明和核验后的大小/类型。
- 上传状态、核验状态、软删除/隔离状态及审计时间。
- `content_versions` 与对象记录之间的外键关系。

### 明确禁止

- 不在 Neon 中保存 blob、base64、文件分片或完整文件内容。
- 不保存 presigned PUT/GET URL。该 URL 带临时签名、会过期，并应当视为 bearer token。
- 不保存 R2 Access Key、Secret Access Key 或 Cloudflare API Token。
- 不把 R2 密钥、Neon 连接串或 presigned URL 提交到 GitHub、日志、截图或普通聊天。
- `storage_url` 暂时保留用于兼容旧数据；`005` 不删除、不重命名它，也不强制回填。

数据库中只保存稳定定位信息，例如：

```text
bucket_name = colearnx-staging-assets
object_key  = staging/users/<user-uuid>/<random-uuid>
```

## 3. 本轮数据库范围

本轮建议只包含以下 additive 变更：

1. 新建 `storage_assets` 元数据表。
2. 给 `content_versions` 增加可空的 `storage_asset_id` 外键。
3. 增加必要约束和查询/清理索引。
4. 明确授予 `colearnx_app` 最小运行权限。
5. 保留现有 `content_versions.storage_url`，允许旧 API 和旧记录继续运行。

本轮不做：

- 不搬迁或覆盖既有对象/用户数据。
- 不把旧 `storage_url` 自动转换为 R2 object key。
- 不将 `storage_asset_id` 改为 `NOT NULL`。
- 不删除 `storage_url`。
- 不为 R2 presigned URL 建表。
- 不授予运行账号 DDL、schema CREATE 或 migration ledger 权限。

## 4. 建议的 `005_object_storage.sql`

以下 DDL 是建议基线。数据库同学应在分支中新增 `db/migrations/005_object_storage.sql`，结合最终 API 字段命名复核后提交；一旦在 staging 执行，就不得再修改该文件，只能继续新增 `006...`。

```sql
-- Forward-only, additive object-storage metadata support.
-- Existing content_versions.storage_url remains available for legacy rows.

CREATE TABLE storage_assets (
  storage_asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_version_id uuid NOT NULL
    REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  storage_provider text NOT NULL DEFAULT 'r2'
    CHECK (storage_provider = 'r2'),
  asset_purpose text NOT NULL DEFAULT 'content_primary'
    CHECK (asset_purpose = 'content_primary'),
  bucket_name text NOT NULL
    CHECK (length(trim(bucket_name)) BETWEEN 1 AND 255),
  object_key text NOT NULL
    CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  original_filename text NOT NULL
    CHECK (length(original_filename) BETWEEN 1 AND 512),
  declared_content_type text NOT NULL
    CHECK (length(trim(declared_content_type)) BETWEEN 1 AND 255),
  verified_content_type text
    CHECK (verified_content_type IS NULL OR length(trim(verified_content_type)) BETWEEN 1 AND 255),
  declared_byte_size bigint NOT NULL
    CHECK (declared_byte_size > 0),
  verified_byte_size bigint
    CHECK (verified_byte_size IS NULL OR verified_byte_size > 0),
  etag text
    CHECK (etag IS NULL OR length(etag) BETWEEN 1 AND 255),
  checksum_sha256 char(64)
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  asset_status text NOT NULL DEFAULT 'pending'
    CHECK (asset_status IN (
      'pending',
      'uploaded',
      'ready',
      'quarantined',
      'orphaned',
      'delete_pending',
      'deleted'
    )),
  upload_expires_at timestamptz NOT NULL,
  uploaded_at timestamptz,
  verified_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_name, object_key),
  UNIQUE (storage_asset_id, content_version_id),
  CHECK (upload_expires_at > created_at),
  CHECK (
    asset_status <> 'ready'
    OR (
      verified_content_type IS NOT NULL
      AND verified_byte_size = declared_byte_size
      AND verified_at IS NOT NULL
    )
  ),
  CHECK (asset_status <> 'deleted' OR deleted_at IS NOT NULL)
);

CREATE INDEX storage_assets_owner_created_idx
  ON storage_assets (owner_user_id, created_at DESC, storage_asset_id DESC);

CREATE INDEX storage_assets_content_status_idx
  ON storage_assets (content_version_id, asset_status, created_at DESC);

CREATE INDEX storage_assets_pending_cleanup_idx
  ON storage_assets (upload_expires_at, storage_asset_id)
  WHERE asset_status IN ('pending', 'uploaded');

CREATE INDEX storage_assets_orphan_cleanup_idx
  ON storage_assets (updated_at, storage_asset_id)
  WHERE asset_status IN ('orphaned', 'delete_pending');

ALTER TABLE content_versions
  ADD COLUMN storage_asset_id uuid;

ALTER TABLE content_versions
  ADD CONSTRAINT content_versions_storage_asset_fk
  FOREIGN KEY (storage_asset_id, content_version_id)
  REFERENCES storage_assets(storage_asset_id, content_version_id)
  ON DELETE RESTRICT;

-- A primary content-version file is not shared by several versions.
CREATE UNIQUE INDEX content_versions_storage_asset_uq
  ON content_versions (storage_asset_id)
  WHERE storage_asset_id IS NOT NULL;

-- 003 revoked default grants. New objects require explicit least-privilege grants.
REVOKE ALL PRIVILEGES ON TABLE storage_assets
  FROM PUBLIC, colearnx_app, colearnx_migrator, colearnx_readonly;

GRANT SELECT, INSERT ON TABLE storage_assets TO colearnx_app;

GRANT UPDATE (
  verified_content_type,
  verified_byte_size,
  etag,
  checksum_sha256,
  asset_status,
  uploaded_at,
  verified_at,
  deleted_at,
  updated_at
) ON TABLE storage_assets TO colearnx_app;
```

### DDL 说明

- `storage_asset_id` 为应用内部引用；R2 bucket/key 是外部稳定定位信息。
- `object_key` 由 API 生成，不接受浏览器指定的完整 key；不要将原始文件名直接作为 key。
- `content_version_id` 在 upload intent 创建时写入，使尚未 ready 的上传尝试也能与目标草稿建立稳定关系；复合外键保证当前主资产只能关联回同一个 content version，API 仍须验证该版本的 Creator 所有权。
- `declared_*` 来自上传意图，不能视为可信事实；`verified_*` 必须由 API 在上传完成后通过 R2 `HeadObject` 复核后写入。`verified_content_type` 表示 R2 中保存的 HTTP metadata 已核对，不代表已完成文件魔数识别或病毒扫描。
- `pending → uploaded → ready` 是正常流程；不合法对象进入 `quarantined`；过期上传进入 `orphaned`；待物理删除对象进入 `delete_pending`，R2 删除确认后才进入 `deleted` 并设置 `deleted_at`。
- `content_versions.storage_asset_id` 保持可空，旧行继续使用 `storage_url`。新 API 读取时应优先使用 `storage_asset_id`，仅对旧记录回退到 `storage_url`。
- FK 使用 `ON DELETE RESTRICT`，防止删除元数据后留下悬空的内容版本。
- 唯一索引规定一个主文件资产最多挂到一个内容版本。若产品将来确认需要同一对象复用，应通过新的 forward migration 调整，不要事后修改 `005`。
- `colearnx_app` 没有 `DELETE` 权限，正常删除应是受审计的状态更新；物理清理由 Owner 控制的维护任务处理。
- 此设计不在数据库中硬编码产品上传上限。API 应按业务类型限制大小；数据库只保证大小为正数。

## 5. 最小权限要求

### 长期运行账号 `colearnx_app`

Render API 继续只使用受限的 `DATABASE_URL=colearnx_app`：

- 可 `SELECT`、`INSERT` `storage_assets`。
- 仅可更新状态核验相关字段。
- 不可修改已创建记录的 `owner_user_id`、`bucket_name`、`object_key`、声明大小或声明类型。
- 不授予 `DELETE`、`TRUNCATE`、DDL、schema `CREATE`、`schema_migrations` 访问权。

### `colearnx_migrator`

`003` 已将该遗留登录收紧。本轮不要重新授予它宽泛 DDL/对象权限，也不要通过 `005` 恢复其表访问。

### Owner migration 连接

迁移必须使用 Neon Owner 的受控 **direct/unpooled** 连接，仅在迁移窗口临时使用。该连接不应配置为 Render 长期运行的 `DATABASE_URL`。

## 6. 兼容部署顺序

采用 expand-and-contract，确保任一步失败时旧功能仍可用：

1. 后端/数据库同学提交新的 `005_object_storage.sql`；不修改 `001–004`。
2. 在本地只读审查 migration，并通过 API typecheck、test、build。
3. 在 Neon 为当前 staging 主分支创建迁移前快照/分支，例如：
   `snapshot-before-object-storage-005-YYYYMMDD-HHMM`。
4. 使用 Neon Owner direct/unpooled 连接执行 `npm run db:migrate`。
5. 验证 `001–005` ledger、表、列、约束、索引和权限；确认现有 API `/health/ready` 仍为 200。
6. 在 Render Secrets 中配置 R2 运行参数。只保存 key/secret，不放入 Cloudflare Pages：
   - `R2_ACCOUNT_ID`
   - `R2_BUCKET_NAME`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - 可选 `R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
7. 部署向后兼容的 Render API：新写入使用 `storage_assets`，旧记录仍回退到 `storage_url`。
8. 验证 API 后再部署 Cloudflare Pages 上传 UI。
9. 在 `https://staging.colearnx.net` 做上传、完成核验、授权下载、拒绝越权和过期 URL 的端到端测试。
10. 等所有 legacy 数据有明确迁移方案后，再单独设计后续 migration；本轮不做 contract/delete。

前端的 API base URL 必须继续指向：

```text
https://api-staging.colearnx.net/api/v1
```

## 7. 安全执行 migration

在 `colearnx-v1.0` 根目录执行：

```powershell
npm --prefix apps/api ci --include=dev
npm run api:typecheck
npm run api:test
npm run api:build
npm test
npm run build
```

迁移环境只提供：

```text
MIGRATION_DATABASE_URL=<Neon Owner direct/unpooled connection>
DATABASE_SSL=true
```

然后执行：

```powershell
npm run db:migrate
```

注意：

- 不把连接串直接写进命令历史、`.env`、GitHub Actions 日志或聊天。
- 不使用 Render 长期运行的 `colearnx_app` 连接执行 DDL。
- 不运行 `db:seed`，`005` 不需要 seed。
- 不运行 `pg_restore --clean`、DROP、TRUNCATE 或任何重建数据库命令。
- migration runner 会在单个事务中执行文件并记录 SHA-256 checksum；失败会回滚。

## 8. 快照、验证与回滚策略

### 执行前

1. 创建 Neon 分支/快照并记录 branch name、branch ID、创建时间及基线 commit。
2. 保存迁移前只读证据：
   - `cloud-schema.sql`：schema-only、no-owner、no-privileges。
   - `cloud-migrations.txt`：migration ledger。
   - `cloud-privileges.txt`：public schema 表权限。
3. 确认 Render API 当前 `/health/live`、`/health/ready` 均为 200。

### 执行后

- 保留 `npm run db:migrate` 的非敏感输出，例如 `Applied 005_object_storage.sql`。
- 执行第 10 节中的只读查询。
- 用 `colearnx_app` 做最小权限验证，确认它能运行 API 所需 DML，但不能 DROP/CREATE/DELETE `storage_assets`。
- 重新验证注册、登录、管理员、内容草稿等旧流程，确保 additive migration 没有回归。

### 回滚

- 如果 `005` 在事务内失败：migration runner 会回滚，不手工补写 `schema_migrations`。
- 如果迁移成功但新 API 有问题：优先关闭上传功能并重新部署上一版 API。旧 API 不读取新表/列，因此 schema 可以安全保留。
- 不删除 `005`、不改 checksum，也不立即 DROP 表/列。若确实需要数据库修正，应新增 forward migration。
- 只有在确认快照之后没有需要保留的新业务写入时，才考虑 Neon 分支恢复/切换。恢复快照会丢失快照后的写入，执行前必须另行审批和核对。
- 已经产生新写入时，不直接恢复整个数据库；先导出/对账受影响记录，再制定 forward repair。

## 9. 数据保留与孤儿对象

- `content_versions` 引用资产后，元数据不得物理删除；使用 `deleted` 状态保留审计链。
- 对象物理删除与数据库状态更新必须由幂等维护流程执行，并留下非敏感审计记录。
- `pending/uploaded` 超过 `upload_expires_at` 且未关联 `content_versions` 的记录可标记为 `orphaned`。
- 清理任务先根据数据库确定候选，再通过 R2 `HEAD/DELETE` 处理；不能仅凭 bucket list 推断业务归属。
- 业务关联先解除并把记录改为 `delete_pending`，从而立即停止签发下载 URL；R2 删除成功后再改为 `deleted` 并写 `deleted_at`，失败应保持 `delete_pending` 供安全重试。
- R2 可配置未完成 multipart upload 的终止规则；普通单次 PUT 产生的孤儿对象仍必须由数据库候选查询与应用维护任务对账清理，不能只依赖 bucket lifecycle。
- 对 quarantined 文件禁止签发下载 URL，并按团队安全/隐私保留政策定期清理。
- Presigned URL 到期不是对象删除；数据库记录和 R2 对象生命周期需分别管理。

## 10. 迁移后只读验证查询

### 10.1 migration ledger

```sql
SELECT filename, checksum, applied_at
FROM schema_migrations
ORDER BY filename;
```

预期看到 `001`、`002`、`003`、`004`、`005_object_storage.sql`，且旧 checksum 未变化。

### 10.2 表和列

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'storage_assets';

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('storage_assets', 'content_versions')
ORDER BY table_name, ordinal_position;
```

### 10.3 外键、约束和索引

```sql
SELECT conrelid::regclass AS table_name,
       conname,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('storage_assets'::regclass, 'content_versions'::regclass)
ORDER BY table_name::text, conname;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('storage_assets', 'content_versions')
ORDER BY tablename, indexname;
```

### 10.4 运行账号权限

```sql
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'storage_assets'
ORDER BY grantee, privilege_type;

SELECT grantee, privilege_type, column_name
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'storage_assets'
ORDER BY grantee, privilege_type, column_name;
```

预期 `colearnx_app` 只有本文件明确授予的权限；`PUBLIC`、`colearnx_migrator`、`colearnx_readonly` 没有该表权限。

### 10.5 数据质量和兼容性

```sql
-- ready 行必须有已核验类型、匹配的大小和核验时间。
SELECT count(*) AS invalid_ready_assets
FROM storage_assets
WHERE asset_status = 'ready'
  AND (
    verified_content_type IS NULL
    OR verified_byte_size IS NULL
    OR verified_byte_size <> declared_byte_size
    OR verified_at IS NULL
  );

-- 不应把 URL 或临时签名误存为 object_key。
SELECT storage_asset_id, object_key
FROM storage_assets
WHERE object_key ~* '^https?://'
   OR object_key ILIKE '%X-Amz-Signature%';

-- 超时且尚未被内容版本引用的候选孤儿。
SELECT sa.storage_asset_id, sa.asset_status, sa.upload_expires_at
FROM storage_assets sa
LEFT JOIN content_versions cv
  ON cv.storage_asset_id = sa.storage_asset_id
WHERE cv.content_version_id IS NULL
  AND sa.asset_status IN ('pending', 'uploaded')
  AND sa.upload_expires_at < now()
ORDER BY sa.upload_expires_at;

-- 已关联资产的 owner 应与内容 creator 一致；由 API 写入时保证。
SELECT cv.content_version_id,
       sa.storage_asset_id,
       sa.owner_user_id,
       c.creator_user_id
FROM content_versions cv
JOIN storage_assets sa
  ON sa.storage_asset_id = cv.storage_asset_id
JOIN contents c
  ON c.content_id = cv.content_id
WHERE sa.owner_user_id <> c.creator_user_id;

-- 当前主资产必须属于同一个 content version。
SELECT cv.content_version_id,
       cv.storage_asset_id,
       sa.content_version_id AS asset_content_version_id
FROM content_versions cv
JOIN storage_assets sa
  ON sa.storage_asset_id = cv.storage_asset_id
WHERE sa.content_version_id <> cv.content_version_id;

-- 旧 storage_url 行必须继续可识别，不要求本轮回填。
SELECT count(*) AS legacy_storage_url_rows
FROM content_versions
WHERE storage_url IS NOT NULL
  AND storage_asset_id IS NULL;
```

`invalid_ready_assets`、误存 URL/签名和 owner 不一致查询的异常结果应为 0；孤儿候选查询允许暂时有结果，但必须进入幂等清理队列；最后一个 legacy 计数允许大于 0。

## 11. 数据库验收场景

1. `schema_migrations` 按顺序包含 `001`–`005`，旧 migration checksum 未变化。
2. `005` 只新增表、列、约束、索引和权限，不修改或删除现有用户、订单、角色和迁移记录。
3. `storage_assets.content_version_id`、`owner_user_id` 及 `content_versions.storage_asset_id` 外键有效。
4. 同一 `(bucket_name, object_key)` 不能重复，`object_key` 不能存 URL 或预签名参数。
5. `ready` 记录必须同时具备核验后的类型、大小和 `verified_at`，且核验大小等于声明大小。
6. `deleted` 记录必须具备 `deleted_at`；过期 pending/uploaded 记录能够被清理查询定位。
7. `colearnx_app` 可以执行 API 所需的 SELECT、INSERT 和列级 UPDATE，但不能 DELETE、CREATE、DROP 或修改稳定定位字段。
8. `PUBLIC`、`colearnx_migrator`、`colearnx_readonly` 对新表没有额外权限。
9. 旧 `storage_url` 行保持原样，`storage_asset_id` 可以为空，不要求本轮回填。
10. 测试上传产生的资产 owner 与内容 Creator 一致，关联的 `content_version_id` 与 `content_versions.storage_asset_id` 不矛盾。
11. 迁移后 `/health/ready` 和现有注册、登录、管理员及内容草稿流程无回归。

## 12. 数据库同学需要交付

- 新增且经评审的 `db/migrations/005_object_storage.sql`。
- 证明 `001–004` 文件及其 checksum 未修改。
- migration 前 Neon 快照名称、branch ID、时间和基线 commit。
- `npm run db:migrate` 的非敏感输出及 `schema_migrations` 查询结果。
- 迁移后 schema、约束、索引、权限验证结果。
- `storage_assets` 字段、状态转换、外键及 API 写入需求的差异说明（若最终 DDL 与本文建议不同）。
- orphan/quarantine/soft-delete 的数据库查询、维护边界和数据保留说明。
- 证明 `colearnx_app` 能完成所需 DML、但不能执行 DDL/物理删除的权限验证结果。
- 若发现最终模型与本文建议不同，提供差异说明、兼容性分析和新的 forward migration 计划。
