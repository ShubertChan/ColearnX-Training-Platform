# 第九周 DevSecOps 流水线与验收

F-15 的流水线在测试前拦截密钥泄露、高危依赖、新增高危静态分析告警，以及任何严重（critical）静态分析告警。部署到预发后，ZAP 再检查实际服务。基线是 `main@483c02e`。该版本已经合并 Dependabot、每日依赖审计（PR #102）和 W2–W8 的主要安全功能；本周复用这些实现。

| 顺序 | 执行位置 | 什么会阻断 | 如何复核 |
|---|---|---|---|
| 1. Gitleaks | `.github/workflows/ci.yml` 的 `secrets` | 检出密钥或扫描命令失败 | 扫检出提交的历史，以及 `git archive HEAD` 的完整快照，后者包含仅存在于合并结果里的修改。输出脱敏。`.gitleaksignore` 仅列三个已人工复核的历史指纹，不豁免文件或目录。 |
| 2. npm audit、CycloneDX | 同一工作流的 `supply-chain` | 任一锁文件报告 high/critical、注册表不可用、审计报告不完整，或 SBOM 生成失败 | 前端、API、视频 worker、媒体网关、部署工具各一组。包含开发依赖，安装前读取锁文件；归档审计 JSON 和 `*.cdx.json`。 |
| 3. CodeQL | `sast` | JS/TS 分析失败、报告缺失、任一新增 high（≥ 7.0）或任一 critical（≥ 9.0） | 对基线和候选版本运行同一套 `security-extended` 查询；用规则、文件、行指纹和出现次数比对。两个完整 SARIF 随运行保存，PR 令牌只读。 |
| 4. 测试和构建 | `validate` | 任一测试、类型检查、生产构建或产物校验失败 | 复用原有 CI；临时 PostgreSQL 16、Redis 和 clamd 服务仅供该次运行。预发部署仍取本次验证生成的前端产物。 |
| 5. ZAP | `.github/workflows/deploy-staging.yml` 的 `dast` | 已部署站点不可达、配置为 FAIL 的规则命中、扫描器错误或缺失报告 | 预发发布成功后，分别扫描固定的前端入口和 API readiness URL。限时爬取，仅被动扫描，不带账号。强制 HSTS、CSP 和 MIME 嗅探防护；其他 WARN 保留在 HTML/JSON。 |

PR 不访问线上服务。ZAP 检查的是**这次部署之后**的预发版本；失败会把发布工作流标红，需要处理，但不自动回滚。按 SHA 和运行编号查找产物，保留 14 天。仓库保护规则里的“必需检查”由维护者配置；单靠 YAML 不会禁止管理员绕过合并。

## 此次 CI 实际保护了什么

| 周次与合并记录 | 通过什么观察退化 |
|---|---|
| W2–3：事件账本、账号加固（#53、#59） | `release-integration-check.mjs` 在真实 PostgreSQL 上验证失败计数与锁定、重置令牌一次性、弱口令拒绝、改密吊销会话、账本不可变；口令策略、指纹和诱饵失败分支另有单元测试。 |
| W4：TOTP、恢复码、二次确认和会话（#60、#63） | `mfa-session-checks.mjs` 走 Supertest：恢复码不可重放、账号锁定、管理员 MFA、跨会话 step-up 拒绝、刷新与吊销竞态。TOTP 算法另用标准向量验证。 |
| W5：分布式限流与边缘响应（#68） | 两个独立 Redis 客户端驱动两个 HTTP 限流实例，共用一个有过期时间的配额。真实找回密码路由第六次返回 429；伪造转发链前缀无法换配额，另一来源不受影响。核对 HSTS 和账本里的 HMAC 来源。 |
| W6：安全看板（#77） | 同一条 429 事件：普通成员和未绑定 MFA 的管理员不可读；绑定后仍需当前会话的 step-up 才能读取，且只得到来源指纹的短前缀。两个实例争抢同一条严重告警的通知权，Redis 只放行一个；另一个账号仍可告警。 |
| W7：资金风控与对账（#79、#80） | 合成自购、三笔购买后立即退款、七积分投影差额。运行生产风控和对账作业，校验自购命中、快速退款和高频退款合计 60 分，以及准确的七积分差额。作业不改余额。 |
| W8：上传与下载审计（#85、#87） | 两条真实上传完成路由拦截伪装 PDF、压缩炸弹、含 EICAR 的 ZIP，校验 422、数据库隔离、对象删除和拒绝事件。替代的只有对象存储；病毒判定由 clamd 完成。另从四个来源向已发布内容请求签名下载链接：草稿不签发，成功签发只记资产及来源指纹，第四个来源触发异常。直接使用 R2 链接仍需 R2 访问日志才能观察。 |

