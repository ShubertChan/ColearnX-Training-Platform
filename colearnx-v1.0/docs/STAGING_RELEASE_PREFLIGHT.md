# Staging：实际迁移预检与按变更发布

本轮只增强发布代码与测试，不修改业务数据、不执行云端 GRANT/migration、不创建或合并 PR 以外的发布权限。现有 staging 服务继续运行原版本。新工作流须由负责人合并 main，并补齐下列配置后才可运行。

## 1. 保留的审批边界

- PR/main 继续执行完整 CI，组件选择不会跳过测试、依赖审计或数据库集成测试。
- CD 仍然只有 `workflow_dispatch`，仅允许当前 main，staging Environment 审批/分支限制不变。
- `migrations_reviewed=true` 与准确的 `last_applied_migration` 仍必填。即使数据库实际检查通过，也不能绕过人工迁移审查。
- 工作流不迁移、不 seed、不清理 R2、不自动回滚数据库、不自动发布网关或本机 Docker。
- Render 与 Pages 仍非原子发布；不消除控制台并发变更的所有竞态，需要协调发布窗口。

## 2. 实际迁移检查

发布前、发布后各建立一次独立的 PostgreSQL 只读连接：

1. 连接目标必须是受保护变量 `STAGING_DATABASE_HOST` 指定的 Neon direct 主机，数据库固定 `colearnx`，账号固定 `colearnx_release_reader`。
2. 强制 TLS 证书验证、连接/查询/锁等待超时。单独解析连接串，拒绝覆盖 SSL、角色或会话参数的 URL 选项。
3. 使用 `REPEATABLE READ READ ONLY` 事务和 `pg_catalog` search_path；核对实际数据库、session/current user、默认只读模式、角色属性及权限。
4. 拒绝 Owner/超级用户、角色成员关系、DDL、对象所有权、表/字段写权限和序列写权限；应用账号无需获得迁移记录读取权限。
5. 只读取 `public.schema_migrations` 的 `filename, checksum, applied_at`。必须与仓库完整清单一一匹配，不只看最后一个编号。
6. checksum 复用迁移器的同一实现：兼容既有 LF/CRLF 和原有狭窄历史别名，不新增任意 checksum 豁免。
7. 保存迁移清单和 ledger 摘要；以 UTC 文本保留 PostgreSQL 的微秒级 applied_at，不经 JavaScript Date 截断。发布后要求摘要与发布前相同。报告不包含密码、连接串或业务用户数据。
8. 总是 ROLLBACK 并关闭会话。失败立即停止后续阶段，没有 Owner 回退或“忽略失败继续”。

这验证的是实际迁移记录，不是完整 schema drift 扫描，也不证明每个业务字段/运行时权限都未被人工更改。已有临时 PostgreSQL 集成测试仍保留。

## 3. 一次性配置（需负责人另行批准和执行）

GitHub → Repository Settings → Environments → staging：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `STAGING_DATABASE_READONLY_URL` | 专用 reader 的 direct/unpooled 连接，不能填 Owner、`colearnx_migrator` 或 `colearnx_app`。 |
| Variable | `STAGING_DATABASE_HOST` | 从现有 Neon staging 项目/分支核对的完整 direct hostname。 |
| Variable | `MEDIA_GATEWAY_DEPLOYED_SHA` | 已核对的网关实际源码提交，完整 40 位小写 SHA。 |
| Variable | `VIDEO_WORKER_DEPLOYED_SHA` | 已核对的本机转码服务实际源码提交，完整 40 位小写 SHA。 |

reader 不自动创建。下面仅是供 Owner 审查的最小权限模板，**本次开发不执行这些 SQL**。先确认数据库为现有 staging 的 `colearnx`；不要在已有同名角色上盲目覆盖权限，也不要直接使用 Neon UI 创建的高权限默认角色。

```sql
CREATE ROLE colearnx_release_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE colearnx TO colearnx_release_reader;
GRANT USAGE ON SCHEMA public TO colearnx_release_reader;
GRANT SELECT ON TABLE public.schema_migrations TO colearnx_release_reader;
ALTER ROLE colearnx_release_reader SET default_transaction_read_only = on;
```

负责人在安全的交互式管理会话设置随机密码（例如 psql 的 `\password colearnx_release_reader`，不要把明文密码写入 SQL 文件、Git、聊天或命令行参数），再受控执行 `ALTER ROLE colearnx_release_reader LOGIN;`。不授予其他角色成员身份、业务表读取、建表、写入或所有权。连接串仅保存在 staging Secret/团队密码库。

