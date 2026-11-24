// Claude Bridge chat panel (webview side).
//
// A pure renderer: the extension owns the conversation and sends it here as a
// list of items. This script draws them and turns clicks and keys into
// messages for the extension. It never touches files or the network itself.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = (sel, root = document) => root.querySelector(sel);

  // ------------------------------------------------------------------ icons
  const svg = (body, size = 14, view = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 ${view} ${view}" fill="none">${body}</svg>`;
  const S = 'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';
  const I = {
    mark: svg('<path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="currentColor" opacity=".25"/><path d="M8 4 12 8 8 12 4 8Z" fill="currentColor"/>', 16),
    markBig: svg('<path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="currentColor" opacity=".25"/><path d="M8 4 12 8 8 12 4 8Z" fill="currentColor"/>', 24),
    plus: svg(`<path d="M8 3v10M3 8h10" ${S}/>`, 16),
    gear: svg(`<circle cx="8" cy="8" r="2.2" ${S}/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" ${S}/>`, 16),
    clock: svg(`<circle cx="8" cy="8" r="6" ${S}/><path d="M8 4.8V8l2.2 1.6" ${S}/>`, 16),
    send: svg('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
    stop: svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor"/>', 12),
    chev: `<svg class="chev" width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="m6 4 4 4-4 4" ${S} stroke-width="1.5"/></svg>`,
    down: svg(`<path d="m4.5 6.5 3.5 3.5 3.5-3.5" ${S}/>`, 10),
    file: svg(`<path d="M4 1.5h5L12.5 5v9.5h-8.5Z" ${S}/><path d="M9 1.5V5h3.5" ${S}/>`, 13),
    eye: svg(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" ${S}/><circle cx="8" cy="8" r="2" fill="currentColor"/>`, 13),
    eyeOff: svg(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" ${S} opacity=".5"/><path d="m2.5 13.5 11-11" ${S}/>`, 13),
    diff: svg(`<rect x="1.5" y="2.5" width="5.5" height="11" rx="1" ${S}/><rect x="9" y="2.5" width="5.5" height="11" rx="1" ${S}/>`),
    copy: svg(`<rect x="5" y="5" width="8.5" height="8.5" rx="1.2" ${S}/><path d="M3.5 10.5h-1v-8h8v1" ${S}/>`, 13),
    check: svg('<path d="m3 8.5 3 3 7-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>', 13),
    x: svg(`<path d="m4 4 8 8M12 4l-8 8" ${S} stroke-width="1.6"/>`, 12),
    undo: svg(`<path d="M5.5 5H10a3.5 3.5 0 0 1 0 7H6" ${S}/><path d="M7.5 2.8 5.2 5l2.3 2.3" ${S}/>`, 13),
    term: svg(`<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" ${S}/><path d="m4.5 6 2 2-2 2M8 10.5h3.5" ${S}/>`),
    spark: svg('<path d="M8 1.5 9.5 6.5 14.5 8 9.5 9.5 8 14.5 6.5 9.5 1.5 8 6.5 6.5Z" fill="currentColor"/>'),
    lock: svg(`<rect x="3" y="7" width="10" height="7" rx="1.5" ${S}/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" ${S}/>`),
    trash: svg(`<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" ${S}/>`, 13),
    hand: svg(`<path d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V2.8a1 1 0 0 1 2 0V7.5M9.5 7.5V3.8a1 1 0 0 1 2 0V9a5 5 0 0 1-5 5h-.3a4 4 0 0 1-3-1.4L1.8 10.9a1 1 0 0 1 1.5-1.4l2.2 1.9" ${S}/>`, 13),
    bolt: svg('<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z" fill="currentColor"/>', 13),
    map: svg(`<path d="M2 4l4-1.5 4 1.5 4-1.5v9.5l-4 1.5-4-1.5-4 1.5Z" ${S}/><path d="M6 2.5v9.5M10 4v9.5" ${S}/>`, 13),
    cpu: svg(`<rect x="4" y="4" width="8" height="8" rx="1" ${S}/><path d="M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5h2.5M1.5 9.5h2.5M12 6.5h2.5M12 9.5h2.5" ${S}/>`, 13),
    slash: svg(`<path d="m10.5 2.5-5 11" ${S}/>`, 13),
    skill: svg('<path d="M8 1.5 9.5 6.5 14.5 8 9.5 9.5 8 14.5 6.5 9.5 1.5 8 6.5 6.5Z" fill="currentColor"/>', 12),
    ask: svg(`<circle cx="8" cy="8" r="6.2" ${S}/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.4" ${S}/><circle cx="8" cy="11.4" r=".7" fill="currentColor"/>`, 14),
    retry: svg(`<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" ${S}/>`, 13),
  };

  const MODES = {
    default: { label: 'Ask before edits', icon: I.hand, tip: 'Claude asks before every change. Shift+Tab to switch.' },
    auto: { label: 'Auto-accept edits', icon: I.bolt, tip: 'Claude\'s file changes are applied right away (you can still Undo). Commands still ask. Shift+Tab to switch.' },
    plan: { label: 'Plan mode', icon: I.map, tip: 'Claude explores and writes a plan; nothing changes until you approve it. Shift+Tab to switch.' },
  };
  const MODE_ORDER = ['default', 'auto', 'plan'];
  const EFFORTS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];

  const SLASH = [
    { cmd: '/new', alias: ['/clear'], text: 'Start a new conversation', run: () => post('new-chat') },
    { cmd: '/history', text: 'Open a previous conversation', run: () => openHistory() },
    { cmd: '/plan', text: 'Switch to plan mode', run: () => post('set-mode', { mode: 'plan' }) },
    { cmd: '/auto', text: 'Switch to auto-accept edits', run: () => post('set-mode', { mode: 'auto' }) },
    { cmd: '/ask', text: 'Switch to ask before edits', run: () => post('set-mode', { mode: 'default' }) },
    { cmd: '/model', text: 'Choose the model and effort', run: () => openMenu('model') },
    { cmd: '/skills', text: 'Choose skills (tick several)', run: () => openMenu('skills') },
    { cmd: '/undo', text: 'Undo the last applied changes', run: () => post('undo-last') },
    { cmd: '/compact', text: 'Summarize the conversation to free up room', run: () => post('compact') },
    { cmd: '/settings', text: 'Connection and allowed commands', run: () => post('show-connect') },
    { cmd: '/help', text: 'Show shortcuts and tips', run: () => showHelp() },
  ];

  // ------------------------------------------------------------------ state
  let state = {
    view: 'loading',
    connected: false,
    connecting: false,
    host: '',
    link: '',
    projectName: '',
    fileCount: 0,
    busy: false,
    activeFile: null,
    includeActive: true,
    connectError: '',
    inEditor: false,
    mode: 'default',
    model: '',
    effort: '',
    models: [],
    defaultModel: '',
    todos: [],
    allowedCommands: [],
    chatTitle: '',
    skills: [],
    activeSkills: [],
    pendingQuestions: null,
    reconnectReason: '',
  };
  let skillFilter = '';
  let qDraft = null; // { id, answers: [{ selected: [labels], other }] } for the open question popup
  let items = [];
  let files = []; // project paths for @ suggestions
  let chats = null; // saved conversations, when the history view is open
  let currentChat = '';
  let menu = null; // 'model' | null
  let todosOpen = false;
  const openFiles = new Set(); // "itemId|path" of expanded diffs
  const openActivities = new Set();

  const saved = vscode.getState() || {};
  let draft = saved.draft || '';

  /** Built-in slash commands plus one per skill ("/code-review" toggles that skill). */
  function slashEntries() {
    const taken = new Set(SLASH.map((x) => x.cmd));
    const skillCmds = (state.skills || [])
      .map((k) => ({ cmd: `/${k.name.replace(/\s+/g, '-').toLowerCase()}`, text: `${state.activeSkills.includes(k.id) ? 'Turn off' : 'Turn on'} skill · ${k.description || k.source}`, skill: k.id }))
      .filter((x) => !taken.has(x.cmd))
      .map((x) => ({ ...x, run: () => post('toggle-skill', { id: x.skill }) }));
    return SLASH.concat(skillCmds);
  }

  // ---------------------------------------------------------------- helpers
  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function post(type, payload = {}) {
    vscode.postMessage({ type, ...payload });
  }

  function elapsed(since) {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function ago(time) {
    const s = Math.floor((Date.now() - time) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(time).toLocaleDateString();
  }

  const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const modelName = (m) => (m ? m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^./, (c) => c.toUpperCase()) : 'Default');

  // --------------------------------------------------------------- markdown
  // Escape first, then add a small, safe subset of markdown.
  function inline(text) {
    let html = esc(text);
    const codes = [];
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    html = html
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="#" data-action="link" data-url="${url}">${label}</a>`);
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const code = codes[Number(i)];
      // `src/file.js` or `src/file.js:12` that exists in the project becomes a link.
      const m = /^([\w./@-]+?)(?::(\d+))?$/.exec(code.replace(/&amp;/g, '&'));
      if (m && files.includes(m[1])) return `<code class="file-link" data-action="open-file" data-path="${esc(m[1])}" data-line="${m[2] || ''}">${code}</code>`;
      return `<code>${code}</code>`;
    });
  }

  function markdown(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let para = [];
    let list = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((li) => `<li>${inline(li)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
      if (fence) {
        flushPara();
        flushList();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        while (code.length && !code[0].trim()) code.shift();
        while (code.length && !code[code.length - 1].trim()) code.pop();
        out.push(
          `<div class="codeblock"><div class="codeblock-head"><span>${esc(fence[1] || 'text')}</span>` +
            `<button class="icon-btn" data-action="copy-code" title="Copy">${I.copy}</button></div>` +
            `<pre><code>${esc(code.join('\n'))}</code></pre></div>`
        );
        continue;
      }
      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }
      const heading = /^\s*(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushPara();
        flushList();
        out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
        continue;
      }
      const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet) {
        flushPara();
        const tag = /\d/.test(bullet[1]) ? 'ol' : 'ul';
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, items: [] };
        }
        list.items.push(bullet[2]);
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`;
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
    return out.join('');
  }

  // ------------------------------------------------------------- rendering
  function renderTopbar() {
    const dot = state.connected ? 'ok' : state.view === 'connect' ? '' : 'bad';
    const sub = state.view === 'chat' ? state.chatTitle || `${state.projectName || 'no folder'} · ${state.host}` : state.connected ? state.host : 'Not connected';
    const chat = state.view === 'chat';
    return `
      <div class="topbar">
        <div class="brand">
          <span class="brand-mark">${I.mark}</span>
          <span class="brand-name">Claude Bridge</span>
          <span class="status-dot ${dot}" title="${state.connected ? `Connected to ${esc(state.host)} · encrypted` : 'Not connected'}"></span>
          <span class="brand-sub" title="${esc(sub)}">${esc(sub)}</span>
        </div>
        ${chat ? `<button class="icon-btn" data-action="history" title="Past conversations">${I.clock}</button>` : ''}
        ${chat ? `<button class="icon-btn" data-action="new-chat" title="New conversation">${I.plus}</button>` : ''}
        <button class="icon-btn" data-action="show-connect" title="Settings">${I.gear}</button>
      </div>`;
  }

  function renderConnect() {
    const allowed = state.allowedCommands || [];
    return `
      <div class="connect">
        <div class="welcome-mark">${I.markBig}</div>
        <h1 class="connect-title">${state.reconnectReason ? (state.reconnectReason === 'code' ? 'Enter the access code again' : 'The link stopped working') : state.connected ? 'Settings' : 'Connect to a host'}</h1>
        <p class="connect-sub">${state.reconnectReason
          ? 'Ask the host for the current link and access code and enter them below. Your conversation is kept.'
          : 'Enter the link and the access code you got from the person sharing their Claude.'}</p>
        <form id="connect-form" autocomplete="off">
          <div class="field">
            <label for="link">Link</label>
            <input id="link" type="url" placeholder="https://example-words.trycloudflare.com" value="${esc(state.link || '')}" required>
          </div>
          <div class="field">
            <label for="code">Access code</label>
            <input id="code" type="password" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" required>
            <small>Stored in VS Code's secret storage. It is never sent — it encrypts the connection.</small>
          </div>
          <div class="form-error">${esc(state.connectError || '')}</div>
          <button class="btn btn-primary" type="submit" ${state.connecting ? 'disabled' : ''}>${state.connecting ? 'Connecting…' : 'Connect'}</button>
          ${state.connected || state.reconnectReason ? '<button class="btn btn-ghost wide" type="button" data-action="back-to-chat">Back to chat</button>' : ''}
          ${state.link ? '<button class="btn btn-ghost wide" type="button" data-action="disconnect">Forget saved link and code</button>' : ''}
          ${state.connected ? `
            <div class="settings-section">
              <div class="settings-title">Always-allowed commands <span class="note">(this workspace)</span></div>
              ${allowed.length
                ? allowed.map((c) => `<div class="allowed"><code>${esc(c)}</code><button type="button" class="icon-btn" data-action="remove-allowed" data-command="${esc(c)}" title="Remove">${I.trash}</button></div>`).join('')
                : '<div class="note">None. Use "Always allow" on a command card to run that exact command without asking.</div>'}
            </div>` : ''}
          <div class="privacy">${I.lock}<span>Claude reads files in this folder when it needs them. Nothing is written and no command runs until you approve it, unless you turn on auto-accept or always-allow.</span></div>
        </form>
      </div>`;
  }

  function renderHistory() {
    const list = chats || [];
    return `
      <div class="history">
        <div class="history-head">
          <span class="settings-title">Past conversations</span>
          <button class="btn btn-ghost btn-small" data-action="close-history">Close</button>
        </div>
        ${list.length === 0 ? '<div class="note" style="padding:12px 2px">No saved conversations in this workspace yet.</div>' : ''}
        ${list
          .map(
            (c) => `
          <div class="chat-row ${c.id === currentChat ? 'current' : ''}" data-action="open-chat" data-id="${esc(c.id)}">
            <div class="chat-main"><div class="chat-title">${esc(c.title || 'Untitled')}</div>
            <div class="note">${ago(c.updatedAt)} · ${c.messages} message${c.messages === 1 ? '' : 's'}${c.id === currentChat ? ' · current' : ''}</div></div>
            <button class="icon-btn" data-action="delete-chat" data-id="${esc(c.id)}" title="Delete">${I.trash}</button>
          </div>`
          )
          .join('')}
      </div>`;
  }

  function renderWelcome() {
    const active = state.activeFile && state.activeFile.path;
    const suggestions = [
      ['Explain how this project is organized', 'Give me a tour of this project: what it does, how it is organized and where the main entry points are.'],
      active ? [`Review ${active.split('/').pop()} for bugs`, `Review @${active} for bugs and risky code, and fix what you find.`] : ['Find likely bugs', 'Look through the project for likely bugs and explain the most important ones.'],
      ['Plan a new feature', '/plan'],
      ['Add tests for the core logic', 'Find the core logic of this project and add tests for it, following the existing test setup if there is one.'],
    ];
    return `
      <div class="welcome">
        <div class="welcome-mark">${I.markBig}</div>
        <h1>What should we work on?</h1>
        <p>Claude can explore <strong>${esc(state.projectName || 'this folder')}</strong>${state.fileCount ? ` (${state.fileCount} files)` : ''} by itself. You approve every change.</p>
        <div class="suggestions">
          ${suggestions.map(([label, prompt]) => `<button class="suggestion" data-action="suggest" data-prompt="${esc(prompt)}">${I.spark}<span>${esc(label)}</span></button>`).join('')}
        </div>
        <p class="note" style="margin-top:16px">Type <kbd>/</kbd> for commands · <kbd>@</kbd> to mention a file · <kbd>Shift</kbd>+<kbd>Tab</kbd> to switch mode</p>
      </div>`;
  }

  function stepHtml(step) {
    if (step.kind === 'plan') return `<div class="step plan">${esc(step.text)}</div>`;
    const verb = { read: 'Read', search: 'Search', added: 'Added', skip: 'Skipped', missing: 'Missing' }[step.kind] || step.kind;
    const clickable = (step.kind === 'read' || step.kind === 'added') && !step.error;
    const target = step.kind === 'search' ? `"${esc(step.text)}"` : esc(step.text);
    return `
      <div class="step ${step.error ? 'err' : ''}">
        <span class="step-verb">${verb}</span>
        <span class="step-target ${clickable ? 'link' : ''}" ${clickable ? `data-action="open-file" data-path="${esc(step.text)}"` : ''} title="${esc(step.text)}">${target}</span>
        ${step.detail ? `<span class="step-detail">${esc(step.detail)}</span>` : ''}
      </div>`;
  }

  /** "Thinking", or "Waiting for the host" while other people's requests run first. */
  function thinkingLine(item) {
    const q = item.queue;
    const waiting = q && q.state === 'queued' && q.ahead > 0;
    const label = waiting
      ? `Waiting for the host · ${q.ahead} request${q.ahead === 1 ? '' : 's'} ahead of you`
      : item.round > 1 ? `Thinking · step ${item.round}` : 'Thinking';
    return `<div class="thinking"><span class="pulse ${waiting ? 'waiting' : ''}"></span><span class="shimmer">${label}</span>` +
      `<span class="elapsed" data-since="${item.startedAt}">${elapsed(item.startedAt)}</span><span class="note">· esc to stop</span></div>` +
      (waiting ? '<div class="note queue-note">The host runs one request at a time. Yours starts automatically.</div>' : '');
  }

  function renderActivity(item) {
    const reads = item.steps.filter((s) => s.kind === 'read' && !s.error).length;
    const searches = item.steps.filter((s) => s.kind === 'search').length;
    const running = item.status === 'running';
    const parts = [];
    if (reads) parts.push(`${reads} file${reads === 1 ? '' : 's'}`);
    if (searches) parts.push(`${searches} search${searches === 1 ? '' : 'es'}`);
    const summary = running
      ? parts.length ? `Exploring · ${parts.join(', ')}` : item.queue && item.queue.state === 'queued' ? 'In the queue' : 'Working'
      : `${parts.length ? `Explored ${parts.join(', ')}` : 'Thought'} for ${item.seconds || 0}s`;
    const open = openActivities.has(item.id);
    const hasSteps = item.steps.length > 0;
    return `
      <div class="activity ${running ? 'running' : ''} ${open ? 'open' : ''} dotted muted">
        <button class="activity-head" data-action="toggle-activity" data-id="${item.id}" ${hasSteps ? '' : 'disabled'}>
          <span>${esc(summary)}</span>${hasSteps && !running ? I.chev : ''}
        </button>
        ${hasSteps ? `<div class="activity-steps">${item.steps.map(stepHtml).join('')}</div>` : ''}
        ${running ? thinkingLine(item) : ''}
      </div>`;
  }

  function renderAssistant(item) {
    const u = item.usage;
    const meta = u
      ? [modelName(u.model), u.rounds > 1 ? `${u.rounds} steps` : '', `${(u.durationMs / 1000).toFixed(1)}s`, `${tokens(u.inputTokens)} in · ${tokens(u.outputTokens)} out`].filter(Boolean).join(' · ')
      : '';
    return `
      <div class="assistant dotted">
        <div class="md">${markdown(item.markdown)}</div>
        <div class="msg-tools">
          ${meta ? `<span class="note usage">${esc(meta)}</span>` : ''}
          <button class="icon-btn" data-action="copy-message" data-id="${item.id}" title="Copy answer">${I.copy}</button>
        </div>
      </div>`;
  }

  function diffHtml(file) {
    if (!file.hunks || !file.hunks.length) return '<div class="diff"><div class="dl gap">no textual changes</div></div>';
    const rows = [];
    file.hunks.forEach((hunk, h) => {
      if (h > 0) rows.push('<div class="dl gap">⋯</div>');
      for (const l of hunk) {
        const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : '';
        const no = l.t === '-' ? l.o : l.n;
        rows.push(`<div class="dl ${cls}"><span class="no">${no || ''}</span><span class="sign">${l.t === ' ' ? '' : l.t}</span><span class="txt">${esc(l.x)}</span></div>`);
      }
    });
    if (file.more) rows.push(`<div class="dl gap">… ${file.more} more lines — open the diff to see everything</div>`);
    return `<div class="diff">${rows.join('')}</div>`;
  }

  const BADGES = {
    applied: '<span class="badge done">APPLIED</span>',
    rejected: '<span class="badge same">REJECTED</span>',
    undone: '<span class="badge same">UNDONE</span>',
    failed: '<span class="badge blocked">FAILED</span>',
    expired: '<span class="badge same">NOT APPLIED</span>',
  };

  function renderChanges(item) {
    const writable = item.files.filter((f) => f.status === 'new' || f.status === 'modified');
    const added = writable.reduce((n, f) => n + f.added, 0);
    const removed = writable.reduce((n, f) => n + f.removed, 0);
    const pending = writable.filter((f) => f.decision === 'pending');
    const applied = writable.filter((f) => f.decision === 'applied');
    const rows = item.files.map((f) => {
      const key = `${item.id}|${f.path}`;
      const canDiff = f.status === 'new' || f.status === 'modified';
      const badge =
        f.status === 'blocked' ? '<span class="badge blocked">BLOCKED</span>'
        : f.status === 'unchanged' ? '<span class="badge same">SAME</span>'
        : BADGES[f.decision] || (f.status === 'new' ? '<span class="badge new">NEW</span>' : '<span class="badge edit">EDIT</span>');
      const decide = f.decision === 'pending'
        ? `<span class="row-actions">
             <span class="icon-btn ok" role="button" data-action="apply" data-id="${item.id}" data-path="${esc(f.path)}" title="Accept this file">${I.check}</span>
             <span class="icon-btn no" role="button" data-action="reject" data-id="${item.id}" data-path="${esc(f.path)}" title="Reject this file">${I.x}</span>
           </span>`
        : '';
      return `
        <div class="file ${openFiles.has(key) ? 'open' : ''}">
          <div class="file-row" data-action="toggle-file" data-key="${esc(key)}" ${canDiff ? '' : 'data-disabled="1"'}>
            ${canDiff ? I.chev : '<span style="width:12px"></span>'}
            ${badge}
            <span class="file-path" title="${esc(f.path)}">${esc(f.path)}</span>
            ${canDiff ? `<span class="stat-add">+${f.added}</span><span class="stat-del">−${f.removed}</span>` : ''}
            ${canDiff ? `<span class="icon-btn" role="button" data-action="open-diff" data-id="${item.id}" data-path="${esc(f.path)}" title="${f.decision === 'pending' ? 'Open diff in editor' : 'Open file'}">${I.diff}</span>` : ''}
            ${decide}
          </div>
          ${f.status === 'blocked' ? `<div class="blocked-note">${esc(f.error)}</div>` : ''}
          ${f.note ? `<div class="blocked-note">${esc(f.note)}</div>` : ''}
          ${canDiff ? diffHtml(f) : ''}
        </div>`;
    });
    let foot;
    if (pending.length) {
      foot = `<button class="btn btn-primary" data-action="apply" data-id="${item.id}">${I.check} Accept${pending.length > 1 ? ' all' : ''}</button>
              <button class="btn btn-ghost" data-action="reject" data-id="${item.id}">Reject${pending.length > 1 ? ' all' : ''}</button>
              <span class="spacer"></span><span class="note">or decide per file</span>`;
    } else if (applied.length) {
      foot = `<span class="result-ok">${I.check}</span><span class="note">${applied.length === writable.length ? 'Applied' : `${applied.length} of ${writable.length} applied`}</span>
              <span class="spacer"></span><button class="btn btn-ghost btn-small" data-action="undo" data-id="${item.id}">${I.undo} Undo</button>`;
    } else if (!writable.length) {
      foot = '<span class="note">Nothing can be applied.</span>';
    } else {
      const states = new Set(writable.map((f) => f.decision));
      foot = `<span class="note">${states.has('undone') ? 'Undone' : states.has('expired') ? 'Not applied (from an earlier session)' : 'Rejected'}</span>`;
    }
    return `
      <div class="card ${pending.length ? 'pending' : ''}">
        <div class="card-head">
          <span class="card-title">${writable.length} file${writable.length === 1 ? '' : 's'} changed</span>
          <span class="stat-add">+${added}</span><span class="stat-del">−${removed}</span>
        </div>
        ${rows.join('')}
        <div class="card-foot">${foot}</div>
      </div>`;
  }

  function renderCommand(item) {
    const states = {
      pending: `<button class="btn btn-primary" data-action="run" data-id="${item.id}">${I.term} Run</button>
                <button class="btn btn-ghost" data-action="allow-command" data-id="${item.id}" title="Run now and never ask again for this exact command in this workspace">Always allow</button>
                <button class="btn btn-ghost" data-action="skip" data-id="${item.id}">Skip</button>`,
      running: `<span class="pulse"></span><span class="shimmer">Running</span><span class="elapsed" data-since="${item.startedAt}">${elapsed(item.startedAt)}</span>
                <span class="spacer"></span><button class="btn btn-ghost btn-small" data-action="stop-command" data-id="${item.id}">Stop</button>`,
      done: `<span class="${item.code === 0 ? 'result-ok' : 'result-bad'}">${item.code === 0 ? I.check : ''}</span><span class="${item.code === 0 ? 'note' : 'result-bad'}">${esc(item.status || '')}</span>${item.auto ? '<span class="spacer"></span><span class="note">always allowed</span>' : ''}`,
      skipped: '<span class="note">Skipped</span>',
      expired: '<span class="note">Not run (from an earlier session)</span>',
      blocked: '<span class="result-bad">Blocked: the command contains hidden control characters.</span>',
    };
    return `
      <div class="card ${item.state === 'pending' ? 'pending' : ''}">
        <div class="cmd-line"><span class="prompt">$</span><span>${esc(item.command)}</span></div>
        ${item.output ? `<pre class="cmd-out">${esc(item.output)}</pre>` : ''}
        <div class="card-foot">${states[item.state] || ''}</div>
      </div>`;
  }

  function renderPlanApproval(item) {
    if (item.state !== 'pending') {
      const text = { approved: 'Plan approved · ask before edits', 'approved-auto': 'Plan approved · auto-accept edits', kept: 'Still planning', expired: 'Plan from an earlier session' }[item.state] || '';
      return `<div class="note dotted muted">${esc(text)}</div>`;
    }
    return `
      <div class="card pending plan-card">
        <div class="card-head"><span class="card-title">${I.map} Ready to code?</span></div>
        <div class="plan-body note">Claude made a plan and changed nothing. Choose how to continue:</div>
        <div class="card-foot wrap">
          <button class="btn btn-primary" data-action="plan-decision" data-id="${item.id}" data-decision="approve">Yes, ask before edits</button>
          <button class="btn btn-ghost" data-action="plan-decision" data-id="${item.id}" data-decision="auto">Yes, auto-accept edits</button>
          <button class="btn btn-ghost" data-action="plan-decision" data-id="${item.id}" data-decision="keep">No, keep planning</button>
        </div>
      </div>`;
  }

  function renderQuestionsItem(item) {
    const status = {
      pending: '<span class="note">Waiting for your answer below</span>',
      skipped: '<span class="note">Skipped — Claude continues with its own judgement</span>',
      dismissed: '<span class="note">Answered in chat</span>',
      expired: '<span class="note">From an earlier session</span>',
    }[item.state] || '';
    const rows = item.questions.map((q, i) => {
      const a = item.answers && item.answers[i];
      const answer = a ? [...(a.selected || []), ...(a.other ? [a.other] : [])].join(', ') : '';
      return `<div class="q-summary"><div class="q-summary-q">${q.header ? `<span class="q-header">${esc(q.header)}</span>` : ''}${esc(q.question)}</div>
        ${answer ? `<div class="q-summary-a">${I.check}<span>${esc(answer)}</span></div>` : ''}</div>`;
    });
    return `<div class="card questions-card ${item.state === 'pending' ? 'pending' : ''}">
      <div class="card-head"><span class="card-title">${I.ask} Claude has ${item.questions.length === 1 ? 'a question' : `${item.questions.length} questions`}</span></div>
      <div class="q-summaries">${rows.join('')}</div>
      ${item.state !== 'answered' ? `<div class="card-foot">${status}</div>` : ''}
    </div>`;
  }

  /** The docked popup that replaces the message box while Claude waits for answers. */
  function renderQuestionPanel(item) {
    if (!qDraft || qDraft.id !== item.id) qDraft = { id: item.id, answers: item.questions.map(() => ({ selected: [], other: '' })) };
    const ready = item.questions.every((q, i) => qDraft.answers[i].selected.length || qDraft.answers[i].other.trim());
    const blocks = item.questions.map((q, qi) => {
      const a = qDraft.answers[qi];
      const opts = q.options.map((o, oi) => {
        const on = a.selected.includes(o.label);
        return `<button class="q-option ${on ? 'on' : ''} ${q.multiSelect ? 'multi' : ''}" data-action="q-pick" data-q="${qi}" data-o="${oi}">
          <span class="q-mark">${on ? I.check : ''}</span>
          <span class="q-text"><span class="q-label">${esc(o.label)}</span>${o.description ? `<span class="q-desc">${esc(o.description)}</span>` : ''}</span>
        </button>`;
      });
      return `<div class="q-block">
        <div class="q-title">${q.header ? `<span class="q-header">${esc(q.header)}</span>` : ''}<span>${esc(q.question)}</span></div>
        ${q.multiSelect ? '<div class="note q-hint">Select all that apply</div>' : ''}
        <div class="q-options">${opts.join('')}</div>
        <input class="q-other" data-q="${qi}" placeholder="Or type your own answer…" value="${esc(a.other)}">
      </div>`;
    });
    return `<div class="question-panel" id="question-panel">
      <div class="q-panel-head">${I.ask}<span>Claude needs your input</span></div>
      <div class="q-blocks">${blocks.join('')}</div>
      <div class="q-actions">
        <button class="btn btn-ghost" data-action="q-skip" data-id="${item.id}">Skip</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" data-action="q-submit" data-id="${item.id}" ${ready && !state.busy ? '' : 'disabled'}>${I.send} Submit answers</button>
      </div>
    </div>`;
  }

  function renderItem(item) {
    switch (item.kind) {
      case 'user':
        return `<div class="msg-user">${item.mode === 'plan' ? `<span class="mode-tag">${I.map} plan</span>` : ''}${(item.skills || []).map((k) => `<span class="skill-tag">${I.skill} ${esc(k)}</span>`).join('')}${esc(item.text)}</div>`;
      case 'activity':
        return renderActivity(item);
      case 'assistant':
        return renderAssistant(item);
      case 'changes':
        return renderChanges(item);
      case 'command':
        return renderCommand(item);
      case 'plan-approval':
        return renderPlanApproval(item);
      case 'questions':
        return renderQuestionsItem(item);
      case 'compacted':
        return `<div class="compacted"><div class="compacted-head">${I.spark} Conversation compacted — Claude continues from this summary</div><div class="md">${markdown(item.summary)}</div></div>`;
      case 'error':
        return `<div class="error-card"><strong>Something went wrong.</strong> ${esc(item.message)}
          <div class="error-actions">
            ${item.reconnect ? `<button class="btn btn-primary btn-small" data-action="show-connect">${I.gear} Enter new link &amp; code</button>` : ''}
            ${item.retry ? `<button class="btn btn-ghost btn-small" data-action="retry">${I.retry} Retry</button>` : ''}
          </div></div>`;
      case 'info':
        return `<div class="note dotted muted">${esc(item.text)}</div>`;
      default:
        return '';
    }
  }

  function itemNode(item) {
    const node = document.createElement('div');
    node.className = 'item';
    node.dataset.id = item.id;
    node.innerHTML = renderItem(item);
    return node;
  }

  function renderTodos() {
    const todos = state.todos || [];
    if (!todos.length) return '';
    const done = todos.filter((t) => t.status === 'completed').length;
    const current = todos.find((t) => t.status === 'in_progress') || todos.find((t) => t.status === 'pending');
    return `
      <div class="todos ${todosOpen ? 'open' : ''}">
        <button class="todos-head" data-action="toggle-todos">
          ${I.chev}<span class="todos-count">Tasks ${done}/${todos.length}</span>
          <span class="todos-current">${current ? esc(current.content) : 'All done'}</span>
        </button>
        <div class="todos-list">
          ${todos.map((t) => `<div class="todo ${t.status}"><span class="box">${t.status === 'completed' ? I.check : ''}</span><span>${esc(t.content)}</span></div>`).join('')}
        </div>
      </div>`;
  }

  function renderSkillsMenu() {
    const q = skillFilter.toLowerCase();
    const list = (state.skills || []).filter((k) => !q || k.name.toLowerCase().includes(q) || (k.description || '').toLowerCase().includes(q));
    const active = state.activeSkills || [];
    return `
      <div class="popup skills-popup" id="popup">
        <div class="popup-title">Skills <span class="count">${active.length} on</span></div>
        <input class="popup-search" id="skill-search" placeholder="Search skills…" value="${esc(skillFilter)}">
        <div class="skill-list">
          ${list.length ? '' : '<div class="popup-note">No skills match.</div>'}
          ${list.map((k) => `<button class="skill-item ${active.includes(k.id) ? 'on' : ''}" data-action="toggle-skill" data-id="${esc(k.id)}">
              <span class="skill-box">${active.includes(k.id) ? I.check : ''}</span>
              <span class="skill-text"><span class="skill-name">${esc(k.name)} <span class="skill-src ${esc(k.source)}">${esc(k.source)}</span></span>
              ${k.description ? `<span class="skill-desc">${esc(k.description)}</span>` : ''}</span>
            </button>`).join('')}
        </div>
        <div class="popup-foot">
          ${active.length ? '<button class="link-btn" data-action="clear-skills">Turn all off</button>' : '<span class="note">Tick several</span>'}
          <span class="spacer"></span>
          <button class="btn btn-primary btn-small" data-action="close-menu">Done</button>
        </div>
        <div class="popup-note">Add your own: <code>.claude/skills/&lt;name&gt;/SKILL.md</code> in the project or your home folder.</div>
      </div>`;
  }

  function renderMenu() {
    if (menu === 'skills') return renderSkillsMenu();
    if (menu !== 'model') return '';
    const models = [''].concat(state.models || []);
    const none = !(state.models || []).length
      ? `<div class="popup-note">The host's server does not offer a model choice yet — it is an older version. Ask the host to restart it with the latest <code>server.js</code>. <button class="link-btn" data-action="refresh-models">Check again</button></div>`
      : '';
    return `
      <div class="popup" id="popup">
        <div class="popup-title">Model</div>
        ${none}
        ${models
          .map((m) => `<button class="popup-item ${m === state.model ? 'active' : ''}" data-action="pick-model" data-model="${esc(m)}">
            <span>${m ? esc(modelName(m)) : `Host default${state.defaultModel ? ` (${esc(modelName(state.defaultModel))})` : ''}`}</span>${m === state.model ? I.check : ''}</button>`)
          .join('')}
        <div class="popup-title">Effort</div>
        <div class="effort-row">
          ${EFFORTS.map(([v, label]) => `<button class="effort ${v === state.effort ? 'active' : ''}" data-action="pick-effort" data-effort="${v}">${label}</button>`).join('')}
        </div>
      </div>`;
  }

  function renderComposer() {
    const af = state.activeFile;
    const mode = MODES[state.mode] || MODES.default;
    const chip = af
      ? `<button class="chip ${state.includeActive ? 'on' : ''}" data-action="toggle-active" title="${state.includeActive ? 'Claude sees this file (and your selection) — click to exclude it' : 'Click to let Claude see this file'}">
           ${state.includeActive ? I.eye : I.eyeOff}<span>${esc(af.path.split('/').pop())}${af.selection ? `:${esc(af.selection)}` : ''}</span>
         </button>`
      : '';
    const pendingQ = state.pendingQuestions && items.find((i) => i.id === state.pendingQuestions && i.kind === 'questions' && i.state === 'pending');
    if (pendingQ) {
      return `<div class="composer">${renderQuestionPanel(pendingQ)}</div>`;
    }
    const activeSkills = (state.activeSkills || []).map((id) => (state.skills || []).find((k) => k.id === id)).filter(Boolean);
    const skillChips = activeSkills.length
      ? `<div class="skill-chips">${activeSkills.map((k) => `<span class="skill-chip" title="${esc(k.description || k.source)}">${I.skill}<span>${esc(k.name)}</span><button class="chip-x" data-action="toggle-skill" data-id="${esc(k.id)}" title="Turn off">${I.x}</button></span>`).join('')}</div>`
      : '';
    return `
      <div class="composer">
        ${renderTodos()}
        <div class="mention-menu hidden" id="mentions"></div>
        ${renderMenu()}
        <div class="composer-box mode-${state.mode}">
          ${skillChips}
          <textarea id="input" rows="1" placeholder="${state.busy ? 'Claude is working…' : state.mode === 'plan' ? 'Describe what to plan…' : 'Ask Claude about this project…'}"></textarea>
          <div class="composer-row">
            <button class="chip mode ${state.mode}" data-action="cycle-mode" title="${esc(mode.tip)}">${mode.icon}<span>${mode.label}</span></button>
            ${chip}
            <button class="chip skills ${activeSkills.length ? 'on' : ''}" data-action="toggle-skills-menu" title="Skills: instruction sets Claude follows (tick several)">${I.skill}<span>${activeSkills.length ? `${activeSkills.length} skill${activeSkills.length === 1 ? '' : 's'}` : 'Skills'}</span></button>
            <span class="spacer"></span>
            <button class="chip model" data-action="toggle-model-menu" title="Model and effort">${I.cpu}<span>${esc(state.model ? modelName(state.model) : 'Default')}${state.effort ? ` · ${esc(state.effort)}` : ''}</span>${I.down}</button>
            ${state.busy
              ? `<button class="send stop" data-action="stop" title="Stop (Esc)">${I.stop}</button>`
              : `<button class="send" data-action="send" id="send" title="Send (Enter)">${I.send}</button>`}
          </div>
        </div>
      </div>`;
  }

  // Full render for structural changes; items are patched individually.
  function renderAll() {
    const keepDraft = $('#input') ? $('#input').value : draft;
    document.body.classList.toggle('in-editor', Boolean(state.inEditor));
    if (state.view === 'loading') {
      document.body.innerHTML = renderTopbar();
      return;
    }
    if (state.view === 'connect') {
      document.body.innerHTML = renderTopbar() + renderConnect();
      const target = state.link ? $('#code') : $('#link');
      if (target) target.focus();
      return;
    }
    if (chats) {
      document.body.innerHTML = renderTopbar() + renderHistory();
      return;
    }
    document.body.innerHTML = `${renderTopbar()}<div id="transcript"></div>${renderComposer()}`;
    const transcript = $('#transcript');
    if (items.length === 0) transcript.innerHTML = renderWelcome();
    else for (const item of items) transcript.appendChild(itemNode(item));
    const input = $('#input');
    if (input) {
      input.value = keepDraft;
      autosize();
      updateSendButton();
      input.focus();
    }
    scrollToBottom(true);
  }

  function renderComposerOnly() {
    const old = $('.composer');
    if (!old) return renderAll();
    const value = $('#input') ? $('#input').value : draft;
    const hadFocus = document.activeElement === $('#input');
    const searchFocus = document.activeElement && document.activeElement.id === 'skill-search';
    const wrap = document.createElement('div');
    wrap.innerHTML = renderComposer();
    old.replaceWith(wrap.firstElementChild);
    if ($('#input')) {
      $('#input').value = value;
      autosize();
      updateSendButton();
      if (hadFocus) $('#input').focus();
    }
    if (searchFocus && $('#skill-search')) {
      const el = $('#skill-search');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  function renderTopbarOnly() {
    const top = $('.topbar');
    if (!top) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = renderTopbar();
    top.replaceWith(wrap.firstElementChild);
  }

  function upsertItem(item) {
    const index = items.findIndex((i) => i.id === item.id);
    const transcript = $('#transcript');
    if (index >= 0) items[index] = item;
    else items.push(item);
    if (!transcript) return;
    if (items.length === 1 && index < 0) transcript.innerHTML = '';
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    const existing = transcript.querySelector(`.item[data-id="${CSS.escape(item.id)}"]`);
    const node = itemNode(item);
    if (existing) {
      const outScroll = existing.querySelector('.cmd-out');
      const keepOutBottom = outScroll && outScroll.scrollHeight - outScroll.scrollTop - outScroll.clientHeight < 20;
      node.style.animation = 'none';
      existing.replaceWith(node);
      const newOut = node.querySelector('.cmd-out');
      if (newOut && (keepOutBottom || !outScroll)) newOut.scrollTop = newOut.scrollHeight;
    } else {
      transcript.appendChild(node);
    }
    if (nearBottom || index < 0) scrollToBottom();
  }

  function scrollToBottom(instant) {
    const transcript = $('#transcript');
    if (!transcript) return;
    if (instant) transcript.style.scrollBehavior = 'auto';
    transcript.scrollTop = transcript.scrollHeight;
    if (instant) requestAnimationFrame(() => (transcript.style.scrollBehavior = ''));
  }

  // ------------------------------------------------------------- composer
  function autosize() {
    const input = $('#input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }

  function updateSendButton() {
    const send = $('#send');
    const input = $('#input');
    if (send && input) send.disabled = !input.value.trim();
  }

  function saveDraft() {
    const input = $('#input');
    draft = input ? input.value : draft;
    vscode.setState({ draft });
  }

  function clearInput() {
    const input = $('#input');
    if (input) input.value = '';
    draft = '';
    vscode.setState({ draft });
    autosize();
    updateSendButton();
  }

  function submit(text) {
    const input = $('#input');
    const value = (text !== undefined ? text : input.value).trim();
    if (!value) return;
    closePopups();
    const slash = /^\/[\w.:-]+$/i.test(value) && slashEntries().find((s) => s.cmd === value.toLowerCase() || (s.alias || []).includes(value.toLowerCase()));
    if (slash) {
      clearInput();
      slash.run();
      return;
    }
    if (state.busy) return;
    post('send', { text: value });
    clearInput();
  }

  function cycleMode() {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(state.mode) + 1) % MODE_ORDER.length];
    post('set-mode', { mode: next });
  }

  function openMenu(name) {
    menu = name;
    renderComposerOnly();
  }

  function openHistory() {
    chats = chats || [];
    renderAll();
    post('history');
  }

  function showHelp() {
    const text =
      'Enter send · Shift+Enter new line · Esc stop · Shift+Tab switch mode (ask / auto-accept / plan) · @ mention a file (Alt+K in the editor inserts the selection) · / commands: ' +
      SLASH.map((s) => s.cmd).join(' ') + ' and /<skill-name> to toggle a skill' +
      ' · Ctrl+Esc focuses this chat.';
    upsertItem({ id: `help-${Date.now()}`, kind: 'info', text });
  }

  // @ mentions and / commands ------------------------------------------
  let popup = null; // { kind: 'mention'|'slash', start, query, matches, index }

  function popupContext() {
    const input = $('#input');
    if (!input) return null;
    const before = input.value.slice(0, input.selectionStart);
    const slash = /^\/([\w.:-]*)$/i.exec(before);
    if (slash) return { kind: 'slash', start: 0, query: slash[1].toLowerCase() };
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (m) return { kind: 'mention', start: before.length - m[2].length, query: m[2] };
    return null;
  }

  function rankFiles(query) {
    const q = query.toLowerCase().replace(/#.*$/, '');
    const scored = [];
    for (const p of files) {
      const lower = p.toLowerCase();
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      let score = -1;
      if (!q) score = 1;
      else if (base.startsWith(q)) score = 4;
      else if (base.includes(q)) score = 3;
      else if (lower.includes(q)) score = 2;
      if (score > 0) scored.push([score, p]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
    return scored.slice(0, 8).map((s) => s[1]);
  }

  function updatePopup() {
    const ctx = popupContext();
    const box = $('#mentions');
    if (!ctx || !box) return closePopup();
    let matches;
    if (ctx.kind === 'mention') {
      if (files.length === 0) post('request-files');
      matches = rankFiles(ctx.query);
    } else {
      matches = slashEntries().filter((s) => s.cmd.slice(1).startsWith(ctx.query) || (s.alias || []).some((a) => a.slice(1).startsWith(ctx.query))).map((s) => s.cmd).slice(0, 12);
    }
    if (!matches.length) return closePopup();
    const index = popup && popup.kind === ctx.kind && popup.query === ctx.query ? Math.min(popup.index, matches.length - 1) : 0;
    popup = { ...ctx, matches, index };
    box.innerHTML = matches
      .map((value, i) => {
        if (ctx.kind === 'slash') {
          const s = slashEntries().find((x) => x.cmd === value);
          return `<button class="mention ${i === index ? 'active' : ''}" data-action="pick-popup" data-value="${esc(value)}">${s.skill ? I.skill : I.slash}<span class="base">${esc(value)}</span><span class="dir">${esc(s.text)}</span></button>`;
        }
        const slash = value.lastIndexOf('/');
        return `<button class="mention ${i === index ? 'active' : ''}" data-action="pick-popup" data-value="${esc(value)}">${I.file}<span class="base">${esc(value.slice(slash + 1))}</span><span class="dir">${esc(slash > 0 ? value.slice(0, slash) : '')}</span></button>`;
      })
      .join('');
    box.classList.remove('hidden');
  }

  function closePopup() {
    popup = null;
    const box = $('#mentions');
    if (box) box.classList.add('hidden');
  }

  function closePopups() {
    closePopup();
    if (menu) {
      menu = null;
      renderComposerOnly();
    }
  }

  function pickPopup(value) {
    const input = $('#input');
    const ctx = popupContext();
    if (!input || !ctx) return;
    if (ctx.kind === 'slash') {
      closePopup();
      submit(value);
      return;
    }
    const before = input.value.slice(0, ctx.start);
    const after = input.value.slice(input.selectionStart);
    input.value = `${before}${value} ${after}`;
    const caret = before.length + value.length + 1;
    input.setSelectionRange(caret, caret);
    input.focus();
    closePopup();
    autosize();
    updateSendButton();
    saveDraft();
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (menu && !event.target.closest('#popup') && !(el && (el.dataset.action === 'toggle-model-menu' || el.dataset.action === 'toggle-skills-menu'))) {
      menu = null;
      renderComposerOnly();
      if (!el) return;
    }
    if (!el) return;
    const { action, id, path, key } = el.dataset;
    switch (action) {
      case 'send': submit(); break;
      case 'stop': post('stop'); break;
      case 'new-chat': chats = null; post('new-chat'); break;
      case 'history': openHistory(); break;
      case 'close-history': chats = null; renderAll(); break;
      case 'open-chat': chats = null; renderAll(); post('open-chat', { id }); break;
      case 'delete-chat': event.stopPropagation(); post('delete-chat', { id }); break;
      case 'show-connect': post('show-connect'); break;
      case 'back-to-chat': post('back-to-chat'); break;
      case 'disconnect': post('disconnect'); break;
      case 'remove-allowed': post('remove-allowed', { command: el.dataset.command }); break;
      case 'suggest':
        if (el.dataset.prompt === '/plan') {
          post('set-mode', { mode: 'plan' });
          const input = $('#input');
          if (input) input.focus();
        } else submit(el.dataset.prompt);
        break;
      case 'toggle-active': post('toggle-active'); break;
      case 'cycle-mode': cycleMode(); break;
      case 'toggle-skills-menu':
        menu = menu === 'skills' ? null : 'skills';
        skillFilter = '';
        if (menu) post('refresh-skills');
        renderComposerOnly();
        if (menu && $('#skill-search')) $('#skill-search').focus();
        break;
      case 'toggle-skill': event.stopPropagation(); post('toggle-skill', { id }); break;
      case 'clear-skills': post('set-skills', { ids: [] }); break;
      case 'close-menu': menu = null; renderComposerOnly(); break;
      case 'q-pick': {
        const item = items.find((i) => i.id === state.pendingQuestions);
        if (!item || !qDraft) break;
        const q = item.questions[Number(el.dataset.q)];
        const label = q.options[Number(el.dataset.o)].label;
        const a = qDraft.answers[Number(el.dataset.q)];
        if (q.multiSelect) a.selected = a.selected.includes(label) ? a.selected.filter((l) => l !== label) : [...a.selected, label];
        else a.selected = a.selected[0] === label ? [] : [label];
        renderComposerOnly();
        break;
      }
      case 'q-submit':
        if (qDraft && qDraft.id === id) {
          el.disabled = true;
          post('answer-questions', { id, answers: qDraft.answers });
        }
        break;
      case 'q-skip': post('skip-questions', { id }); break;
      case 'toggle-model-menu':
        menu = menu ? null : 'model';
        if (menu && !(state.models || []).length) post('refresh-models');
        renderComposerOnly();
        break;
      case 'refresh-models': post('refresh-models'); break;
      case 'pick-model': post('set-model', { model: el.dataset.model }); menu = null; break;
      case 'pick-effort': post('set-model', { effort: el.dataset.effort }); break;
      case 'toggle-todos': todosOpen = !todosOpen; renderComposerOnly(); break;
      case 'apply': event.stopPropagation(); post('apply', { id, path }); break;
      case 'reject': event.stopPropagation(); post('reject', { id, path }); break;
      case 'undo': post('undo', { id }); break;
      case 'plan-decision': post('plan-decision', { id, decision: el.dataset.decision }); break;
      case 'run': el.disabled = true; post('run', { id }); break;
      case 'allow-command': el.disabled = true; post('allow-command', { id }); break;
      case 'skip': post('skip', { id }); break;
      case 'stop-command': post('stop-command', { id }); break;
      case 'retry': post('retry'); break;
      case 'open-file': post('open-file', { path, line: Number(el.dataset.line) || undefined }); break;
      case 'open-diff': event.stopPropagation(); post('open-diff', { id, path }); break;
      case 'link': event.preventDefault(); post('open-link', { url: el.dataset.url }); break;
      case 'pick-popup': pickPopup(el.dataset.value); break;
      case 'toggle-file': {
        if (el.dataset.disabled) break;
        const fileEl = el.closest('.file');
        if (openFiles.has(key)) openFiles.delete(key);
        else openFiles.add(key);
        fileEl.classList.toggle('open');
        break;
      }
      case 'toggle-activity': {
        const act = el.closest('.activity');
        if (openActivities.has(id)) openActivities.delete(id);
        else openActivities.add(id);
        act.classList.toggle('open');
        break;
      }
      case 'copy-code': {
        const code = el.closest('.codeblock').querySelector('code').textContent;
        copy(code, el);
        break;
      }
      case 'copy-message': {
        const item = items.find((i) => i.id === id);
        if (item) copy(item.markdown, el);
        break;
      }
      default: break;
    }
  });

  function copy(text, button) {
    navigator.clipboard.writeText(text).then(() => {
      const before = button.innerHTML;
      button.innerHTML = I.check;
      setTimeout(() => (button.innerHTML = before), 1200);
    });
  }

  document.addEventListener('submit', (event) => {
    if (event.target.id !== 'connect-form') return;
    event.preventDefault();
    post('connect', { link: $('#link').value, code: $('#code').value });
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'skill-search') {
      skillFilter = event.target.value;
      renderComposerOnly();
      return;
    }
    if (event.target.classList && event.target.classList.contains('q-other')) {
      if (!qDraft) return;
      qDraft.answers[Number(event.target.dataset.q)].other = event.target.value;
      const submit = $('[data-action=q-submit]');
      const item = items.find((i) => i.id === state.pendingQuestions);
      if (submit && item) submit.disabled = state.busy || !item.questions.every((q, i) => qDraft.answers[i].selected.length || qDraft.answers[i].other.trim());
      return;
    }
    if (event.target.id !== 'input') return;
    autosize();
    updateSendButton();
    updatePopup();
    saveDraft();
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.id !== 'input') {
      if (event.key === 'Escape') {
        if (menu) closePopups();
        else if (state.busy) post('stop');
      }
      return;
    }
    if (popup) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const n = popup.matches.length;
        popup.index = (popup.index + (event.key === 'ArrowDown' ? 1 : n - 1)) % n;
        updatePopup();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pickPopup(popup.matches[popup.index]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closePopup();
        return;
      }
    }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      cycleMode();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (menu) closePopups();
      else if (state.busy) post('stop');
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.target.id === 'input' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) updatePopup();
  });

  // Live timers ("12s") without re-rendering items.
  setInterval(() => {
    document.querySelectorAll('.elapsed[data-since]').forEach((el) => {
      el.textContent = elapsed(Number(el.dataset.since));
    });
  }, 1000);

  // ------------------------------------------------- messages from extension
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'state': {
        const prev = state;
        state = { ...state, ...msg.state };
        if (prev.view !== state.view) chats = null;
        const structural = prev.view !== state.view || prev.connecting !== state.connecting || prev.connectError !== state.connectError || prev.link !== state.link || (state.view === 'connect' && prev.allowedCommands !== state.allowedCommands);
        if (structural || state.view !== 'chat' || (!$('#transcript') && !chats)) renderAll();
        else if (!chats) {
          renderTopbarOnly();
          renderComposerOnly();
          if (items.length === 0) $('#transcript').innerHTML = renderWelcome();
        } else renderTopbarOnly();
        break;
      }
      case 'reset':
        items = msg.items || [];
        openFiles.clear();
        openActivities.clear();
        if (!chats) renderAll();
        break;
      case 'item':
        if (msg.item) upsertItem(msg.item);
        break;
      case 'chats':
        currentChat = msg.current || '';
        if (chats !== null) {
          chats = msg.chats || [];
          renderAll();
        }
        break;
      case 'show-history':
        chats = chats || [];
        renderAll();
        break;
      case 'files':
        files = msg.paths || [];
        updatePopup();
        break;
      case 'insert': {
        if (chats) {
          chats = null;
          renderAll();
        }
        const input = $('#input');
        if (!input) break;
        const sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
        input.value = `${input.value}${sep}${msg.text}`;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        autosize();
        updateSendButton();
        saveDraft();
        break;
      }
      case 'focus':
        if ($('#input')) $('#input').focus();
        else if ($('.q-option')) $('.q-option').focus();
        break;
      default:
        break;
    }
  });

  renderAll();
  post('ready');
  post('request-files');
})();
