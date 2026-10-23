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
| 解压总量预算 | 512 MiB | 经典炸弹 |
| 单个条目解压上限 | 100 MiB | 低于 clamd 的 `MaxFileSize`（110M）。超过 clamd 上限的文件会被 clamd **跳过并照样回答 OK**，必须在我们这一侧挡住 |
| 压缩比（总量 > 10 MiB 后才生效） | 100 : 1 | 小文件高倍膨胀；小文本文件天然高压缩比，不误伤 |
| 实际解压量 ≠ 声明大小；CRC-32 不符 | 严格相等 | 谎报头部以绕过预筛 |
| 条目数 | 10 000 | 海量空条目耗尽解压方资源 |
| 加密条目 / ZIP64 / 分卷 / 非 0、8 压缩方法 | 拒绝 | 无法检查的内容（不能扫描 = 不能放行） |
| `../`、绝对路径、盘符 | 拒绝 | Zip Slip：解压到目标目录之外 |
| 归档尾部附加数据 | 拒绝 | zip 与其他格式拼接的混合文件 |
| 文件名以 `.` 或空格结尾、含 `:` | 拒绝 | Windows 解压时会把 `evil.vbs.` 改写成 `evil.vbs`，绕过扩展名检查；`:` 是 NTFS 备用数据流 |
| `.docx` 的 `[Content_Types].xml` 声明了 VBA / macroEnabled 类型 | 拒绝 | 把宏部件改名（不叫 `vbaProject.bin`）以绕过按文件名的检查 |
| 条目为原生可执行文件（按内容）或 Windows 可执行扩展名 | 拒绝 | 合法 zip 里夹带 setup.exe |

编程课常见的 `.sh`、`.py`、`.js`、`.bat` **刻意不拦**，否则误伤正常课程资料；它们的内容仍经病毒扫描
（单条目上限保证 clamd 一定会完整扫描它们）。zip 内的 OLE 文件（.doc/.xls、Word 内嵌对象）与 Java
`.class` 也不按"可执行"拦截——它们是正常资料，内容交给病毒扫描；只有 PE / ELF / Mach-O 原生程序按内容拒绝。

**一份归档只能有一种解读。** 不同解压工具信任的结构不同：流式解压（Java `ZipInputStream`、
部分浏览器预览）从前往后读**本地头**；unzip / 7-Zip / Windows 读**中央目录**；Info-ZIP 还会优先采用
"Unicode 路径"扩展字段里的另一个文件名。只检查其中一种视图，攻击者就能给其他工具准备另一份内容
（例如中央目录写 `readme.txt`、本地头写 `setup.vbs`，或在中央目录之外藏一个本地条目 `setup.exe`）。因此要求：
每个本地头的文件名字节、压缩方法、加密标志与中央目录**完全一致**；所有本地记录必须从偏移 0 起
**首尾相接、恰好铺满**到中央目录为止（无空隙、无重复偏移、无未登记条目——这也顺带挡住了"重叠条目炸弹"）；
中央目录必须恰好结束于结尾记录；带 Unicode 路径/注释扩展字段（0x7075、0x6375）的条目一律拒绝。

### 1.3 检查与送达之间不留缝隙（incoming/ → 正式 key）

预签名 PUT 链接在过期前（默认 600 秒）**一直有效**。如果"检查通过"后对象仍在原 key，
上传者完全可以先传干净文件、等校验通过，再用同一个链接把内容覆盖成恶意文件——所有检查形同虚设。

因此：浏览器上传到 `incoming/...`；检查**以 HEAD 时的 ETag 为条件**读取（`If-Match`），
保证检查的正是做过大小校验的那份字节；通过后**以同一 ETag 为条件**服务端复制到正式 key
（去掉 `incoming/` 前缀，并加上**本次尝试独有**的 `.v-<uuid>` 后缀），数据库行改指向正式 key，
再删除 incoming 对象。之后再用旧链接 PUT，只会落到一个没有任何记录引用、永远不会被下发的
incoming key 上。W8 之前签发、尚未完成的上传没有 `incoming/` 前缀，同样晋升到带后缀的新 key。

