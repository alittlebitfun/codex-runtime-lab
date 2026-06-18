# Codex Lab

A self-hosted AI coding sandbox with isolated session environments, live file preview, and concurrent task execution. Built with Node.js, React, and PostgreSQL.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-blue)
![License](https://img.shields.io/badge/license-MIT-gray)

## Features

- **Session Isolation** — Each conversation gets its own sandbox directory; generated files are kept separate
- **Live Preview** — HTML outputs render in an inline iframe; images display directly; 3D models (STL/OBJ/GLTF) load in a Three.js viewer
- **Concurrent Execution** — Run multiple sessions in parallel with configurable concurrency limits and a real-time usage bar
- **File Management** — Upload, browse, and reference files across sessions; switch between list and grid views; drag-and-drop upload
- **Session Organization** — Pin important sessions, group them into collections, drag to reorder, search by title or ID
- **Export** — Download full conversation history as Markdown
- **Model Switching** — Select from multiple model options per session
- **Auth** — Email/password registration and login with JWT tokens

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/codex-runtime-lab.git
cd codex-runtime-lab
npm install
```

### 2. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `PGHOST` | No | `127.0.0.1` | PostgreSQL host |
| `PGPORT` | No | `5432` | PostgreSQL port |
| `PGDATABASE` | No | `codex_lab` | Database name |
| `PGUSER` | No | `postgres` | Database user |
| `PGPASSWORD` | **Yes** | — | Database password |
| `JWT_SECRET` | **Yes** | — | Secret key for JWT signing (use a long random string) |
| `PORT` | No | `8765` | HTTP server port |
| `MAX_CONCURRENT_SESSIONS` | No | `4` | Max sessions that can run simultaneously |
| `CODEX_MODEL` | No | `gpt-5.3-codex-spark` | Default model name |
| `CODEX_RUNTIME_BASE` | No | — | Runtime API base URL (for local model servers) |

### 3. Create the database

```bash
createdb codex_lab
```

Tables are created automatically on first startup.

### 4. Start the server

```bash
npm start
```

Open [http://localhost:8765](http://localhost:8765) in your browser.

## Project Structure

```
codex-runtime-lab/
├── server.js            # Express server, API routes, Codex CLI integration
├── db.js                # PostgreSQL schema and migrations
├── auth.js              # JWT authentication middleware
├── package.json
├── .env.example         # Environment variable template
└── public/
    ├── index.html       # React SPA (in-browser Babel transform)
    ├── 3d-viewer.html   # Three.js 3D model viewer
    ├── landing.html     # Landing page
    ├── doc.html         # Documentation page
    ├── app.js           # Landing page scripts
    ├── styles.css       # Landing page styles
    └── site.css         # Site-wide styles
```

## API Overview

All API routes require a Bearer token (JWT) in the `Authorization` header, except for `/api/auth/*`.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create session |
| GET | `/api/sessions/:id` | Get session with messages |
| PATCH | `/api/sessions/:id` | Update title / pinned / collection |
| DELETE | `/api/sessions/:id` | Delete session |
| POST | `/api/sessions/:id/messages` | Send message to session |
| POST | `/api/sessions/:id/upload` | Upload files to sandbox |
| GET | `/api/sessions/:id/files` | List sandbox files |
| GET | `/api/sessions/:id/preview` | Get file content for preview |
| GET/POST/PATCH/DELETE | `/api/collections/*` | Collection CRUD |

## Usage

- **Send a message** — Type in the chat input and press Enter. The message is forwarded to the configured model via Codex CLI.
- **Preview files** — Click any file in the right panel to view its content. HTML files are rendered in a sandboxed iframe.
- **Reference files** — Click the `@` button on a file to insert its path into the chat input.
- **Organize sessions** — Click the `⋮` menu on any session to rename, pin, move to a collection, export, or archive.
- **Search** — Use the search bar at the top of the sidebar to filter sessions by title or ID.

## Tech Stack

- **Backend:** Express.js, PostgreSQL (`pg`), Multer, bcryptjs, jsonwebtoken
- **Frontend:** React 18, Babel Standalone (in-browser JSX transform)
- **3D Viewer:** Three.js

## License

MIT
