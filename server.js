const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');

const { pool, initDb } = require('./db');
const { signToken, authMiddleware } = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 8765);
const WORKSPACE_ROOT = path.resolve(process.env.CODEX_WORKSPACE_ROOT || path.join(__dirname, 'runtime-sandboxes'));
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_CONCURRENT_SESSIONS || 4);
const MAX_SESSION_HISTORY = 160;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const UPLOAD_MAX = 20 * 1024 * 1024; // 20MB per file
const CODEX_TASK_TIMEOUT_MS = Number(process.env.CODEX_TASK_TIMEOUT_MS || 600000);
const CODEX_SPAWN_RETRIES = Number(process.env.CODEX_SPAWN_RETRIES || 6);
const CODEX_SPAWN_RETRY_BASE_MS = Number(process.env.CODEX_SPAWN_RETRY_BASE_MS || 2000);

// Codex CLI binary
const CODEX_INSTALL_BASE = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
let CODEX_BIN = '';
const DEFAULT_MODEL = process.env.CODEX_MODEL || 'gpt-5.3-codex-spark';
const DEFAULT_AVAILABLE_MODELS = ['gpt-5.3-codex-spark', 'gpt-5.5'];
const AVAILABLE_MODELS = Array.from(new Set([
  DEFAULT_MODEL,
  ...(process.env.CODEX_MODELS
    ? process.env.CODEX_MODELS.split(',').map((model) => model.trim()).filter(Boolean)
    : DEFAULT_AVAILABLE_MODELS),
]));
const CODEX_SERVICE_TIER = process.env.CODEX_SERVICE_TIER || 'fast';
const FILE_LIST_LIMIT = 4000;
const CODEX_RUNTIME_HOME = path.resolve(process.env.CODEX_RUNTIME_HOME || path.join(__dirname, '.codex-runtime-home'));
const USER_CODEX_HOME = path.resolve(process.env.USER_CODEX_HOME || path.join(process.env.HOME || '', '.codex'));
const CODEX_GLOBAL_ARGS = [
  '--disable', 'plugins',
  '--disable', 'apps',
  '--disable', 'browser_use',
  '--disable', 'browser_use_external',
  '--disable', 'computer_use',
  '--disable', 'multi_agent',
  '--disable', 'shell_snapshot',
  '--disable', 'tool_search',
  '--disable', 'workspace_dependencies',
  '-c', `service_tier="${CODEX_SERVICE_TIER}"`,
  '-c', 'plugins={}',
  '-c', 'marketplaces={}',
  '-c', 'mcp_servers={}',
];

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file uploads
const uploadStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const sid = req.params.id;
    const dir = path.join(WORKSPACE_ROOT, sid, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const unique = crypto.randomBytes(4).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: UPLOAD_MAX } });

if (!fs.existsSync(WORKSPACE_ROOT)) fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

// ── In-memory state ──
// session processors keyed by session_id — tracks active Codex CLI processes
const sessionProcessors = new Map(); // sessionId -> { isProcessing, taskQueue, activeProcessor }
const sessionStreamSubscribers = new Map(); // sessionId -> Set of callback functions
let activeSessionCount = 0;

function emitStreamEvent(sessionId, event) {
  const subs = sessionStreamSubscribers.get(sessionId);
  if (subs) {
    for (const cb of subs) {
      try { cb(event); } catch {}
    }
  }
}

function now() { return new Date().toISOString(); }
function makeId() { return crypto.randomUUID(); }

function safeRelPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  if (path.isAbsolute(value) || value.includes('..')) throw new Error('非法路径');
  return value;
}

function stripPathSeparators(name) {
  return String(name || '').replace(/[\\\/]/g, '_').trim();
}

function decodeDisplayFilename(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value);
  if (!raw) return '';

  let candidate = raw;
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded && decoded !== raw) {
      candidate = decoded;
    }
  } catch {}

  if (candidate && !candidate.includes('\uFFFD') && looksLikeLatin1Encoding(candidate)) {
    const fallback = Buffer.from(candidate, 'latin1').toString('utf8');
    if (fallback && fallback !== candidate && !fallback.includes('\uFFFD')) {
      return fallback;
    }
  }

  return candidate;
}