原计划与代码有差异：没有找到注册/登录/找回密码的 Turnstile 接入；当前 CSP 的 `script-src` 不允许内联脚本，但 `style-src` 仍允许内联样式。W7 的实际规则是自购、退款频率与快速退款，处置方式是记录风险，未实现原计划的跨账号撞库、不可能旅行、注册农场、充值频率或实时 challenge/deny。上述项目不能计入 W9 回归通过或 ASVS 达标。

## 静态分析：区分本周变化与历史欠项

2026-11-01 用 CodeQL CLI 2.27.2 分别扫描原始 `main@483c02e` 与本周代码。两个版本都报 114 条：111 条高危、3 条中危、0 条严重。111 条高危的规则、文件、行指纹和出现次数完全匹配，新增 0 条。既有高危继续出现在每次完整报告里，未做查询豁免。这次比对不代表这些问题已修复，也不是对 111 条告警的风险接受。

| 既有高危告警 | 人工复核入口 |
|---|---|
| 103 条缺少限流 | 102 条在 `apps/api/src/app.ts`，另 1 条在本地浏览器夹具。W5 实测验证了找回密码路由和 Redis 共享配额；仍要逐路由检查限流器顺序、额度和代理边界。 |
| 3 条口令散列 | 分别指向 MFA 质询签名、TOTP 存储密钥派生和泄露口令查询。复核输入来源、配置密钥的熵，以及查询摘要是否有被当作存储散列使用的路径。 |
| 2 条 CSRF / MFA 控制流 | `apps/api/src/app.ts`、`apps/api/src/auth/mfa/guards.ts`。分别核对 Cookie 生效的写路由，以及外来 step-up 头在签名、账号和活动会话绑定失败时是否一律拒绝。 |
| 3 条路径、随机数、正则 | 路径告警在本地视频浏览器夹具，正则在响应头测试；分别核对文件白名单和 URL 匹配。恢复码生成使用 32 个字符，32 整除 256；若字母表变化，要重新验证取模是否有偏。 |

另外 3 条中危分别位于部署预检、发布计划和前端支付请求。维护者可从两份 SARIF 查看逐条位置及数据流，再决定修复顺序。以后如需将所有既有高危也作为硬门槛，可单参数调用 `node scripts/deployment/codeql-gate.mjs <当前报告目录>`。

## 复跑与证据

从 `colearnx-v1.0` 使用 `.node-version` 指定的 Node 和锁文件。在此目录执行：

```sh
npm run security:audit -- --component api
npm run security:sbom -- api
npm run release:test
npm ci --include=dev
npm --prefix apps/api ci --include=dev
npm run api:test
```

数据库与服务组合的完整命令在 `ci.yml`：给 `release:database-test` 和 `test:integration:upload-retry` **分别**创建空的 `colearnx_release_check_*` 数据库。运行账号是测试簇的 owner，业务请求走限制权限的角色；不要使用共享库或已部署环境。上传验收指定 `CLAMAV_TEST_HOST=127.0.0.1`（默认 3310，可用 `CLAMAV_TEST_PORT` 指定本地端口）。Redis 测试只访问回环地址的 DB 15，键名随机且自动过期。

本机已在 Node 22.23.4、PostgreSQL 16 上运行：前端测试 188/188；发布脚本测试 145/145；API 测试 315/315（含 clamd 的 EICAR 用例）；主数据库验收 43 组；受限账号的上传及下载验收 16 组。Redis 实测了跨实例配额与告警去重。ClamAV 1.4.6 的本机测试库只加载 EICAR 验收签名，这验证调用链，不衡量完整签名库的查杀率。用 npm 10.9.9 审计五个锁文件，均无 high/critical；五份 CycloneDX 清单分别含 224（前端）、279（API）、103（视频 worker）、93（媒体网关）、105（部署工具）个组件。依赖结论只代表该次运行。ZAP 配置已通过工作流静态检查，实际预发结果需在部署后取得。

参考：[Gitleaks](https://github.com/gitleaks/gitleaks)、[npm SBOM](https://docs.npmjs.com/cli/v11/commands/npm-sbom)、[CodeQL JS/TS 查询](https://docs.github.com/en/code-security/reference/code-scanning/codeql/codeql-queries/javascript-typescript-built-in-queries)、[ZAP Baseline](https://www.zaproxy.org/docs/docker/baseline-scan/)。