正式 key 每次尝试都不同，是为了**能安全地清理**：若第三步没有把这次的副本提交为 ready
（并发的另一次完成先提交了、草稿状态变了、行被删除了），这份副本就没有任何行引用，
立即删除即可，绝不会误删别的行正在下发的对象。否则这类副本会落在 `incoming/` 之外，
生命周期规则和对账都清理不到，还不计入配额，可被反复利用来无限占用存储。

### 1.4 检查在事务之外，完成流程拆成三步

检查要读取最多 `CONTENT_UPLOAD_MAX_BYTES` 的数据并可能等待 clamd。若在事务里做，就会长时间
占用连接池连接和行锁，几个并发上传就能拖垮整个 API。所以完成流程拆成：

1. 短事务：锁草稿、HEAD、大小比对（不一致即隔离，与原逻辑相同）
2. **无事务**：内容检查 + 晋升（`upload-verification.ts`），进程内信号量限制同时进行的检查数
   （`UPLOAD_INSPECTION_CONCURRENCY`，默认 2）以约束内存。释放的名额**直接交给**下一个等待者
   （计数不先减再加），否则新来的请求可能抢在被唤醒者之前进入，实际并发超过上限
3. 短事务：重新加锁，**确认该行仍是被检查的那条 pending 记录**（状态与 object_key 都未变），
   再提交 ready 或 quarantined；若并发的另一次完成已提交 ready，直接返回 ready

### 1.5 失败即关闭（fail closed）

启用扫描后，clamd 不可达、超时、返回任何非 `OK` / `FOUND` 的结果（包括
"INSTREAM size limit exceeded"）都按**扫描器不可用**处理：返回 503 `UPLOAD_SCAN_UNAVAILABLE`，
资产保持 pending，创作者稍后点"重试"即可；同时记一条 `upload.scan_unavailable`（2 中）。
绝不会"扫不了就放行"。这与第三周"诱饵失败要降级、服务存活是底线"的原则不冲突：
这里降级的是**单次上传完成**，API 其余功能完全不受影响。

clamd 默认会**跳过**超过其大小/深度上限的内容并仍回答 `OK`。`clamd.conf` 打开了 `AlertExceedsMax`，
此时 clamd 改报 `Heuristics.Limits.Exceeded`；API 把所有 `Heuristics.*` 结果（超限、OLE2 宏等）
视为"无法放行"而拒绝，但记为 `upload.archive_rejected`（2 中），**不**当作病毒记成 4 级告警。
只有真正的病毒特征码才记 `upload.malware_detected`。`AlertEncrypted` 关闭：加密 zip 已在我们这一侧
被拒绝，而普通的带权限密码的 PDF 不应被当成威胁。

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

