# CoLearnX v1.0 部署交接说明

## 1. 交接包是什么

colearnx-v1.0 是可以上传到 GitHub 的代码交接目录。它包含：

- React/Vite 前端与 Express/TypeScript API 源码；
- compose.yaml：启动 PostgreSQL 17 的 Docker 配置；
- db/init/：首次创建数据库角色；
- db/migrations/：完整、可重复执行的数据库结构迁移；
- .env.example、.env.compose.example、apps/api/.env.example：不含密钥的配置模板；
- API、数据模型与本地运行文档。

它**不包含** .env、apps/api/.env、真实密码、Stripe 密钥、node_modules、构建产物或当前数据库数据。

## 2. 数据库为什么不需要“把 Docker 发过去”

Docker 不是数据库文件本身。部署同学执行 docker compose up -d 时，Docker 会自行下载 postgres:17-alpine 并建立本机专用的数据卷 colearnx_pgdata。

数据库结构由以下链路重建：

~~~text
compose.yaml
  -> PostgreSQL 容器首次创建
  -> db/init/001-roles.sh 创建数据库角色
  -> npm run db:migrate 执行 db/migrations/*.sql
  -> npm run db:seed 创建参考数据、积分包和收益策略
~~~

因此应交付 Docker 配置与 SQL 迁移，而不是复制 Docker 容器、pgdata 卷或 pgAdmin 数据。新环境会获得相同的表、索引、约束与初始业务配置，但不会带走现有用户、支付、积分或密码哈希。

## 3. 部署前准备

部署机器需要：

1. Git；
2. Docker Desktop（Windows/macOS）或 Docker Engine + Docker Compose（Linux）；
3. Node.js 22 或更高版本；
4. GitHub 私有仓库访问权限。

克隆仓库后执行：

~~~powershell
git clone <PRIVATE_REPOSITORY_URL>
cd colearnx-v1.0
npm ci
npm --prefix apps/api ci
~~~

## 4. 创建环境变量

根目录 .env 同时被 Docker Compose 和 Vite 读取，因此要把两个模板合并：

~~~powershell
Copy-Item .env.compose.example .env
Get-Content .env.example | Add-Content .env
Copy-Item apps/api/.env.example apps/api/.env
~~~

### 根目录 .env

将下列密码替换为部署机器新生成的强密码：

~~~dotenv
POSTGRES_DB=colearnx
POSTGRES_ADMIN_USER=colearnx_owner
POSTGRES_ADMIN_PASSWORD=<新的数据库管理员密码>
COLEARNX_APP_PASSWORD=<新的 API 数据库密码>
COLEARNX_MIGRATOR_PASSWORD=<新的迁移角色密码>
COLEARNX_READONLY_PASSWORD=<新的只读角色密码>
~~~

建议数据库密码只使用字母、数字、下划线与连字符。若密码有 @、:、# 等字符，放进 PostgreSQL URL 时必须编码；例如 @ 必须写成 %40。

### apps/api/.env

至少更新以下项目：

~~~dotenv
NODE_ENV=development
APP_ORIGIN=http://localhost:5173
API_ORIGIN=http://localhost:3001
DATABASE_URL=postgresql://colearnx_app:<COLEARNX_APP_PASSWORD>@localhost:5433/colearnx
MIGRATION_DATABASE_URL=postgresql://colearnx_owner:<POSTGRES_ADMIN_PASSWORD>@localhost:5433/colearnx
DATABASE_SSL=false
ACCESS_TOKEN_SECRET=<至少32字符的新随机值>
REFRESH_TOKEN_SECRET=<至少32字符的另一随机值>
CSRF_SECRET=<至少32字符的另一随机值>
~~~

不要把这些值提交到 GitHub，也不要使用原开发电脑的数据库密码、JWT 密钥或 Stripe 密钥。

## 5. 启动数据库并重建结构

确认根目录 .env 已填写完毕后，首次启动：

~~~powershell
docker compose up -d
docker compose ps
npm run db:migrate
npm run db:seed
~~~

检查项目：

~~~powershell
npm run api:typecheck
npm run api:test
npm test
npm run api:build
npm run build
~~~

本地开发启动：

~~~powershell
npm run api:dev
npm run dev
~~~

浏览器打开 http://localhost:5173；API 就绪检查是 http://localhost:3001/health/ready。

重要：docker compose up -d 只启动 PostgreSQL，不会自动启动 API 或前端。并且 db/init/001-roles.sh 只会在数据库卷第一次创建时运行。数据库已创建后，单纯修改 .env 不会改变 PostgreSQL 中的密码。

生产机器绝不能执行 docker compose down -v，因为它会删除数据库数据卷。

## 6. 第一个平台管理员

应用的 Admin 与 PostgreSQL 超级管理员不是同一个概念：

- PostgreSQL 管理员：维护数据库基础设施；
- CoLearnX Admin：登录网页后管理用户、审核内容与运营平台。

应由平台负责人自己创建第一个 CoLearnX Admin：

1. 注册自己的应用账户；
2. 在 apps/api/.env 暂时添加：

~~~dotenv
BOOTSTRAP_ADMIN_EMAIL=<平台负责人的注册邮箱>
~~~

3. 执行 npm run db:seed；
4. 删除该环境变量并重启 API。

该变量只用于一次性授予 Admin 角色，不能长期保留。

## 7. 密码和密钥应由谁持有

**不要把现有开发电脑的 the_rising_sun 密码或网页管理员密码发给部署同学。**

部署同学应在目标服务器创建新的数据库密码与 JWT/CSRF 密钥；他只需将它们写进目标服务器的 .env。平台负责人应保管应用 Admin 自己的登录密码。

只有当部署同学同时负责数据库运维时，他才需要目标服务器新建的 PostgreSQL 管理员密码；应通过受控密码管理器或其他安全渠道传递，绝不能写入 GitHub、代码、截图或普通群聊。

运行 API 的账号是权限受限的 colearnx_app，不是 PostgreSQL 管理员账号。

## 8. Stripe 与正式域名

目前 MVP 仅允许 Stripe 测试模式。不要上传或复用开发电脑的 sk_test_...、pk_test_...、whsec_...。

获得域名和 HTTPS 后再配置：

- APP_ORIGIN=https://<你的域名>；
- API_ORIGIN=https://<你的 API 域名或同域路径>；
- COOKIE_DOMAIN=.<你的域名>；
- Nginx/Caddy 反向代理和 HTTPS；
- Stripe Dashboard 正式 webhook。

在没有域名和 HTTPS 前，应保持为本地或受控测试环境，不对公网开放登录和支付。

## 9. 是否需要导出现有数据库

默认不需要。当前数据库含有用户资料、密码哈希、会话、Stripe 测试事件和积分流水，不适合作为真实平台的初始数据。

若团队确实需要复现本地演示，请只由数据库负责人创建脱敏测试备份，并通过受控团队存储交付；数据库备份绝不上传 GitHub。