function looksLikeLatin1Encoding(value) {
  if (!value) return false;
  let hasLatin1Byte = false;
  let hasUnicodeBeyondLatin1 = false;

  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code > 0xFF) {
      hasUnicodeBeyondLatin1 = true;
      break;
    }
    if (code > 0x7F) hasLatin1Byte = true;
  }

  return hasLatin1Byte && !hasUnicodeBeyondLatin1;
}

function normalizeUploadName(originalName) {
  const baseName = stripPathSeparators(decodeDisplayFilename(originalName) || 'upload');
  return baseName || 'upload';
}

function sessionDir(sessionId) {
  return path.join(WORKSPACE_ROOT, String(sessionId));
}

// ── Detect Codex CLI binary ──
async function detectCodexBin() {
  if (CODEX_BIN) {
    try { await fsp.access(CODEX_BIN); return CODEX_BIN; } catch { CODEX_BIN = ''; }
  }
  if (process.env.CODEX_BIN) {
    try { await fsp.access(process.env.CODEX_BIN); CODEX_BIN = process.env.CODEX_BIN; return CODEX_BIN; } catch {}
  }
  try {
    const entries = await fsp.readdir(CODEX_INSTALL_BASE, { withFileTypes: true });
    const candidates = [];
    const directPath = path.join(CODEX_INSTALL_BASE, 'codex.exe');
    try { const st = await fsp.stat(directPath); candidates.push({ path: directPath, mtime: st.mtimeMs }); } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subBin = path.join(CODEX_INSTALL_BASE, entry.name, 'codex.exe');
      try { const st = await fsp.stat(subBin); candidates.push({ path: subBin, mtime: st.mtimeMs }); } catch {}
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.mtime - a.mtime);
      CODEX_BIN = candidates[0].path;
      console.log(`[codex-lab] Detected Codex CLI: ${CODEX_BIN}`);
      return CODEX_BIN;
    }
  } catch {}
  CODEX_BIN = 'npx';
  return CODEX_BIN;
}

