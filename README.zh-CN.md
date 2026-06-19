# Codex Lab

> [English](./README.md) | **中文**

自托管的 AI 编程沙盒平台 —— 每个对话独享隔离环境，支持文件实时预览和并发任务执行。基于 Node.js、React 和 PostgreSQL 构建。

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-blue)
![License](https://img.shields.io/badge/license-MIT-gray)

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [安装](#安装)
  - [配置](#配置)
  - [创建数据库](#创建数据库)
  - [启动](#启动)
- [项目结构](#项目结构)
- [API 概览](#api-概览)
- [使用指南](#使用指南)
- [技术栈](#技术栈)
- [部署指南](#部署指南)
- [许可证](#许可证)

---

## 功能特性

- **沙盒隔离** —— 每个会话拥有独立的工作目录，AI 执行的命令和生成的文件完全隔离，互不干扰
- **实时预览** —— HTML 输出直接在 iframe 中渲染；图片即时显示；3D 模型（STL/OBJ/GLTF）通过 Three.js 查看；视频在线播放
- **流式输出** —— AI 回复通过 SSE（Server-Sent Events）实时逐字推送，带流式光标和生成状态指示，无需等待完成
- **并发执行** —— 多个会话可并行运行 AI 任务，可配置并发上限，实时显示占用情况
- **文件管理** —— 上传、浏览、引用文件；支持列表/网格双视图；拖拽上传；`@` 引用文件到对话
- **会话组织** —— 置顶重要会话、分组到集合、拖拽排序、按标题或 ID 搜索
- **Hyperframe** —— 支持 `.hf.html` 格式的交互式内容，增强沙盒中全屏预览和交互
- **导出** —— 下载完整对话记录为 Markdown 文件
- **模型切换** —— 每个会话可选择不同的模型
- **账户系统** —— 邮箱/密码注册登录，JWT Token 鉴权

## 快速开始

生产环境部署请参考 [DEPLOYMENT.md](./DEPLOYMENT.md)。

### 环境要求

- Node.js 18+
- PostgreSQL 14+
- 宿主机已安装并登录 Codex CLI

### 安装

```bash
git clone https://github.com/alittlebitfun/codex-runtime-lab.git
cd codex-runtime-lab
npm install
```

### 配置

复制环境变量模板并按需修改：

```bash
cp .env.example .env
```

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PGHOST` | 否 | `127.0.0.1` | PostgreSQL 地址 |
| `PGPORT` | 否 | `5432` | PostgreSQL 端口 |
| `PGDATABASE` | 否 | `codex_lab` | 数据库名 |
| `PGUSER` | 否 | `postgres` | 数据库用户 |
| `PGPASSWORD` | **是** | — | 数据库密码 |
| `JWT_SECRET` | **是** | — | JWT 签名密钥（请使用足够长的随机字符串） |
| `PORT` | 否 | `8765` | HTTP 服务端口 |
| `MAX_CONCURRENT_SESSIONS` | 否 | `1` | 最大并发会话数 |
| `CODEX_BIN` | 否 | 自动检测 / `npx` | Codex CLI 二进制路径 |
| `CODEX_MODEL` | 否 | `gpt-5.3-codex-spark` | 默认模型名 |
| `CODEX_MODELS` | 否 | `gpt-5.3-codex-spark,gpt-5.5` | 前端可选模型列表（逗号分隔） |
| `CODEX_SERVICE_TIER` | 否 | `fast` | Codex 服务层级 |
| `CODEX_TASK_TIMEOUT_MS` | 否 | `600000` | 单条消息超时时间（毫秒） |
| `CODEX_SPAWN_RETRIES` | 否 | `6` | 进程启动失败重试次数 |
| `CODEX_SPAWN_RETRY_BASE_MS` | 否 | `2000` | 重试基础退避时间（毫秒） |
| `CODEX_WORKSPACE_ROOT` | 否 | `./runtime-sandboxes` | 会话沙盒根目录 |
| `CODEX_RUNTIME_HOME` | 否 | `./.codex-runtime-home` | 运行时 Codex Home 目录 |
| `USER_CODEX_HOME` | 否 | `$HOME/.codex` | 宿主机 Codex Home（用于读取 auth.json） |

### 创建数据库

```bash
createdb codex_lab
```

数据表会在首次启动时自动创建。

### 启动

```bash
npm start
```

浏览器打开 [http://localhost:8765](http://localhost:8765) 即可使用。

## 项目结构

```
codex-runtime-lab/
├── server.js            # Express 服务端，API 路由，Codex CLI 集成
├── db.js                # PostgreSQL 数据表和迁移
├── auth.js              # JWT 鉴权中间件
├── package.json
├── .env.example         # 环境变量模板
└── public/
    ├── index.html       # React 单页应用（浏览器端 Babel 编译）
    ├── 3d-viewer.html   # Three.js 3D 模型查看器
    ├── landing.html     # 静态着陆页
    ├── doc.html         # 帮助文档页
    ├── app.js           # 着陆页脚本
    ├── styles.css       # 着陆页样式
    └── site.css         # 全站样式
```

## API 概览

除 `/api/auth/*` 外，所有 API 路由需要在 `Authorization` 头中携带 Bearer Token（JWT）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | [`/api/auth/register`](#账户系统) | 注册账号 |
| POST | [`/api/auth/login`](#账户系统) | 登录 |
| GET | [`/api/sessions`](#api-概览) | 获取会话列表 |
| POST | [`/api/sessions`](#api-概览) | 创建会话 |
| GET | [`/api/sessions/:id`](#api-概览) | 获取会话详情及消息 |
| PATCH | [`/api/sessions/:id`](#api-概览) | 更新标题 / 置顶 / 集合 |
| DELETE | [`/api/sessions/:id`](#api-概览) | 删除会话 |
| POST | [`/api/sessions/:id/messages`](#使用指南) | 发送消息 |
| GET | [`/api/sessions/:id/stream`](#流式输出) | SSE 流式输出 |
| POST | [`/api/sessions/:id/upload`](#文件管理) | 上传文件到沙盒 |
| GET | [`/api/sessions/:id/files`](#文件管理) | 列出沙盒文件 |
| GET | [`/api/sessions/:id/preview`](#实时预览) | 获取文件预览内容 |
| GET/POST/PATCH/DELETE | [`/api/collections/*`](#会话组织) | 集合增删改查 |

## 使用指南

- **发送消息** —— 在对话框输入内容后按 Enter，消息会通过 Codex CLI 转发给配置的模型
- **预览文件** —— 点击右侧面板中的文件即可查看内容。HTML 文件在沙盒 iframe 中渲染，视频直接播放
- **引用文件** —— 点击文件上的 `@` 按钮，将文件路径插入到对话框中
- **组织会话** —— 点击会话上的 `⋮` 菜单，可重命名、置顶、移入集合、导出或归档
- **搜索** —— 使用侧边栏顶部的搜索框，按标题或 ID 筛选会话
- **流式输出** —— 发送消息后，AI 的回复会通过 SSE 实时推送，逐字显示在对话区域

## 技术栈

- **后端：** Express.js、PostgreSQL (`pg`)、Multer、bcryptjs、jsonwebtoken
- **前端：** React 18、Babel Standalone（浏览器端 JSX 编译）
- **3D 查看器：** Three.js
- **流式输出：** Server-Sent Events (SSE)

## 部署指南

详细的生产环境部署说明请查看 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 许可证

[MIT](./LICENSE)
