# W8 实施说明与验收手册 —— 文件与内容安全

配套 `W2-threat-model.md`（发现登记册）与本次代码改动，说明**做了什么、为什么这样做、
怎么验证它确实生效**。未经验证的安全控制在报告里等于零。

W8 处置上传与下载链路上的三条发现，外加代码审查中新发现的一条越权问题。**不改数据库结构**：
`storage_assets` / `course_delivery_assets` 已有的 `quarantined` 状态与 `verified_content_type`
列就是为"内容核验"预留的，009 的 `security_events` 账本按 TypeScript 词表接收新事件类型。

| 编号 | 发现 | 本次处置 | 落点 |
|------|------|----------|------|
| F-09 | 上传只校验用户声称的类型，可执行文件改名 `.pdf` 即可通过（9 严重） | 上传完成时读取真实字节：文件头签名比对、可执行文件识别、`.docx` 结构与宏检查、ClamAV 病毒扫描；不符即隔离并删除 | `security/file-signature.ts`、`upload-inspection.ts`、`malware-scan.ts`、`storage/upload-verification.ts` |
| F-09b | 无 zip 炸弹防护（4 中） | 解析中央目录 + **真实解压计数**（流式、只计数不保留），按总量预算、压缩比、条目数、声明大小一致性拦截 | `security/zip-inspection.ts` |
| F-20 | 预签名下载链接可转发（4 中） | 每次签发下载链接写入 `content.download_issued` 账本；批量审计作业识别"同一账号同一文件多网络/高频签发"，记 `content.download_anomaly` | `security/download-audit.ts`、`download-audit-run.ts` |
| F-28（新） | 学员下载接口对 `admin` 角色放行，绕过管理员 MFA 与 step-up（6 高） | 普通下载/列表接口只对创作者本人放行；管理员只能走已受 MFA + step-up 保护的 `/admin/.../preview-url` | `storage/content-assets.ts` |

---

## 1. 设计约束（破坏了会静默失效）

### 1.1 看字节，不看声明

此前 `completeUploadIntent` 比对的是"意图里声明的 Content-Type"与"R2 HEAD 返回的
Content-Type"——而后者正是客户端 PUT 时自己填的请求头。两边都由上传者控制，等于没有校验。
W8 改为读取对象本身：

- `file-signature.ts` 只接受**锚定在偏移 0** 的签名（`%PDF-`、PNG、JPEG、WebP、`ftyp`、`PK`）。
  "文件里某处包含 %PDF" 的宽松规则会放过 PE/PDF 多格式混合文件（polyglot）。
- PE（MZ）、ELF、Mach-O、OLE 复合文件（.msi / 旧 Office 宏）、`#!` 脚本一律识别为可执行，
  **无论声明成什么类型**都拒绝，并记为单独的 `upload.executable_blocked`（3 高，会告警）——
  伪装的可执行文件是攻击信号，贴错扩展名的图片不是（`upload.type_mismatch`，2 中）。
- `.docx` 在线路上就是 zip，文件头无法区分，因此额外要求含 `[Content_Types].xml` 与
  `word/document.xml`，且**不得含 `vbaProject.bin`**（真正的 .docx 不能带宏，带宏的是 .docm）。

### 1.2 压缩炸弹：声明的大小不可信，以真实解压为准

中央目录里的大小是攻击者写的，只能做廉价的预筛。权威检查是**逐条目真实解压**，输出只计数、
立即丢弃（内存有界），一旦超过以下任一条件立即中止，因此炸弹最多让我们做"预算以内"的工作：

