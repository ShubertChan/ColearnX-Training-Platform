# 第十周演示脚本

**准备。** 使用 `.node-version` 指定的 Node，在 `colearnx-v1.0` 安装 API 的锁定依赖：`npm --prefix apps/api ci --include=dev`。需要本机可执行的 `openssl` 和一套全新的 PostgreSQL 16 测试簇。已有 CI 会自动建库；也可用下列命令本地演示（示例为 Bash，口令仅用于回环地址上的临时容器）：

```sh
docker run -d --rm --name colearnx-w10-demo -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=week_fixture -e POSTGRES_PASSWORD=local-demo-only \
  -e POSTGRES_DB=colearnx_release_check_demo postgres:16
# 等 pg_isready 报 accepting connections 后再运行测试。
docker exec colearnx-w10-demo pg_isready -U week_fixture -d colearnx_release_check_demo
RELEASE_CHECK_DATABASE_URL=postgresql://week_fixture:local-demo-only@127.0.0.1:55432/colearnx_release_check_demo npm run release:database-test
```

在 Windows PowerShell 中，把同一个 URL 赋给 `$env:RELEASE_CHECK_DATABASE_URL`，再运行相同的 npm 命令。脚本不会清空已有数据库；再演示时启动新的测试簇。

| 时间 | 讲解与操作 | 观众应看到什么 |
|---|---|---|
| 0:00–1:00 | 指出 API、签名回调与数据库的边界，说明演示只用合成账号和订单。 | 没有生产令牌、付款或邮件投递。 |
| 1:00–2:00 | 找到 `W10 IDOR`、`W10 CSRF`。比较订单所有者和另一成员，再比较错误/正确 CSRF 组合。 | 订单所有者 200，其他成员 404；伪造请求 403，合法会话还能刷新。 |
| 2:00–3:00 | 展示 `W10 payment`、`W10 checkout`。说明为何即使签名正确，回调金额仍须匹配本地交易。 | 伪造金额未入账，正确事件重放不重复入账；并发重试返回同一笔订单。 |
| 3:00–4:00 | 打开生成的 `release-report/security-w10/rotation.json`，解释三次的计时起止。 | 旧节点接受由旧密钥签给新会话的伪造令牌，新节点拒绝；正常账号可重新登录并刷新。 |
| 4:00–5:00 | 对照[复评表](W10-security-design.md)，说明仍能枚举邮箱，以及 Cookie 策略何时可以收紧。 | 能分清已验证、待决策、尚未在真实环境演练的事项。 |

演示结束后，只停止本次创建的临时容器：`docker stop colearnx-w10-demo`。保存脱敏报告和该次 CI 链接即可；不截取 Cookie、令牌、签名密钥或验证码。