async function ensureCodexRuntimeHome() {
  await fsp.mkdir(CODEX_RUNTIME_HOME, { recursive: true });

  const sourceAuth = path.join(USER_CODEX_HOME, 'auth.json');
  const runtimeAuth = path.join(CODEX_RUNTIME_HOME, 'auth.json');
  try {
    await fsp.access(runtimeAuth);
  } catch {
    await fsp.symlink(sourceAuth, runtimeAuth);
  }

  const configPath = path.join(CODEX_RUNTIME_HOME, 'config.toml');
  const config = [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'personality = "pragmatic"',
    `model = "${DEFAULT_MODEL}"`,
    'model_reasoning_effort = "xhigh"',
    `service_tier = "${CODEX_SERVICE_TIER}"`,
    '',
    '[features]',
    'plugins = false',
    'apps = false',
    'browser_use = false',
    'browser_use_external = false',
    'computer_use = false',
    'multi_agent = false',
    'shell_snapshot = false',
    'tool_search = false',
    'workspace_dependencies = false',
    '',
  ].join('\n');
  await fsp.writeFile(configPath, config, 'utf8');

  return CODEX_RUNTIME_HOME;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnWithRetry(cmd, args, options) {
  for (let attempt = 0; attempt <= CODEX_SPAWN_RETRIES; attempt += 1) {
    try {
      const child = spawn(cmd, args, options);
      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          child.off('error', onError);
          resolve();
        };
        const onError = (err) => {
          child.off('spawn', onSpawn);
          reject(err);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
      if (attempt > 0) {
        console.log(`[codex-lab] spawn recovered after ${attempt} retry`);
      }
      return child;
    } catch (err) {
      if (err.code !== 'EAGAIN' || attempt >= CODEX_SPAWN_RETRIES) {
        throw err;
      }
      const waitMs = CODEX_SPAWN_RETRY_BASE_MS * (attempt + 1);
      console.error(`[codex-lab] spawn EAGAIN, retry ${attempt + 1}/${CODEX_SPAWN_RETRIES} in ${waitMs}ms`);
      await delay(waitMs);
    }
  }
  throw new Error('unreachable spawn retry state');
}

// ── Call Codex CLI (uses native thread/resume for multi-turn) ──
function callCodexCLI(sandboxDir, model, threadId, userMessage, imagePaths, onStreamEvent) {
  return new Promise(async (resolve, reject) => {
    const bin = await detectCodexBin();
    const codexHome = await ensureCodexRuntimeHome();
    const isNpx = bin.startsWith('npx');
    const resolvedModel = model || DEFAULT_MODEL;

    let args;
    if (threadId) {
      // Resume existing thread — Codex handles full conversation context
      args = isNpx
        ? ['@openai/codex', ...CODEX_GLOBAL_ARGS, 'exec', 'resume', threadId, '--json',
           '--skip-git-repo-check', '-m', resolvedModel]
        : [...CODEX_GLOBAL_ARGS, 'exec', 'resume', threadId, '--json',
           '--skip-git-repo-check', '-m', resolvedModel];
      // Add image flags for resume too
      if (imagePaths && imagePaths.length > 0) {
        for (const imgPath of imagePaths) {
          args.push('-i', imgPath);
        }
      }
      args.push(userMessage);
    } else {
      // First message — create new thread (no --ephemeral so it persists for resume)
      args = isNpx
        ? ['@openai/codex', ...CODEX_GLOBAL_ARGS, 'exec', '--json', '--skip-git-repo-check',
           '-s', 'danger-full-access', '-C', sandboxDir, '-m', resolvedModel]
        : [...CODEX_GLOBAL_ARGS, 'exec', '--json', '--skip-git-repo-check',
           '-s', 'danger-full-access', '-C', sandboxDir, '-m', resolvedModel];
      // Add image flags
      if (imagePaths && imagePaths.length > 0) {
        for (const imgPath of imagePaths) {
          args.push('-i', imgPath);
        }
      }
      args.push(userMessage);
    }

    const cmd = isNpx ? 'npx' : bin;
    console.log(`[codex-lab] spawning ${cmd} ${args.slice(0, -1).join(' ')} <prompt>`);
    let child;
    try {
      child = await spawnWithRetry(cmd, args, {
        cwd: sandboxDir,
        windowsHide: true,
        env: { ...process.env, CODEX_HOME: codexHome, NO_COLOR: '1', SHELL: '/bin/sh' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`Codex CLI 启动失败: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    const events = [];

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          events.push(evt);
          // Emit streaming events in real-time
          if (onStreamEvent) {
            if (evt.type === 'item.completed' && evt.item) {
              const item = evt.item;
              if (item.type === 'agent_message' && item.text) {
                onStreamEvent({ type: 'text', content: item.text });
              } else if (item.type === 'command_execution') {
                onStreamEvent({ type: 'command', command: item.command, status: item.status, exitCode: item.exit_code, output: (item.aggregated_output || '').slice(0, 2000) });
              }
            } else if (evt.type === 'thread.started') {
              onStreamEvent({ type: 'thread_started', threadId: evt.thread_id || evt.item?.id || evt.id });
            }
          }
        } catch {}
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      console.error(`[codex-cli] ${text.trim()}`);
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex CLI 超时 (${Math.round(CODEX_TASK_TIMEOUT_MS / 1000)}s)`));
    }, CODEX_TASK_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (stdout.trim()) {
        try { events.push(JSON.parse(stdout.trim())); } catch {}
      }

      const agentMessages = [];
      const commands = [];
      let hasError = false;
      let errorMsg = '';

      for (const evt of events) {
        if (evt.type === 'item.completed' && evt.item) {
          const item = evt.item;
          if (item.type === 'agent_message' && item.text) {
            agentMessages.push(item.text);
          } else if (item.type === 'command_execution') {
            commands.push({
              command: item.command,
              exitCode: item.exit_code,
              status: item.status,
              output: (item.aggregated_output || '').slice(0, 2000),
            });
          } else if (item.type === 'error' && item.message) {
            if (!item.message.includes('Skill descriptions')) {
              hasError = true;
              errorMsg = item.message;
            }
          }
        }
      }

      const parts = [];
      for (const msg of agentMessages) parts.push(msg);
      if (commands.length > 0) {
        const cmdSummary = commands.map(c => {
          const status = c.status === 'completed' ? '✓' : c.status === 'failed' ? '✗' : '?';
          return `\`\`\`\n$ ${c.command.replace(/^"[^"]*"\s*/, '').slice(0, 200)}\n[${status}] exit ${c.exitCode ?? '?'}${c.output ? '\n' + c.output.slice(0, 800) : ''}\n\`\`\``;
        });
        parts.push('**沙箱执行记录：**\n' + cmdSummary.join('\n'));
      }

      const content = parts.join('\n\n') || (hasError ? `错误: ${errorMsg}` : '(无响应)');

      if (code !== 0 && agentMessages.length === 0 && commands.length === 0) {
        const cleanStderr = stderr.replace(/\(node:\d+\) Warning:.*\n/g, '').trim();
        if (cleanStderr) {
          reject(new Error(`Codex CLI 退出码 ${code}: ${cleanStderr.slice(0, 500)}`));
          return;
        }
      }

      // Extract thread ID from thread.started event (field names vary by CLI version)
      const threadEvt = events.find(e => e.type === 'thread.started');
      const extractedThreadId = threadEvt?.thread_id
        || threadEvt?.item?.id
        || threadEvt?.id
        || events.find(e => e.thread_id)?.thread_id
        || null;

      resolve({
        content,
        events,
        threadId: extractedThreadId,
        usage: events.find(e => e.type === 'turn.completed')?.usage || null,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Codex CLI 启动失败: ${err.message}`));
    });
  });
}

// ── Task queue for a session ──
function getProcessor(sessionId) {
  if (!sessionProcessors.has(sessionId)) {
    sessionProcessors.set(sessionId, { isProcessing: false, taskQueue: [] });
  }
  return sessionProcessors.get(sessionId);
}

function scheduleAll() {
  while (activeSessionCount < MAX_CONCURRENT_SESSIONS) {
    let next = null;
    for (const [sid, proc] of sessionProcessors) {
      if (proc.taskQueue.length > 0 && !proc.isProcessing) {
        next = sid;
        break;
      }
    }
    if (!next) break;
    runSessionQueue(next);
  }
}

function runSessionQueue(sessionId) {
  const proc = getProcessor(sessionId);
  if (proc.isProcessing || proc.taskQueue.length === 0) return;
  proc.isProcessing = true;
  activeSessionCount += 1;

  (async () => {
    try {
      while (proc.taskQueue.length > 0) {
        const task = proc.taskQueue.shift();
        task.status = 'running';
        task.startedAt = now();

        try {
          // Get session model + thread_id + sandbox_dir from DB
          const { rows: sessRows } = await pool.query(
            `SELECT model, thread_id, sandbox_dir FROM sessions WHERE id = $1`, [sessionId]
          );
          const model = sessRows[0]?.model || DEFAULT_MODEL;
          const threadId = sessRows[0]?.thread_id || null;
          const dir = sessRows[0]?.sandbox_dir || sessionDir(sessionId);

          const reply = await callCodexCLI(dir, model, threadId, task.input, task.imagePaths || null, (evt) => emitStreamEvent(sessionId, evt));

          task.result = { text: reply.content, usage: reply.usage };
          task.status = 'done';
          emitStreamEvent(sessionId, { type: 'done', content: reply.content, usage: reply.usage });

          // Save thread_id on first call (so subsequent calls use resume)
          if (reply.threadId && !threadId) {
            await pool.query(
              `UPDATE sessions SET thread_id = $1 WHERE id = $2`,
              [reply.threadId, sessionId]
            );
          }

          // Save assistant message to DB
          await pool.query(
            `INSERT INTO messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3)`,
            [sessionId, reply.content, JSON.stringify({ usage: reply.usage })]
          );

          // Update session timestamp
          await pool.query(
            `UPDATE sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]
          );
        } catch (error) {
          task.status = 'error';
          task.result = { error: error.message };
          emitStreamEvent(sessionId, { type: 'error', message: error.message });
          await pool.query(
            `INSERT INTO messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3)`,
            [sessionId, `执行失败：${error.message}`, JSON.stringify({ error: true })]
          );
        }
        task.finishedAt = now();
      }
    } finally {
      proc.isProcessing = false;
      activeSessionCount = Math.max(activeSessionCount - 1, 0);
      scheduleAll();
    }
  })();
}