| 限制 | 默认值 | 拦截的攻击 |
|------|--------|-----------|
| 解压总量预算 | 512 MiB | 经典炸弹、重叠条目炸弹（多条中央目录指向同一份数据） |
| 压缩比（总量 > 10 MiB 后才生效） | 100 : 1 | 小文件高倍膨胀；小文本文件天然高压缩比，不误伤 |
| 实际解压量 ≠ 声明大小 | 严格相等 | 谎报头部以绕过预筛 |
| 条目数 | 10 000 | 海量空条目耗尽解压方资源 |
| 加密条目 / ZIP64 / 分卷 / 非 0、8 压缩方法 | 拒绝 | 无法检查的内容（不能扫描 = 不能放行） |
| `../`、绝对路径、盘符 | 拒绝 | Zip Slip：解压到目标目录之外 |
| 归档尾部附加数据 | 拒绝 | zip 与其他格式拼接的混合文件 |
| 条目为原生可执行文件（按内容）或 Windows 可执行扩展名 | 拒绝 | 合法 zip 里夹带 setup.exe |

编程课常见的 `.sh`、`.py`、`.js`、`.bat` **刻意不拦**，否则误伤正常课程资料；它们的内容仍经病毒扫描。

### 1.3 检查与送达之间不留缝隙（incoming/ → 正式 key）

预签名 PUT 链接在过期前（默认 600 秒）**一直有效**。如果"检查通过"后对象仍在原 key，
上传者完全可以先传干净文件、等校验通过，再用同一个链接把内容覆盖成恶意文件——所有检查形同虚设。

因此：浏览器上传到 `incoming/...`；检查**以 HEAD 时的 ETag 为条件**读取（`If-Match`），
保证检查的正是做过大小校验的那份字节；通过后**以同一 ETag 为条件**服务端复制到正式 key
（去掉 `incoming/` 前缀），数据库行改指向正式 key，再删除 incoming 对象。之后再用旧链接 PUT，
只会落到一个没有任何记录引用、永远不会被下发的 incoming key 上。W8 之前签发、尚未完成的上传
没有 `incoming/` 前缀，晋升时改用 `.verified` 后缀，同样与可写 key 分离。

### 1.4 检查在事务之外，完成流程拆成三步

检查要读取最多 `CONTENT_UPLOAD_MAX_BYTES` 的数据并可能等待 clamd。若在事务里做，就会长时间
占用连接池连接和行锁，几个并发上传就能拖垮整个 API。所以完成流程拆成：

1. 短事务：锁草稿、HEAD、大小比对（不一致即隔离，与原逻辑相同）
2. **无事务**：内容检查 + 晋升（`upload-verification.ts`），进程内信号量限制同时进行的检查数
   （`UPLOAD_INSPECTION_CONCURRENCY`，默认 2）以约束内存
3. 短事务：重新加锁，**确认该行仍是被检查的那条 pending 记录**（状态与 object_key 都未变），
   再提交 ready 或 quarantined；若并发的另一次完成已提交 ready，直接返回 ready

### 1.5 失败即关闭（fail closed）

启用扫描后，clamd 不可达、超时、返回任何非 `OK` / `FOUND` 的结果（包括
"INSTREAM size limit exceeded"）都按**扫描器不可用**处理：返回 503 `UPLOAD_SCAN_UNAVAILABLE`，
资产保持 pending，创作者稍后点"重试"即可；同时记一条 `upload.scan_unavailable`（2 中）。
绝不会"扫不了就放行"。这与第三周"诱饵失败要降级、服务存活是底线"的原则不冲突：
这里降级的是**单次上传完成**，API 其余功能完全不受影响。

### 1.6 拒绝原因只进账本，不告诉客户端

被拦截时客户端只收到统一的 422 `UPLOAD_CONTENT_REJECTED`"该文件未通过安全检查"。
具体是哪项检查命中（类型不符 / 可执行 / 炸弹 / 病毒名）只写入 `security_events` 的
`rule_hits` 与 `context_json`。把命中原因回显给客户端，等于给攻击者一个免费的"绕过检测"试错接口。

### 1.7 恶意样本在运行时生成，仓库里没有真实载荷

`malicious-samples.test-support.ts` 在内存中构造全部样本（伪装 PE、EICAR、压缩炸弹、重叠条目炸弹、
谎报大小、加密、路径穿越、带宏 .docx……），从不落盘。EICAR 字符串由反转的字面量拼出，
**源码文件本身不含连续签名**——否则开发者电脑上的杀毒软件会把测试文件从工作区隔离掉。

