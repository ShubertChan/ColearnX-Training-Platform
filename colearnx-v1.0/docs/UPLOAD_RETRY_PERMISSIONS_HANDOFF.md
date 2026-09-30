# 上传重试权限修复：部署交接

## 原因及修改范围

过期上传重试会更新已有记录的 `upload_expires_at`。旧迁移 005/008
没有为运行账号 `colearnx_app` 授予该列的 UPDATE 权限，因此返回数据库
`42501`，接口表现为 HTTP 500。

新增 `db/migrations/018_upload_retry_expiry_permissions.sql`，只授予：

- `public.storage_assets.upload_expires_at` 的 UPDATE 权限。
- `public.course_delivery_assets.upload_expires_at` 的 UPDATE 权限。

不修改已执行迁移；不更新业务数据；不授予整表 UPDATE、DELETE、DDL 或
转授权权限；不更改已有配额和上传数量限制。

## 部署步骤

1. 合并本次修复，并按现有流程准备数据库恢复点。
2. 在受控部署环境中配置 Owner **直连/非池化**连接作为
   `MIGRATION_DATABASE_URL`，并设置 `DATABASE_SSL=true`。
   不要使用 `colearnx_app` 或缺少对象所有权的 `colearnx_migrator` 执行迁移；
   不要把 Owner 凭据配置为 API 运行连接。
3. 在 `colearnx-v1.0/apps/api` 执行 `npm run db:migrate`。
   已执行的旧迁移应被校验并跳过，新日志应包含：
   `Applied 018_upload_retry_expiry_permissions.sql`。
4. API 的 `DATABASE_URL` 继续使用受限的 `colearnx_app`。
   权限变更对现有数据库连接生效；此次没有额外前端代码或环境变量变更。
5. 用普通 Creator/Trainer 账号分别重试过期的内容文件和课程附件。
   预期重试成功、仍为同一上传记录、配额不重复增加。

可由部署同学在受控环境执行以下只读核对（均应为 `true`）：

```sql
SELECT
  has_column_privilege('colearnx_app', 'public.storage_assets',
    'upload_expires_at', 'UPDATE') AS content_expiry_update,
  has_column_privilege('colearnx_app', 'public.course_delivery_assets',
    'upload_expires_at', 'UPDATE') AS course_expiry_update;
```

仅发布应用代码不能替代数据库迁移；无需重新 seed、清空文件记录或提高配额。

## 回归测试

在新的、可丢弃的本地 PostgreSQL 16 数据库中，配置
`RELEASE_CHECK_DATABASE_URL`，数据库名必须以 `colearnx_release_check_` 开头。
在 `apps/api` 执行 `npm run test:integration:upload-retry`。

此脚本拒绝远程数据库、非测试集群和非空数据库，隔离 `.env`/云端配置，
不删除任何既有数据。它应用真实迁移 001–017，以随机密码创建真实受限
`colearnx_app` 登录，通过真实 API 复现迁移前的失败，再用实际迁移运行器
应用 018，验证：

- 内容文件和课程附件各连续续期 6 次，始终为同一 asset。
- 两个 100 MiB 文件合计仍占用 200 MiB，剩余 300 MiB 可用。
- 只新增指定的两列权限，原权限及迁移记录保持不变。
- Owner/声明大小等无关列、整表更新、删除、DDL 仍被禁止。
- 重复运行迁移不再执行 SQL；已上传文件重试不会生成新上传链接。

数据库和认证均为真实执行；签名只使用占位测试凭据在本地计算，
外部对象存储和其他云端请求被禁止。测试数据库只包含合成数据，
应随独立测试容器一同清理。
