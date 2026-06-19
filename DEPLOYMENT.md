# Deployment Guide

This guide describes a small self-hosted deployment for Codex Lab with PostgreSQL, the Codex CLI, isolated session folders, and a persistent macOS LaunchAgent.

## Requirements

- Node.js 18 or newer
- PostgreSQL 14 or newer
- Codex CLI installed on the host
- A logged-in Codex account on the same host user

## 1. Install dependencies

```bash
git clone https://github.com/alittlebitfun/codex-runtime-lab.git
cd codex-runtime-lab
npm install
```

## 2. Prepare PostgreSQL

Create the database used by the app:

```bash
createdb codex_lab
```

If you need a local password-based user:

```bash
psql postgres
```

```sql
CREATE USER postgres WITH PASSWORD 'postgres';
ALTER USER postgres CREATEDB;
CREATE DATABASE codex_lab OWNER postgres;
GRANT ALL PRIVILEGES ON DATABASE codex_lab TO postgres;
```

Tables are created automatically at startup.

## 3. Configure environment

```bash
cp .env.example .env
```

Recommended local baseline:

```bash
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=codex_lab
PGUSER=postgres
PGPASSWORD=postgres
JWT_SECRET=replace_with_a_long_random_secret
PORT=8765
MAX_CONCURRENT_SESSIONS=1
CODEX_BIN=/opt/homebrew/bin/codex
CODEX_MODEL=gpt-5.3-codex-spark
CODEX_MODELS=gpt-5.3-codex-spark,gpt-5.5
CODEX_SERVICE_TIER=fast
CODEX_TASK_TIMEOUT_MS=600000
CODEX_SPAWN_RETRIES=6
CODEX_SPAWN_RETRY_BASE_MS=2000
CODEX_WORKSPACE_ROOT=./runtime-sandboxes
CODEX_RUNTIME_HOME=./.codex-runtime-home
USER_CODEX_HOME=/Users/your-user/.codex
```

`CODEX_MODEL` controls the default model. `CODEX_MODELS` controls the model selector in the UI. The default list includes `gpt-5.3-codex-spark` and `gpt-5.5`.

## 4. Check Codex CLI access

```bash
codex exec --json --skip-git-repo-check -s danger-full-access -m gpt-5.3-codex-spark '只回复 OK'
```

If your account supports GPT-5.5:

```bash
codex exec --json --skip-git-repo-check -s danger-full-access -m gpt-5.5 '只回复 OK'
```

If you see a config error about `service_tier`, use one of the accepted values:

```toml
service_tier = "fast"
```

or:

```toml
service_tier = "flex"
```

For this app, `fast` is the conservative default because it has worked reliably with the runtime-lab CLI path.

## 5. Start locally

```bash
npm start
```

Open:

```text
http://127.0.0.1:8765
```

Register a local account in the browser, create a session, and send a short prompt.

## 6. Run with launchd on macOS

Create `~/Library/LaunchAgents/com.codex-runtime-lab.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex-runtime-lab</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/your-user/path/to/codex-runtime-lab</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>/Users/your-user</string>
    <key>PORT</key>
    <string>8765</string>
    <key>PGHOST</key>
    <string>127.0.0.1</string>
    <key>PGPORT</key>
    <string>5432</string>
    <key>PGDATABASE</key>
    <string>codex_lab</string>
    <key>PGUSER</key>
    <string>postgres</string>
    <key>PGPASSWORD</key>
    <string>postgres</string>
    <key>JWT_SECRET</key>
    <string>replace_with_a_long_random_secret</string>
    <key>MAX_CONCURRENT_SESSIONS</key>
    <string>1</string>
    <key>CODEX_BIN</key>
    <string>/opt/homebrew/bin/codex</string>
    <key>CODEX_MODEL</key>
    <string>gpt-5.3-codex-spark</string>
    <key>CODEX_MODELS</key>
    <string>gpt-5.3-codex-spark,gpt-5.5</string>
    <key>CODEX_SERVICE_TIER</key>
    <string>fast</string>
    <key>CODEX_TASK_TIMEOUT_MS</key>
    <string>600000</string>
    <key>CODEX_SPAWN_RETRIES</key>
    <string>6</string>
    <key>CODEX_SPAWN_RETRY_BASE_MS</key>
    <string>2000</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/codex-runtime-lab.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/codex-runtime-lab.err.log</string>
</dict>
</plist>
```

Load and restart it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex-runtime-lab.plist
launchctl kickstart -k gui/$(id -u)/com.codex-runtime-lab
```

Inspect status:

```bash
launchctl print gui/$(id -u)/com.codex-runtime-lab
tail -f /tmp/codex-runtime-lab.log
tail -f /tmp/codex-runtime-lab.err.log
```

## Troubleshooting

### `spawn codex EAGAIN`

This means macOS temporarily refused to create another process. Use:

```bash
MAX_CONCURRENT_SESSIONS=1
CODEX_SPAWN_RETRIES=6
CODEX_SPAWN_RETRY_BASE_MS=2000
```

Also check for stale helper processes:

```bash
ps -axo pid,ppid,stat,command | grep -E 'playwright|chrome-devtools-mcp|codex .*exec'
```

### `unknown variant priority, expected fast or flex`

Update the Codex config that the CLI is reading:

```toml
service_tier = "fast"
```

The app also passes `CODEX_SERVICE_TIER=fast` by default.

### Skill or MCP startup errors

The app runs Codex with plugins, apps, browser tools, multi-agent, and shell snapshots disabled in its runtime home. This keeps the hosted sandbox focused on CLI execution and avoids broken local skills blocking every session.

### Port already in use

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

Stop the old process or change `PORT` in `.env`.
