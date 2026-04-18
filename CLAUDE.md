# Claude / Cascade 开发指引

## 📌 项目定位

- **内网部署**、面向公司内部使用
- **单一认证模式**: 整个系统只有一把方舟 API Key, 通过 `ARK_API_KEY` 环境变量注入, 普通用户在前端看不到、无法修改
- **参考图片 = Base64**: 上传的图片由后端编码为 `data:image/xxx;base64,...` 内嵌在方舟请求体中, **无需公网 URL**
- **数据库 = 新鲜系统**: 没有旧数据兼容负担, schema 以 `schema.sql` 为权威

## 🗺️ 关键模块

| 文件 | 职责 |
|------|------|
| `server/services/arkConfig.js` | 从 env 读 `ARK_API_KEY`, 启动时 fail-fast 校验 |
| `server/services/arkVideoGenerator.js` | 方舟 REST 封装 + Base64 编码辅助 + 指数退避重试 + 独立轮询函数 |
| `server/services/batchScheduler.js` | 批量调度 (单 Key 并发) |
| `server/index.js` | Express 入口, 启动时 `resumePendingArkTasks()` 恢复未完成任务 |
| `server/database/schema.sql` | 权威 schema (没有 `jimeng_session_accounts` 表) |
| `src/pages/Settings.tsx` | 前端只读显示 API Key 是否已配置, 不提供录入 |

## 🔑 启动流程

1. `assertArkApiKeyOrExit()` — 缺少 key 直接 `process.exit(1)`
2. `initDatabase()` — 初始化 SQLite, 应用 `migrations/` 下的增量
3. Express 挂载路由
4. `app.listen(...)` 回调中 `resumePendingArkTasks()` — 扫描 `status='generating' AND submit_id IS NOT NULL` 的任务, 继续轮询

## ♻️ 重试 & 恢复机制

**API 层 (`arkFetch` in `arkVideoGenerator.js`)**:
- 重试条件: 网络错误 / `AbortError` / `ECONNRESET` / HTTP 429 / HTTP 5xx
- 不重试: HTTP 401 / 403 / 4xx 其他 (参数错/认证错)
- 指数退避: 1s → 2s → 4s, 共 3 次

**应用层 (`resumePendingArkTasks` in `index.js`)**:
- 服务重启时扫描未完成任务, 调用 `pollArkTaskUntilDone({ taskId })` 恢复轮询
- 方舟服务端生成的视频 URL 会缓存 24 小时, 超时后无法找回

## 🧭 历史命名残留

前端 `authService.getAuthHeaders()` 仍用 `x-session-id` 头表示**登录会话** (与方舟无关)。`sessions` 表也保留为用户登录会话。**不要误改**。

## 🔧 新增功能时

1. ❌ 不要重新引入 Playwright / jimeng / CapCut / PUBLIC_BASE_URL
2. ✅ 需要调用方舟时直接用 `generateArkVideo({ prompt, imageUrls, ... })`, API Key 由它自动读 env
3. ✅ 图片转 Base64: `bufferToDataUri(buffer, mimetype, originalName)`
4. ✅ 新增字段改 `schema.sql`, 未来若 schema 演化再添加 `migrations/YYYYMMDD_xxx.sql`
5. ✅ 新增模型: 在 `src/types/index.ts` 的 `MODEL_OPTIONS` 和 `ModelId` 中注册, 后端透传即可

## 🧪 本地验证

```bash
# 语法自检
node --check server/index.js
for f in server/services/*.js; do node --check "$f"; done

# 启动验证 (需 ARK_API_KEY)
ARK_API_KEY=test-key-abc123 PORT=3099 node server/index.js
curl http://localhost:3099/api/health
# → {"status":"ok","mode":"ark-official-api"}

# 数据库验证
sqlite3 server/data/seedance.db ".tables"
# 不应出现 jimeng_session_accounts
```

## 📐 编码风格

- 后端: ESM, `async/await`, 错误 `throw new Error(...)`
- 前端: 函数式 + Hooks, Tailwind
- 日志前缀: `[ark]` `[batch]` `[resume]` `[database]`
