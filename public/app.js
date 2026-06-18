const state = {
  sessions: [],
  activeSessionId: null,
  activeFile: '',
  pollTimer: null,
};

const el = {
  sessions: document.getElementById('sessions'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  sessionTitle: document.getElementById('sessionTitle'),
  concurrentLimit: document.getElementById('concurrentLimit'),
  modelInput: document.getElementById('modelInput'),
  runtimeInput: document.getElementById('runtimeInput'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  saveConfigBtn: document.getElementById('saveConfigBtn'),
  chat: document.getElementById('chat'),
  tasks: document.getElementById('tasks'),
  chatForm: document.getElementById('chatForm'),
  messageInput: document.getElementById('messageInput'),
  execOnlyBtn: document.getElementById('execOnlyBtn'),
  messageHint: document.getElementById('messageHint'),
  fileList: document.getElementById('fileList'),
  refreshFilesBtn: document.getElementById('refreshFilesBtn'),
  fileContent: document.getElementById('fileContent'),
  saveFileBtn: document.getElementById('saveFileBtn'),
  fileStatus: document.getElementById('fileStatus'),
  previewFrame: document.getElementById('previewFrame'),
};

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || data.message || `请求失败 ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString();
}

function statusClass(status) {
  if (status === 'done') return 'ok';
  if (status === 'error') return 'bad';
  if (status === 'running') return 'running';
  return '';
}

function setActiveSession(id) {
  state.activeSessionId = id;
  renderSessions();
  loadSessionData(true);
  setMessageHint('');
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => loadSessionData(false), 1200);
}

function setMessageHint(text) {
  el.messageHint.textContent = text || '';
}

function getActiveSession() {
  return state.sessions.find((session) => session.id === state.activeSessionId);
}

function renderSessions() {
  el.sessions.innerHTML = '';
  for (const session of state.sessions) {
    const active = session.id === state.activeSessionId ? 'active' : '';
    const button = document.createElement('button');
    const busy = session.isProcessing || session.queueLength > 0;
    button.className = `session-btn ${active}`;
    button.innerHTML = `
      <strong>${escapeHtml(session.name)}</strong>
      <small>${escapeHtml(session.model || '')}</small>
      <span class="status ${busy ? 'busy' : ''}">${busy ? '执行�? : '空闲'}</span>
      <em>${formatDate(session.touchedAt)}</em>
    `;
    button.onclick = () => setActiveSession(session.id);
    button.ondblclick = () => confirmDeleteSession(session.id);
    el.sessions.appendChild(button);
  }
}

async function loadSessions() {
  const data = await request('/api/sessions');
  state.sessions = data.sessions || [];
  if (!state.activeSessionId && state.sessions[0]) {
    state.activeSessionId = state.sessions[0].id;
  }
  if (state.activeSessionId && !state.sessions.some((s) => s.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0] ? state.sessions[0].id : null;
  }
  renderSessions();
  if (state.activeSessionId) {
    loadSessionData(false);
  } else {
    el.sessionTitle.textContent = '未选择会话';
  }
}

async function loadSessionData(shouldLoadFiles = true) {
  const session = getActiveSession();
  if (!session) return;
  const data = await request(`/api/sessions/${state.activeSessionId}`);
  const target = data.session;
  const updated = state.sessions.find((s) => s.id === session.id);
  if (!updated) return;
  Object.assign(updated, target);
  el.sessionTitle.textContent = `${target.name} (${target.id.slice(0, 8)})`;
  el.modelInput.value = target.model || '5.3-Codex-Spark';
  el.runtimeInput.value = target.runtimeBase || '';
  renderMessages(target.messages || []);
  renderTasks(target.tasks || []);
  if (shouldLoadFiles) loadFiles();
}

function renderMessages(messages) {
  el.chat.innerHTML = '';
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const row = document.createElement('div');
    row.className = `msg ${msg.role}`;
    const role = msg.role === 'user' ? '�? : 'Codex';
    row.innerHTML = `
      <header>${role} · ${formatDate(msg.createdAt)}</header>
      <p>${escapeHtml(msg.content || '').replaceAll('\n', '<br/>')}</p>
    `;
    el.chat.appendChild(row);
  }
  el.chat.scrollTop = el.chat.scrollHeight;
}

function renderTasks(tasks) {
  el.tasks.innerHTML = '';
  for (const task of tasks) {
    const row = document.createElement('div');
    row.className = `task ${statusClass(task.status)}`;
    row.innerHTML = `
      <div><strong>[${task.type}]</strong> ${task.id.slice(0, 8)}</div>
      <div>${escapeHtml(task.input)}</div>
      <small>${task.status} · ${formatDate(task.startedAt)} -> ${formatDate(task.finishedAt)}</small>
    `;
    el.tasks.appendChild(row);
  }
}

async function loadFiles() {
  if (!state.activeSessionId) return;
  const data = await request(`/api/sessions/${state.activeSessionId}/files`);
  const files = data.files || [];
  el.fileList.innerHTML = '';

  if (files.length === 0) {
    el.fileList.innerHTML = '<div class="empty">当前沙箱还没有文�?/div>';
    return;
  }

  for (const item of files) {
    const row = document.createElement('button');
    row.className = `file-item ${item.type}`;
    row.textContent = `${item.type === 'dir' ? '📁' : '📄'} ${item.path}`;
    row.onclick = () => openFile(item);
    el.fileList.appendChild(row);
  }
}

async function openFile(file) {
  if (file.type !== 'file') {
    return;
  }
  try {
    const data = await request(
      `/api/sessions/${state.activeSessionId}/files/content?path=${encodeURIComponent(file.path)}`
    );
    state.activeFile = file.path;
    el.fileContent.textContent = data.content || '';
    el.saveFileBtn.disabled = false;
    setFilePreview(file.path);
    el.fileStatus.textContent = `已打开 ${file.path} (${Math.round((data.size || 0) / 1024)}KB)`;
  } catch (error) {
    el.fileStatus.textContent = error.message;
  }
}

function setFilePreview(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    el.previewFrame.src = `/api/sessions/${state.activeSessionId}/preview?path=${encodeURIComponent(filePath)}`;
  } else {
    el.previewFrame.srcdoc = '<div style="padding:16px;color:#666">仅HTML文件可直接预�?/div>';
  }
}

async function saveCurrentFile() {
  if (!state.activeFile) return;
  const content = el.fileContent.textContent;
  await request(`/api/sessions/${state.activeSessionId}/files/content`, {
    method: 'POST',
    body: JSON.stringify({
      path: state.activeFile,
      content,
    }),
  });
  el.fileStatus.textContent = `已保�?${state.activeFile}`;
  loadFiles();
}

async function createSessionFromDialog() {
  const name = prompt('会话名称', `会话 ${Date.now().toString().slice(-4)}`);
  if (name === null) return;
  const payload = { name };
  const cfg = await request('/api/config');
  payload.model = cfg.defaultModel || '5.3-Codex-Spark';
  if (cfg.defaultRuntimeBase) payload.runtimeBase = cfg.defaultRuntimeBase;
  const data = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  state.sessions.unshift(data.session);
  state.activeSessionId = data.session.id;
  renderSessions();
  loadSessionData(true);
}

async function sendMessage(options = {}) {
  const session = getActiveSession();
  if (!session) {
    setMessageHint('请先选择一个会�?);
    return;
  }
  const content = el.messageInput.value.trim();
  if (!content) return;
  setMessageHint('任务已提交，处理�?..');
  await request(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      model: el.modelInput.value.trim(),
      runtimeBase: el.runtimeInput.value.trim(),
      apiKey: el.apiKeyInput.value.trim(),
      commandMode: options.commandMode || false,
    }),
  });
  el.messageInput.value = '';
  setMessageHint('');
  await loadSessionData(true);
}

async function updateConfig() {
  const session = getActiveSession();
  if (!session) return;
  await request(`/api/sessions/${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      model: el.modelInput.value.trim(),
      runtimeBase: el.runtimeInput.value.trim(),
      apiKey: el.apiKeyInput.value.trim(),
    }),
  });
  await loadSessions();
}

