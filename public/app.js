const chat = document.getElementById('chat');
const authBtn = document.getElementById('authBtn');
const composer = document.getElementById('composer');
const promptInput = document.getElementById('promptInput');
const sourceFileInput = document.getElementById('sourceFile');

let me = { loggedIn: false };

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function renderAuthState() {
  if (me.loggedIn) {
    authBtn.textContent = `${me.user?.name || '已登录'} (退出)`;
  } else {
    authBtn.textContent = '登录 Google';
  }
}

async function loadMe() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  const reason = params.get('reason');
  if (auth === 'failed') {
    addMessage('assistant', `Google 登录失败：${escapeHtml(reason || 'unknown')}`);
    history.replaceState(null, '', '/');
  }

  const res = await fetch('/api/me');
  me = await res.json();
  renderAuthState();

  if (me.loggedIn) {
    addMessage('assistant', `已连接 Google 账号：${escapeHtml(me.user.email || me.user.name || '')}。现在告诉我你想做什么表单。`);
  } else {
    addMessage('assistant', '先登录 Google，我们才能拿到权限并帮你直接创建 Google Form。');
  }
}

authBtn.addEventListener('click', async () => {
  if (!me.loggedIn) {
    window.location.href = '/auth/google';
    return;
  }

  await fetch('/auth/logout', { method: 'POST' });
  me = { loggedIn: false };
  renderAuthState();
  addMessage('assistant', '你已退出登录。需要时可重新登录 Google。');
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = promptInput.value.trim();
  const file = sourceFileInput.files?.[0];
  if (!prompt && !file) return;

  const userMsg = [prompt, file ? `（已上传文件：${file.name}）` : ''].filter(Boolean).join(' ');
  addMessage('user', escapeHtml(userMsg));
  promptInput.value = '';
  sourceFileInput.value = '';

  if (!me.loggedIn) {
    addMessage('assistant', '你还没登录 Google。请点右上角“登录 Google”，完成授权后我就能生成表单。');
    return;
  }

  addMessage('assistant', '正在生成 Google Form，请稍等...');

  try {
    const formData = new FormData();
    if (prompt) formData.append('prompt', prompt);
    if (file) formData.append('sourceFile', file);

    const res = await fetch('/api/forms/generate', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) {
        addMessage('assistant', '授权已过期，请重新登录 Google 后重试。');
      } else {
        addMessage('assistant', `生成失败：${escapeHtml(data.message || 'unknown error')}`);
      }
      return;
    }

    const safeTitle = escapeHtml(data.title || '新表单');
    const links = [
      `<a href="${data.editUrl}" target="_blank" rel="noreferrer">编辑表单</a>`
    ];

    if (data.responderUrl) {
      links.push(`<a href="${data.responderUrl}" target="_blank" rel="noreferrer">填写链接</a>`);
    }

    const qs = (data.questions || []).map((q, i) => `${i + 1}. ${escapeHtml(q)}`).join('<br/>');
    const parseIssueLabel = data.source?.parseIssue === 'pdf_low_quality_text'
      ? 'PDF 文本质量低（乱码）'
      : data.source?.parseIssue === 'pdf_no_text'
        ? 'PDF 无可提取文字'
        : data.source?.parseIssue === 'pdf_parse_failed'
          ? 'PDF 解析失败'
          : '无';
    const sourceHint = data.source
      ? `<br/><br/>文件解析：${escapeHtml(data.source.fileName || '')} | 提取字符数 ${Number(data.source.textLength || 0)} | ${
          data.source.usedFileQuestions ? '已使用文件内容生成题目' : '未从文件抽到题目，已按文字提示生成'
        } | 可读性 ${Number(data.source.readabilityScore || 0)} | OCR ${data.source.usedOcr ? '已启用' : '未启用'} | 方式 ${escapeHtml(data.source.extractMethod || 'unknown')} | 问题 ${escapeHtml(parseIssueLabel)}`
      : '';
    const modeHint = `<br/>生成引擎：${data.generationMode === 'llm' ? `LLM (${escapeHtml(data.llmModelUsed || 'unknown')})` : '规则Fallback'}`;

    addMessage(
      'assistant',
      `已为你创建 Google Form：<b>${safeTitle}</b><br/>${links.join(' | ')}${modeHint}<br/><br/>问题草稿：<br/>${qs}${sourceHint}`
    );
  } catch (err) {
    addMessage('assistant', `请求失败：${escapeHtml(err.message || 'network error')}`);
  }
});

loadMe();