### 1.8 下载审计是"检测"，不是"拦截"

与 W7 风控同一立场：一家人在家里电脑和手机上下载同一份资料，不应被一条猜测规则锁死。
签发记录与异常事件进入 W6 安全看板，由运营判断。异常事件固定为 2 中（不触发告警），
这样无人值守的作业不依赖告警通道即可正常退出。

---

## 2. 运行方式与配置

```bash
# 本地启动 ClamAV（首次需下载数百 MB 病毒库，约几分钟后才可用）
docker compose --profile scan up -d clamav
# API 侧启用扫描（apps/api/.env）
UPLOAD_MALWARE_SCANNER=clamav
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310

# 下载链接审计（建议每日）：窗口可用 DOWNLOAD_AUDIT_WINDOW_HOURS 调整，默认 24
npm --prefix apps/api run security:download-audit
```

| 变量 | 默认 | 说明 |
|------|------|------|
| `UPLOAD_MALWARE_SCANNER` | `disabled` | `clamav` 启用扫描。**production 必须为 `clamav`，否则拒绝启动**；staging 可暂不启用（签名与归档检查照常生效），见第 4 节决策项 |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `127.0.0.1` / `3310` | clamd 地址。clamd 无认证，只能在内网/本机回环暴露 |
| `CLAMAV_TIMEOUT_MS` | `30000` | 单次扫描超时，超时按不可用处理（fail closed） |
| `UPLOAD_INSPECTION_CONCURRENCY` | `2` | 单进程同时检查数，约束内存 |

`deploy/clamav/clamd.conf` 把 `StreamMaxLength` 提到 110M：clamd 默认 25 MB，低于 100 MB 的视频上限，
否则所有大视频都会被判为"扫描不可用"。官方镜像不读 `CLAMD_CONF_*` 环境变量，必须挂载配置文件。

**R2 生命周期规则（部署时一次性配置）：** 在 R2 桶上为前缀 `incoming/` 设置"创建 1 天后删除"。
正常流程下 incoming 对象在完成时就被删除；该规则清理的是被放弃的上传和第 1.3 节所述的过期前重复 PUT。

**无数据库迁移。** 新事件类型由 `taxonomy.ts` 约束，009 的 CHECK 只校验格式。

---

## 3. 验证步骤

### 3.1 自动化（已纳入 `npm --prefix apps/api test`）

| 测试文件 | 覆盖 |
|----------|------|
| `security/upload-inspection.test.ts` | 恶意样本集全部被拦截：改名 PDF/PNG/MP4/ZIP/DOCX 的 PE；HTML 冒充 PNG；EICAR（PDF 内、zip 内）；zip 内夹带 .exe（按扩展名、按内容）；比例炸弹；重叠条目炸弹（声明总量 + 谎报大小两种）；预算耗尽；加密、路径穿越、盘符、尾部附加、截断；带宏/非 Word 的 .docx。合法 PDF/PNG/zip/docx/视频通过；视频不整体缓冲；扫描器故障向上抛出（fail closed） |
| `security/malware-scan.test.ts` | 与模拟 clamd 走真实 INSTREAM 协议：分块、干净、EICAR 命中；拒连、超时、提前断开、超限报错均判为不可用。设置 `CLAMAV_TEST_HOST` 时额外对真实 clamd 跑 EICAR |
| `storage/course-delivery.test.ts` | 三步完成流程：通过后指向晋升 key 并删除 incoming；拒绝时隔离 + 删除 + 通用 422 且不泄露原因；扫描器不可用时保持 pending；检查期间行被替换则不置 ready |
| `security/download-audit.test.ts` | 规则阈值与评分；作业逐条发事件、统计写入失败数 |
| `storage/r2.test.ts` | 新上传 key 位于 `incoming/`；晋升 key 与可写 key 分离（含旧 key） |
| 前端 `src/api/uploads.test.js` | 三个新错误码映射为固定、可翻译、不泄露原因的提示 |

### 3.2 staging 手工验收

用一个已认证的创作者账号，在内容编辑器上传：