只读账号与 host 尚未配置时，旧版本依旧在线，但**新 CD 会按设计阻断**；不能用勾选人工确认替代实际检查。若现有数据库通过 PUBLIC 授予了写入/建表权限，应先评审权限修复，而不是降低预检标准。

## 4. 组件如何识别

不是比较 `HEAD~1`，也不是把一次上次发布的 SHA 当作所有组件版本。前端从 Cloudflare 项目元数据和公开 `release.json` 双重核对，API 从 Render 的只读部署历史获得唯一 Live 版本；分别对其基线到目标 main 执行完整祖先区间差异。

Git checkout 获取完整历史；`git diff --no-renames -z` 将改名视为删除+新增，避免跨组件移动漏判。基线不是目标祖先、历史缺失、未知服务、无效路径都停止，而不是猜测。

| 变更范围 | 默认处理 |
| --- | --- |
| React `src/`、`public/`、根前端依赖及 Vite 配置 | 发布 Pages，API 无相关变更则保留。 |
| `apps/api/` | 发布 API，前端字节一致且无相关变更则保留。 |
| CI/CD 脚本、发布工具和公开 staging 配置 | 保守重新发布前端与 API。 |
| `db/`、未知共享运行时文件 | 标记数据库及所有依赖组件，媒体部分要求独立人工审查。 |
| `apps/media-gateway/` | 明确标记网关待人工处理；不会误称已自动发布。 |
| `apps/video-worker/`、`deploy/local-video/` | 明确标记本机转码待人工处理；不操作 Docker。 |
| 明确的文档、集中测试目录 | 可以不重新发布；完整 CI、实际迁移校验和线上 smoke 仍运行。 |
| 未登记的新 `apps/<service>/` | 阻断，先增加受审组件规则。 |

媒体组件采用独立人工核对的基线变量；缺少变量不能推断“没变化”，会标记未知。检测到媒体变更或基线未知时，默认阻断。只有负责人已单独核对/部署相关组件及兼容性后，才可勾选 `external_components_reviewed`。该输入不是媒体实际发布成功的自动证明，也不会更新基线变量；负责人必须在实际部署后记录真实提交，本机有未提交补丁则仍需独立核查。

`force_web_release=true` 可以强制重新发布前端和 API，用于受控恢复/重新发布；不能绕过任何审批、实际迁移校验或媒体审查。

## 5. 保留旧组件为何不会误报冲突

例如只修改 API，Pages 可以保留旧提交。发布计划分别记录目标提交、前端实际保留提交、API 目标提交，不要求没有变化的组件伪装成新版本。

前端保留还要求本次 CI 产物与线上基线的完整文件哈希/公开配置相同，包括 `_headers` 等规则文件；发现构建或配置漂移会强制发布前端。最终 smoke 按计划验证其真实原提交和实际公共文件内容，不接受任意旧产物。

API 发布前必须与计划中的旧部署 ID/SHA 相同；被外部替换就中止。API 即使保留，也执行健康/CORS/匿名权限检查并核对实际 Render SHA。Pages 仍在发布前检查是否有竞争发布。迁移记录在最终阶段再次核对。

## 6. 测试与范围

- 模拟网络/数据库测试：正常与不完整 ledger、历史 checksum/CRLF、审批缺失、Owner/权限过大、TLS/连接目标错误、异常脱敏和关闭连接。
- 组件测试：前端单独发布、API 单独发布、不同组件的不同基线、多次合并区间、删除/改名、共享变更、文档-only、未知组件、基线缺失、产物漂移、竞争部署和手动强制发布。
- CI 工作流契约与 actionlint：保留手动触发、完整 CI、Environment、Secrets 隔离及发布阶段顺序。
- 隔离本地 PostgreSQL 16：建立合成 reader 登录，实际验证读 ledger、不能读用户/写 ledger/建表，迁移缺失、checksum 改动、字段级权限越权及 SELECT 权限丢失都会阻断；测试修改仅发生在受保护测试库并还原测试记录。

上述测试不等于已经创建 Neon reader、配置 GitHub Secret、完成一次真实 CD 或通过真实双账号退款/支付验收。合并与一次性配置后，仍需从 main 手动运行并审阅 Actions 报告。

参考：[PostgreSQL 只读事务](https://www.postgresql.org/docs/16/sql-set-transaction.html)、[node-postgres SSL 与连接串选项](https://node-postgres.com/features/ssl)、[GitHub 条件执行](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions)。