# 一次性存量回扫（部署 W8 后执行）：检查 W8 之前就已是 ready 的文件
npm --prefix apps/api run security:upload-backfill            # 只报告，不改动
npm --prefix apps/api run security:upload-backfill -- --apply # 把不通过的文件置为 quarantined
```

**为什么需要回扫：** 上传完成时的检查只保护部署之后完成的上传。部署前就已上传、状态为 ready 的文件
（例如早就改名成 .pdf 的可执行文件）不会被重新检查，仍可下载。回扫作业对两张表中所有可下载的
ready 文件执行同一套检查。默认只报告并写入安全事件；确认影响范围后再加 `--apply` 隔离（只改状态，
对象保留供复核；隔离状态不会被下发）。有文件因存储或扫描器不可用而无法检查时，作业以非零码退出——
这些文件**没有**被判定为干净，必须重跑。

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

**没有数据库结构变更，但部署前必须执行权限迁移 `019_upload_promotion_permissions.sql`。**
W8 完成上传时会把数据库的 `object_key` 从 incoming key 改成检查通过后的正式 key；
005/008/018 没有授予这个字段的 UPDATE 权限。019 仅给 `colearnx_app` 在
`storage_assets.object_key` 和 `course_delivery_assets.object_key` 上增加列级 UPDATE，
不授予整表 UPDATE、转授权或 DDL 权限，不改已有文件记录，不修改历史迁移。
由部署人员确认后，在受控环境用 Neon Owner 的 direct/unpooled 连接执行 `npm run db:migrate`，
核对迁移账本包含 019 后才发布新 API；不要运行 seed 或导入本地数据库。
新事件类型仍由 `taxonomy.ts` 约束，009 的 CHECK 只校验格式。

---

## 3. 验证步骤

### 3.1 自动化（已纳入 `npm --prefix apps/api test`）

| 测试文件 | 覆盖 |
|----------|------|
| `security/upload-inspection.test.ts` | 恶意样本集全部被拦截（含独立审查给出的绕过样本：本地头/中央目录名称或压缩方法不一致、中央目录外的隐藏条目、Unicode 路径扩展字段、CRC 不符、`evil.vbs.` 等会被 Windows 改写的文件名、改名的宏部件、超过 clamd 扫描上限的单个条目）：改名 PDF/PNG/MP4/ZIP/DOCX 的 PE；HTML 冒充 PNG；EICAR（PDF 内、zip 内）；zip 内夹带 .exe（按扩展名、按内容）；比例炸弹；重叠条目炸弹（声明总量 + 谎报大小两种）；预算耗尽；加密、路径穿越、盘符、尾部附加、截断；带宏/非 Word 的 .docx。合法 PDF/PNG/zip/docx/视频通过；视频不整体缓冲；扫描器故障向上抛出（fail closed） |
| `security/malware-scan.test.ts` | 与模拟 clamd 走真实 INSTREAM 协议：分块、干净、EICAR 命中；拒连、超时、提前断开、超限报错均判为不可用。设置 `CLAMAV_TEST_HOST` 时额外对真实 clamd 跑 EICAR |
| `storage/course-delivery.test.ts` | 三步完成流程：通过后指向晋升 key 并删除 incoming；拒绝时隔离 + 删除 + 通用 422 且不泄露原因；扫描器不可用时保持 pending；检查期间行被替换则不置 ready |
| `security/download-audit.test.ts` | 规则阈值与评分；作业逐条发事件、统计写入失败数 |
| `security/upload-backfill.test.ts` | 存量回扫：dry run 不改动、分批翻页、`--apply` 只隔离不通过的文件、无法检查的文件不被当作干净 |
| `storage/upload-verification.test.ts` | 信号量在名额交接时不超限（旧实现可复现峰值 2/上限 1）；未提交的晋升副本被删除、已提交的不动 |
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
  （`MaxRecursion 16`、`MaxScanSize 600M`，超限即报告而非跳过）。未启用 clamd 时内层不展开，
  但其解压体积仍计入外层预算。
- **存量文件（决策/部署清单）：** 部署后需运行一次 `security:upload-backfill`（先 dry run，再 `--apply`），
  见第 2 节。未运行前，W8 之前上传的文件未经内容检查。
- **托管视频（分片上传）链路不在本次范围：** `video/` 的 multipart 源文件进入转码流水线，
  由 ffmpeg 解析失败即拒绝；W8 覆盖的是课程附件与内容资产这两条可直接下载的链路。
- **代码审查中发现、未在本 PR 处置的问题**（另见 PR 说明）：刷新令牌无宽限窗口导致慢网络重试被判为盗用、
  并发请求可超出锁定阶梯的猜测次数、未验证邮箱可被抢注。这三项需要团队对交互影响做决策。

---

## 5. 改动清单

新增：`security/file-signature.ts`、`zip-inspection.ts`、`malware-scan.ts`、`upload-inspection.ts`、
`download-audit.ts`、`download-audit-run.ts`、`upload-backfill.ts`、`upload-backfill-run.ts`、`storage/upload-verification.ts`、
`deploy/clamav/clamd.conf`、测试样本 `security/malicious-samples.test-support.ts` 及六个测试文件。

修改：`storage/r2.ts`（incoming 前缀、ETag 固定读取、条件复制）、`storage/content-assets.ts`
（三步完成流程、下载签发审计、F-28）与 `storage/course-delivery.ts`（三步完成流程、下载签发审计）、`security/taxonomy.ts`
（7 个事件类型）、`config/env.ts`、`apps/api/.env.example`、`compose.yaml`、`apps/api/package.json`
（`security:download-audit`）、前端 `src/api/uploads.js` 与 `src/i18n/zh-CN.json`。