1. 把任意 `.exe` 改名为 `notes.pdf` 上传 → 界面显示"该文件未通过安全检查"；
2. 上传正常 PDF → 显示"已上传"，学员可下载；
3. （启用 clamd 后）上传内容为 EICAR 测试串、扩展名 `.pdf` 的文件 → 同样被拦截；
4. 在数据库确认（只读账号即可）：

```sql
SELECT occurred_at, event_type, severity, decision, rule_hits, context_json
  FROM security_events
 WHERE event_type LIKE 'upload.%' OR event_type LIKE 'content.%'
 ORDER BY occurred_at DESC LIMIT 20;
-- 期望：步骤 1 为 upload.executable_blocked（severity 3, decision deny, rule_hits {executable_disguised}）
--       步骤 3 为 upload.malware_detected（severity 4）
--       学员下载产生 content.download_issued（severity 0）

SELECT asset_status, object_key FROM storage_assets ORDER BY created_at DESC LIMIT 5;
-- 期望：被拦截的为 quarantined；通过的为 ready 且 object_key 不以 incoming/ 开头
```

5. 用管理员账号直接调用 `POST /api/v1/content-versions/<已发布 id>/download-url` → 403
   `CONTENT_ACCESS_DENIED`（F-28）；管理员预览仍走后台审核界面（需 MFA + step-up）。

---

## 4. 残余风险与需要团队决策的事项

- **staging 的 clamd 部署（决策）：** staging API 在 Render 上，clamd 需作为 Render 私有服务
  （private service，`clamav/clamav:1.4` 镜像 + 上面的 `clamd.conf`）部署，并把
  `CLAMAV_HOST` 指向其内网地址。部署之前 staging 以 `UPLOAD_MALWARE_SCANNER=disabled` 运行：
  签名、可执行、归档、宏检查**全部生效**，只缺病毒库比对。
- **R2 生命周期规则（部署清单）：** 见第 2 节，需在 Cloudflare 控制台配置一次。
- **链接在有效期内仍可转发（F-20 残余）：** 预签名 URL 是持有者凭据，R2 不回调 API，
  有效期内（`R2_SIGNED_DOWNLOAD_TTL_SECONDS`，默认 300 秒）的转发无法阻止，只能缩短 TTL 与事后审计。
  真正的"使用审计"需要 R2 访问日志（Cloudflare Logpush），超出本周范围。
- **嵌套归档只检查一层：** 外层 zip 由我们逐条目解压检查；内层压缩包的再展开交给 clamd
  （`MaxRecursion 16`、`MaxScanSize 512M`）。未启用 clamd 时内层不展开，但其解压体积仍计入外层预算。
- **托管视频（分片上传）链路不在本次范围：** `video/` 的 multipart 源文件进入转码流水线，
  由 ffmpeg 解析失败即拒绝；W8 覆盖的是课程附件与内容资产这两条可直接下载的链路。
- **代码审查中发现、未在本 PR 处置的问题**（另见 PR 说明）：刷新令牌无宽限窗口导致慢网络重试被判为盗用、
  并发请求可超出锁定阶梯的猜测次数、未验证邮箱可被抢注。这三项需要团队对交互影响做决策。

---

## 5. 改动清单

新增：`security/file-signature.ts`、`zip-inspection.ts`、`malware-scan.ts`、`upload-inspection.ts`、
`download-audit.ts`、`download-audit-run.ts`、`storage/upload-verification.ts`、
`deploy/clamav/clamd.conf`、测试样本 `security/malicious-samples.test-support.ts` 及四个测试文件。

修改：`storage/r2.ts`（incoming 前缀、ETag 固定读取、条件复制）、`storage/content-assets.ts`
（三步完成流程、下载签发审计、F-28）与 `storage/course-delivery.ts`（三步完成流程、下载签发审计）、`security/taxonomy.ts`
（7 个事件类型）、`config/env.ts`、`apps/api/.env.example`、`compose.yaml`、`apps/api/package.json`
（`security:download-audit`）、前端 `src/api/uploads.js` 与 `src/i18n/zh-CN.json`。