// ── File operations ──
async function listFilesRecursive(root, baseRel = '', depth = 0, limit = { count: 0 }) {
  if (depth > 5 || limit.count >= FILE_LIST_LIMIT) return [];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (limit.count >= FILE_LIST_LIMIT) break;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'uploads') continue; // skip upload temp dir
      const rel = path.join(baseRel, entry.name);
      const full = path.join(root, entry.name);
      const displayName = decodeDisplayFilename(entry.name);
      if (entry.isDirectory()) {
        result.push({ name: displayName, displayName, type: 'dir', path: rel });
        const sub = await listFilesRecursive(full, rel, depth + 1, limit);
        limit.count += sub.length;
        if (sub.length) result.push(...sub);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(full);
        result.push({ name: displayName, displayName, type: 'file', path: rel, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        limit.count += 1;
      }
    }
    return result;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════
// AUTH ROUTES (no auth middleware)
// ═══════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, display_name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

    const emailNorm = String(email).trim().toLowerCase();
    const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [emailNorm]);
    if (existing.rows.length > 0) return res.status(409).json({ error: '该邮箱已注册' });

    const hash = await bcrypt.hash(password, 10);
    const name = (display_name || emailNorm.split('@')[0]).slice(0, 100);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at`,
      [emailNorm, hash, name]
    );
    const user = rows[0];
    const token = signToken(user);
    res.status(201).json({ user, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });

    const emailNorm = String(email).trim().toLowerCase();
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [emailNorm]);
    if (rows.length === 0) return res.status(401).json({ error: '邮箱或密码错误' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: '邮箱或密码错误' });

    const token = signToken(user);
    res.json({
      user: { id: user.id, email: user.email, display_name: user.display_name, created_at: user.created_at },
      token,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, display_name, created_at FROM users WHERE id = $1`, [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    res.json({ user: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════
// PROTECTED ROUTES
// ═══════════════════════════════════════

app.use('/api/sessions', authMiddleware);
app.use('/api/collections', authMiddleware);
app.use('/api/config', authMiddleware);

app.get('/api/config', async (req, res) => {
  const bin = await detectCodexBin();
  res.json({
    defaultModel: DEFAULT_MODEL,
    models: AVAILABLE_MODELS,
    codexBin: bin,
    maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
  });
});

// List user's sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, 
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as msg_count
       FROM sessions s 
       WHERE s.user_id = $1 
       ORDER BY s.pinned DESC, s.sort_order ASC, s.updated_at DESC 
       LIMIT 100`,
      [req.user.id]
    );

    // Attach processing state
    const list = rows.map(s => {
      const proc = sessionProcessors.get(s.id);
      return {
        id: s.id,
        title: s.title,
        model: s.model,
        status: s.status,
        msgCount: parseInt(s.msg_count) || 0,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        pinned: s.pinned || false,
        sortOrder: s.sort_order || 0,
        collectionId: s.collection_id || null,
        isProcessing: proc?.isProcessing || false,
        queueLength: proc?.taskQueue?.length || 0,
      };
    });

    res.json({ sessions: list, activeProcessors: activeSessionCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create session
app.post('/api/sessions', async (req, res) => {
  try {
    const { title, model } = req.body || {};
    const id = makeId();
    const dir = sessionDir(id);
    fs.mkdirSync(dir, { recursive: true });

    const resolvedTitle = (title || `会话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`).slice(0, 255);
    const resolvedModel = (model || DEFAULT_MODEL).slice(0, 100);

    // New session goes to top (sort_order=0), shift existing uncategorized down
    await pool.query(
      `UPDATE sessions SET sort_order = sort_order + 1 WHERE user_id = $1 AND pinned = false AND collection_id IS NULL`,
      [req.user.id]
    );

    const { rows } = await pool.query(
      `INSERT INTO sessions (id, user_id, title, model, sandbox_dir, sort_order) VALUES ($1, $2, $3, $4, $5, 0) RETURNING *`,
      [id, req.user.id, resolvedTitle, resolvedModel, dir]
    );

    const s = rows[0];
    res.status(201).json({
      session: {
        id: s.id, title: s.title, model: s.model, status: s.status,
        createdAt: s.created_at, updatedAt: s.updated_at,
        pinned: s.pinned || false, sortOrder: s.sort_order || 0, collectionId: null,
        isProcessing: false, queueLength: 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get session detail + messages
app.get('/api/sessions/:id', async (req, res) => {
  try {
    // Verify ownership
    const { rows: sessRows } = await pool.query(
      `SELECT * FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (sessRows.length === 0) return res.status(404).json({ error: '会话不存在' });

    const s = sessRows[0];
    const { rows: msgRows } = await pool.query(
      `SELECT id, role, content, metadata, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    const proc = getProcessor(req.params.id);

    res.json({
      session: {
        id: s.id, title: s.title, model: s.model, status: s.status,
        createdAt: s.created_at, updatedAt: s.updated_at,
        messages: msgRows.slice(-40).map(m => ({
          id: m.id, role: m.role, content: m.content,
          usage: m.metadata?.usage || null,
          createdAt: m.created_at,
        })),
        isProcessing: proc.isProcessing,
        queueLength: proc.taskQueue.length,
      },
      workspace: s.sandbox_dir,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch reorder sessions
app.patch('/api/sessions/reorder', async (req, res) => {
  try {
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return res.status(400).json({ error: '需要 orderedIds 数组' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          `UPDATE sessions SET sort_order = $1 WHERE id = $2 AND user_id = $3`,
          [i, orderedIds[i], req.user.id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update session (title, model, pinned, sort_order, collection_id)
app.patch('/api/sessions/:id', async (req, res) => {
  try {
    const { title, model, pinned, sort_order, collection_id } = req.body || {};
    const updates = [];
    const params = [];
    let isContentChange = false;

    if (typeof title === 'string' && title.trim()) {
      params.push(title.trim());
      updates.push(`title = $${params.length}`);
      isContentChange = true;
    }
    if (typeof model === 'string' && model.trim()) {
      params.push(model.trim());
      updates.push(`model = $${params.length}`);
      isContentChange = true;
    }
    if (typeof pinned === 'boolean') {
      params.push(pinned);
      updates.push(`pinned = $${params.length}`);
    }
    if (typeof sort_order === 'number' && Number.isFinite(sort_order) && sort_order >= 0) {
      params.push(Math.floor(sort_order));
      updates.push(`sort_order = $${params.length}`);
    }
    if (req.body.hasOwnProperty('collection_id')) {
      if (collection_id === null || typeof collection_id === 'string') {
        params.push(collection_id);
        updates.push(`collection_id = $${params.length}`);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

    params.push(req.params.id, req.user.id);
    const setClause = isContentChange ? `, updated_at = NOW()` : '';
    const { rows } = await pool.query(
      `UPDATE sessions SET ${updates.join(', ')}${setClause} WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: '会话不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sandbox_dir FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '会话不存在' });

    // Delete sandbox dir
    if (rows[0].sandbox_dir) {
      await fsp.rm(rows[0].sandbox_dir, { recursive: true, force: true }).catch(() => {});
    }

    // Cascade delete in DB
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [req.params.id]);
    sessionProcessors.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send message (queue LLM task)
app.post('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { content, model, attachments } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) {
      // Allow sending with only attachments
      if (!attachments || attachments.length === 0) {
        return res.status(400).json({ error: 'content 不能为空' });
      }
    }

    // Verify ownership
    const { rows: sessRows } = await pool.query(
      `SELECT id, model, sandbox_dir FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (sessRows.length === 0) return res.status(404).json({ error: '会话不存在' });

    const sandboxDir = sessRows[0].sandbox_dir || sessionDir(req.params.id);

    // Optionally update model
    if (model && model !== sessRows[0].model) {
      await pool.query(`UPDATE sessions SET model = $1, updated_at = NOW() WHERE id = $2`, [model, req.params.id]);
    }

    // Build enriched prompt with file contents
    let enrichedContent = (content || '').trim();
    const imagePaths = [];

    if (attachments && attachments.length > 0) {
      const fileBlocks = [];
      for (const att of attachments) {
        const attachmentPath = att.path || att.name;
        const filePath = path.join(sandboxDir, attachmentPath);
        try {
          const stat = await fsp.stat(filePath);
          const attachmentName = att.name || attachmentPath;
          const isImg = /^image\//i.test(att.mime || '') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(attachmentName);

          if (isImg) {
            // Images: pass as -i flag to Codex CLI
            imagePaths.push(filePath);
            fileBlocks.push(`[Attached image: ${attachmentName}]`);
          } else if (stat.size < 50 * 1024) {
            // Text files < 50KB: inline content
            const text = await fsp.readFile(filePath, 'utf8');
            fileBlocks.push(`\n--- File: ${attachmentName} ---\n${text}\n--- End of ${attachmentName} ---\n`);
          } else {
            // Large binary files: just reference the path
            fileBlocks.push(`[File: ${attachmentName} (${(stat.size/1024).toFixed(1)}KB) - available in the working directory]`);
          }
        } catch {
          fileBlocks.push(`[File: ${att.name || 'unknown'} - upload may have failed]`);
        }
      }
      if (fileBlocks.length > 0) {
        enrichedContent = enrichedContent
          ? enrichedContent + '\n\n[User attached the following files:]\n' + fileBlocks.join('\n')
          : '[User attached the following files:]\n' + fileBlocks.join('\n');
      }
    }

    // Save user message to DB (original content, not enriched)
    const displayContent = content?.trim() || `📎 ${attachments.map(a => a.name).join(', ')}`;
    await pool.query(
      `INSERT INTO messages (session_id, role, content, metadata) VALUES ($1, 'user', $2, $3)`,
      [req.params.id, displayContent, JSON.stringify({ attachments: attachments || [] })]
    );

    // Auto-title: if first user message, use it as title
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM messages WHERE session_id = $1 AND role = 'user'`,
      [req.params.id]
    );
    if (parseInt(countRows[0].cnt) === 1) {
      const autoTitle = displayContent.slice(0, 50);
      await pool.query(`UPDATE sessions SET title = $1 WHERE id = $2`, [autoTitle, req.params.id]);
    }

    // Queue task with enriched content + image paths
    const proc = getProcessor(req.params.id);
    const task = {
      id: makeId(),
      input: enrichedContent,
      imagePaths: imagePaths.length > 0 ? imagePaths : null,
      status: 'queued',
      createdAt: now(),
      startedAt: '',
      finishedAt: '',
      result: null,
    };
    proc.taskQueue.push(task);
    scheduleAll();

    res.status(202).json({ task: { id: task.id, status: task.status } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE stream endpoint for real-time output
app.get('/api/sessions/:id/stream', async (req, res) => {
  try {
    // Verify ownership
    const { rows } = await pool.query(
      `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '会话不存在' });

    const sessionId = req.params.id;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send initial connection event
    const proc = getProcessor(sessionId);
    res.write(`data: ${JSON.stringify({ type: 'connected', isProcessing: proc.isProcessing, queueLength: proc.taskQueue.length })}\n\n`);

    // Register subscriber
    if (!sessionStreamSubscribers.has(sessionId)) {
      sessionStreamSubscribers.set(sessionId, new Set());
    }
    const subscriber = (event) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
    };
    sessionStreamSubscribers.get(sessionId).add(subscriber);

    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch {}
    }, 15000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(heartbeat);
      const subs = sessionStreamSubscribers.get(sessionId);
      if (subs) {
        subs.delete(subscriber);
        if (subs.size === 0) sessionStreamSubscribers.delete(sessionId);
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List files in sandbox
app.get('/api/sessions/:id/files', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sandbox_dir FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '会话不存在' });

    const dir = rows[0].sandbox_dir || sessionDir(req.params.id);
    const tree = await listFilesRecursive(dir, '', 0, { count: 0 });
    res.json({ files: tree });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get file content
app.get('/api/sessions/:id/files/content', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sandbox_dir FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '会话不存在' });

    const dir = rows[0].sandbox_dir || sessionDir(req.params.id);
    const relPath = req.query.path || '';
    const safe = safeRelPath(relPath);
    const target = path.resolve(dir, safe);
    if (!target.startsWith(dir + path.sep) && target !== dir) {
      return res.status(400).json({ error: '非法路径' });
    }
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return res.status(400).json({ error: '仅支持文件预览' });
    if (stat.size > MAX_FILE_BYTES) return res.status(400).json({ error: '文件过大' });

    const content = await fsp.readFile(target, 'utf8');
    const ext = path.extname(safe).toLowerCase();
    res.json({ path: safe, ext, content, size: stat.size });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Upload files to sandbox
app.post('/api/sessions/:id/upload', upload.array('files', 10), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sandbox_dir FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '会话不存在' });

    const dir = rows[0].sandbox_dir || sessionDir(req.params.id);
    const uploaded = [];

    for (const file of (req.files || [])) {
      // Copy from uploads dir to sandbox root
      const storedName = normalizeUploadName(file.originalname);
      const destPath = path.join(dir, storedName);
    await fsp.copyFile(file.path, destPath);
    // Remove from uploads temp dir
    await fsp.unlink(file.path).catch(() => {});

      // Record in DB
      await pool.query(
        `INSERT INTO uploaded_files (session_id, original_name, stored_path, mime_type, size_bytes) VALUES ($1, $2, $3, $4, $5)`,
        [req.params.id, storedName, destPath, file.mimetype, file.size]
      );

      const isImage = /^image\//i.test(file.mimetype);
      uploaded.push({
        name: storedName,
        path: storedName,
        size: file.size,
        mime: file.mimetype,
        isImage,
        isText: !isImage && file.size < 50 * 1024,
      });
    }

    await pool.query(`UPDATE sessions SET updated_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json({ uploaded });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// MIME types for 3D model formats (not always in Express defaults)
const MIME_3D = {
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.ply': 'application/octet-stream',
};

// MIME types for video formats
const MIME_VIDEO = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4',
};

// Preview file (raw serve for iframe)
app.get('/api/sessions/:id/preview', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sandbox_dir FROM sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).send('会话不存在');

    const dir = rows[0].sandbox_dir || sessionDir(req.params.id);
    const relPath = req.query.path || '';
    const safe = safeRelPath(relPath);
    const target = path.resolve(dir, safe);
    if (!target.startsWith(dir + path.sep) && target !== dir) {
      return res.status(400).send('非法路径');
    }
    const stat = await fsp.stat(target);
    if (!stat.isFile()) return res.status(400).send('仅支持文件预览');
    const ext = path.extname(target).toLowerCase();
    if (MIME_3D[ext]) {
      res.setHeader('Content-Type', MIME_3D[ext]);
    } else if (MIME_VIDEO[ext]) {
      res.setHeader('Content-Type', MIME_VIDEO[ext]);
      res.setHeader('Accept-Ranges', 'bytes');
    }
    res.sendFile(target);
  } catch (e) {
    res.status(404).send(e.message);
  }
});

// ═══════════════════════════════════════
// COLLECTION ROUTES
// ═══════════════════════════════════════

// List collections
app.get('/api/collections', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, (SELECT COUNT(*) FROM sessions s WHERE s.collection_id = c.id) as session_count
       FROM session_collections c WHERE c.user_id = $1 ORDER BY c.sort_order ASC, c.created_at ASC`,
      [req.user.id]
    );
    const collections = rows.map(c => ({
      id: c.id, name: c.name, sortOrder: c.sort_order || 0,
      createdAt: c.created_at, sessionCount: parseInt(c.session_count) || 0,
    }));
    res.json({ collections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create collection
app.post('/api/collections', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '集合名称不能为空' });
    const trimmed = name.trim().slice(0, 100);

    const { rows: orderRows } = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM session_collections WHERE user_id = $1`,
      [req.user.id]
    );
    const nextOrder = orderRows[0].next_order;

    const { rows } = await pool.query(
      `INSERT INTO session_collections (user_id, name, sort_order) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, trimmed, nextOrder]
    );
    const c = rows[0];
    res.status(201).json({ collection: { id: c.id, name: c.name, sortOrder: c.sort_order, createdAt: c.created_at, sessionCount: 0 } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reorder collections
app.patch('/api/collections/reorder', async (req, res) => {
  try {
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return res.status(400).json({ error: '需要 orderedIds 数组' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          `UPDATE session_collections SET sort_order = $1 WHERE id = $2 AND user_id = $3`,
          [i, orderedIds[i], req.user.id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rename collection
app.patch('/api/collections/:id', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '集合名称不能为空' });
    const { rows } = await pool.query(
      `UPDATE session_collections SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
      [name.trim().slice(0, 100), req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '集合不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete collection (sessions become uncategorized)
app.delete('/api/collections/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE sessions SET collection_id = NULL WHERE collection_id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    const { rows } = await pool.query(`DELETE FROM session_collections WHERE id = $1 AND user_id = $2 RETURNING id`, [req.params.id, req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: '集合不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──
(async () => {
  await initDb();
  await detectCodexBin();
  app.listen(PORT, () => {
    console.log(`[codex-lab] running at http://localhost:${PORT}`);
    console.log(`[codex-lab] model: ${DEFAULT_MODEL}`);
    console.log(`[codex-lab] max concurrent: ${MAX_CONCURRENT_SESSIONS}`);
    console.log(`[codex-lab] PostgreSQL: connected`);
  });
})();