async function confirmDeleteSession(sessionId) {
  if (!confirm('确认删除该会话及其沙箱目录？')) return;
  await request(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  state.activeSessionId = null;
  await loadSessions();
  if (state.activeSessionId) {
    loadSessionData(true);
  } else {
    el.sessionTitle.textContent = '未选择会话';
    el.chat.innerHTML = '';
    el.tasks.innerHTML = '';
    el.fileList.innerHTML = '';
    el.fileContent.textContent = '选择文件查看';
  }
}

async function init() {
  try {
    const cfg = await request('/api/config');
    el.concurrentLimit.textContent = cfg.maxConcurrentSessions;
    if (cfg.defaultRuntimeBase) el.runtimeInput.value = cfg.defaultRuntimeBase;
    el.modelInput.value = cfg.defaultModel || '5.3-Codex-Spark';
    await loadSessions();
    if (!state.sessions.length) {
      await createSessionFromDialog();
    }
  } catch (error) {
    setMessageHint(error.message);
  }
}

el.newSessionBtn.addEventListener('click', createSessionFromDialog);
el.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});
el.execOnlyBtn.addEventListener('click', () =>
  sendMessage({ commandMode: true })
);
el.refreshFilesBtn.addEventListener('click', loadFiles);
el.saveFileBtn.addEventListener('click', saveCurrentFile);
el.saveConfigBtn.addEventListener('click', updateConfig);

init();

