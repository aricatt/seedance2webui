# Seedance 2.0 Web

基于**火山方舟 (Volcengine Ark) 官方 API** 的 Seedance 2.0 视频生成 Web 平台，面向**内网/公司内部**部署场景。

> 历史版本曾基于即梦 (Jimeng) 逆向 SessionID。现已**完全重构**为调用方舟官方 `POST /api/v3/contents/generations/tasks`，参考图片通过 **Base64 内嵌**发送，**不依赖公网可访问的 URL**，完美适配内网部署。

## ✨ 功能特性

- **🎬 单任务 / 批量生成**: 上传参考图片 + 提示词 → 图生视频
- **🔒 API Key 统一管理**: 由管理员在 `.env` 中配置，普通用户**看不见也改不了**
- **♻️ 自动重试 + 断点恢复**:
  - 方舟调用遇到 429/5xx/网络抖动 → 指数退避重试 3 次
  - 服务重启后自动恢复**已提交但未完成**的任务（只要 task_id 已落库）
- **💾 自动下载**: 生成完成的视频自动拉取到本地，按项目组织
- **👥 多用户 + 管理后台**: 注册/登录/积分/用户管理
- **📧 邮箱验证码**: 可选 SMTP 注册验证

## 🏗️ 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite + TailwindCSS |
| 后端 | Node.js 22 + Express 4 |
| 数据库 | SQLite (`better-sqlite3`) |
| AI 接口 | [火山方舟](https://www.volcengine.com/docs/82379) `doubao-seedance-2-0-260128` |
| 部署 | Docker / Docker Compose |

## 🚀 快速开始

### 1. 获取方舟 API Key

访问 [火山方舟控制台](https://console.volcengine.com/ark) 创建 API Key。

### 2. 本地开发

```bash
# 安装依赖 (前端 + 后端)
npm run install:all

# 配置环境变量
cp .env.example .env
# 编辑 .env, 填入 ARK_API_KEY=<你的 Key>   (必填)

# 启动 (前端 5173 + 后端 3001, 热重载)
npm run dev
```

浏览器访问 `http://localhost:5173`，注册账号后即可使用。

### 3. Docker 部署（推荐内网场景）

```bash
# 1. 准备 .env 文件
echo 'ARK_API_KEY=your_key_here' > .env

# 2. 使用预构建镜像启动
docker compose up -d

# 或本地构建
docker compose -f docker-compose-dev.yml up -d --build
```

访问 `http://<服务器IP>:3001`。

## 🔑 配置

| 环境变量 | 必需 | 说明 |
|----------|------|------|
| `ARK_API_KEY` | **是** | 方舟 API Key（整个系统共用一把，缺失则服务无法启动） |
| `PORT` | 否 | 后端端口，默认 `3001` |
| `SMTP_*` | 否 | 邮件配置，详见 `doc/SMTP 配置指南.md` |

> **注意**：不再需要 `PUBLIC_BASE_URL`。参考图片通过 Base64 内嵌到方舟请求体中，无论内网还是公网部署都能工作。

### 🏢 内网部署说明

本项目设计为**内网优先**：
- 前端用户看不到、无法录入 API Key
- 所有视频生成请求由后端统一使用 `ARK_API_KEY` 发起
- 参考图片以 Base64 形式直接嵌入请求体，**不依赖公网域名**
- 唯一出网要求：服务器可访问 `ark.cn-beijing.volces.com`

## 📁 项目结构

```
seedance2.0web.git/
├── src/                          # 前端 React 源码
│   ├── pages/                    # 页面组件
│   ├── services/                 # API 客户端
│   └── types/                    # TypeScript 类型
├── server/
│   ├── index.js                  # Express 主入口 (启动时 fail-fast 检查 ARK_API_KEY)
│   ├── services/
│   │   ├── arkConfig.js          # ARK_API_KEY 读取 + 启动校验
│   │   ├── arkVideoGenerator.js  # 方舟 API 封装 (含 Base64 编码 + 指数退避重试)
│   │   ├── batchScheduler.js     # 批量任务调度 (单 Key 并发)
│   │   ├── taskService.js
│   │   ├── projectService.js
│   │   ├── authService.js
│   │   ├── settingsService.js
│   │   └── videoDownloader.js
│   ├── database/
│   │   ├── schema.sql            # canonical schema
│   │   └── migrations/           # 未来增量迁移
│   └── data/                     # (运行时) SQLite 数据库
├── doc/                          # 设计文档
└── Dockerfile / docker-compose.yml
```

## 📝 API 端点

| 端点 | 说明 |
|------|------|
| `POST /api/generate-video` | 单任务生成 (multipart 上传图片 + prompt) |
| `GET /api/task/:taskId` | 轮询内存任务状态 |
| `POST /api/tasks/:id/generate` | 项目内任务触发生成 |
| `POST /api/batch/generate` | 启动批量任务 |
| `GET /api/batch/:id/status` | 批量任务进度 |
| `GET /api/settings/ark-status` | 检查服务端 API Key 是否已配置 (只返回布尔值) |
| `/api/auth/*` | 注册/登录/密码/邮箱验证码 |
| `/api/admin/*` | 管理员接口 |

## 🧪 默认管理员账号

首次启动会自动创建:
- 邮箱: `admin@seedance.com`
- 密码: `admin123456`

**上线前请立即修改密码!**

## 🔍 故障排查

| 症状 | 排查方向 |
|------|----------|
| 启动报 `ARK_API_KEY 未配置` | `.env` 未创建或变量未导出 |
| 生成超时 (>15 分钟) | 方舟服务端排队拥堵, 服务重启后可自动恢复已提交的任务 |
| HTTP 401/403 | API Key 失效或余额不足 |
| HTTP 429 | 触发限流, 已自动重试 3 次仍失败 |
| 图片上传报 413 Payload Too Large | 单张图超过 20MB 限制, 压缩后重试 |

## 🔐 断网恢复能力

| 阶段 | 断网后能否恢复 |
|------|----------------|
| 提交任务前 / 提交中 (未拿到 task_id) | ❌ 无法恢复，需重新提交 |
| 提交后轮询中 (task_id 已落库) | ✅ 服务重启后自动继续轮询，视频会正常入库 |

## 📜 License

MIT
