'use strict';

/**
 * Claude Bridge for VS Code.
 *
 * A chat panel for a claude-remote-bridge host, in the sidebar or in an editor
 * tab. The extension owns the conversation; the panel (media/chat.js) only
 * renders it and reports clicks.
 *
 *   - Claude explores the workspace folder by itself: it gets the file list and
 *     asks for files and searches, which this extension answers from the local
 *     disk (secrets, .git, node_modules and binaries are never read).
 *   - Modes: "Ask before edits" (default), "Auto-accept edits", "Plan mode".
 *   - Proposed edits appear as diff cards with per-file Accept/Reject and Undo.
 *     Files with unsaved edits in the editor are never overwritten.
 *   - Proposed commands appear as cards and run in the workspace folder only
 *     after you click Run (or when you chose "Always allow" for that command).
 *   - Conversations are saved per workspace and can be resumed from History.
 *   - The link and access code come from the host. The access code is kept in
 *     VS Code secret storage and is never sent: it is the encryption key.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vscode = require('vscode');
const core = require('./bridge-core');

const LINK_KEY = 'claudeBridge.link'; // globalState
const CODE_KEY = 'claudeBridge.accessCode'; // secret storage
const INCLUDE_ACTIVE_KEY = 'claudeBridge.includeActive'; // globalState
const MODEL_KEY = 'claudeBridge.model'; // globalState
const EFFORT_KEY = 'claudeBridge.effort'; // globalState
const MODE_KEY = 'claudeBridge.mode'; // workspaceState
const ALLOWED_COMMANDS_KEY = 'claudeBridge.allowedCommands'; // workspaceState
const ACTIVE_SKILLS_KEY = 'claudeBridge.activeSkills'; // workspaceState
const MAX_ACTIVE_SKILLS = 8;
const DIFF_SCHEME = 'claude-bridge';
const PREVIEW_LINES_PER_FILE = 400; // diff lines sent to the panel per file
const OUTPUT_KEEP_CHARS = 40_000; // command output kept per card while live
const SAVED_OUTPUT_CHARS = 8_000; // command output kept per card in saved chats
const SELECTION_CHARS = 6_000; // selected text passed to Claude
const MAX_PROBLEMS = 15; // diagnostics of the active file passed to Claude
const MAX_SAVED_CHATS = 50;
const MAX_UNDO_BYTES = 4 * 1024 * 1024; // undo data kept per saved chat
const MODES = ['default', 'auto', 'plan'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const newId = () => crypto.randomBytes(6).toString('hex');

/** Read-only documents for "proposed" and "empty" sides of a diff. */
class ProposedContent {
  constructor() {
    this.docs = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }
  set(uri, text) {
    this.docs.set(uri.toString(), text);
    this.emitter.fire(uri);
  }
  provideTextDocumentContent(uri) {
    return this.docs.get(uri.toString()) || '';
  }
}

// ---------------------------------------------------------------------------
// Saved conversations (one JSON file per chat in the extension's storage)
// ---------------------------------------------------------------------------

class ChatStore {
  constructor(context) {
    const base = context.storageUri || context.globalStorageUri;
    this.dir = path.join(base.fsPath, 'chats');
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(id) {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('bad chat id');
    return path.join(this.dir, `${id}.json`);
  }

  /** [{ id, title, updatedAt, messages }] newest first. */
  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => /^[a-f0-9]{12}\.json$/.test(n));
    } catch {
      return [];
    }
    const chats = [];
    for (const name of names) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        chats.push({ id: data.id, title: data.title, updatedAt: data.updatedAt, messages: data.messages || 0 });
      } catch {
        /* unreadable file: skip */
      }
    }
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  load(id) {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  save(chat) {
    this.ensureDir();
    const target = this.file(chat.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(chat));
    fs.renameSync(tmp, target);
    const all = this.list();
    for (const old of all.slice(MAX_SAVED_CHATS)) this.remove(old.id);
  }

  remove(id) {
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

class BridgeController {
  constructor(context) {
    this.context = context;
    this.store = new ChatStore(context);
    this.webviews = new Set();
    this.items = [];
    this.chatId = newId();
    this.chatCreatedAt = Date.now();
    this.proposals = new Map(); // changes item id -> { plan: [{ path, status, previous, content }] }
    this.undo = new Map(); // changes item id -> [{ path, previous, written }]
    this.commands = new Map(); // command item id -> { command, abort }
    this.connection = null;
    this.session = null;
    this.project = null;
    this.abort = null;
    this.lastPrompt = '';
    this.saveTimer = null;
    this.proposed = new ProposedContent();
    this.state = {
      view: 'loading', // 'connect' | 'chat'
      connected: false,
      connecting: false,
      host: '',
      link: context.globalState.get(LINK_KEY) || '',
      projectName: '',
      fileCount: 0,
      busy: false,
      activeFile: null,
      includeActive: context.globalState.get(INCLUDE_ACTIVE_KEY) !== false,
      connectError: '',
      mode: MODES.includes(context.workspaceState.get(MODE_KEY)) ? context.workspaceState.get(MODE_KEY) : 'default',
      model: context.globalState.get(MODEL_KEY) || '',
      effort: EFFORTS.includes(context.globalState.get(EFFORT_KEY)) ? context.globalState.get(EFFORT_KEY) : '',
      models: [],
      defaultModel: '',
      todos: [],
      allowedCommands: context.workspaceState.get(ALLOWED_COMMANDS_KEY) || [],
      chatTitle: '',
      skills: [], // [{ id, name, description, source }] — instructions stay here
      activeSkills: context.workspaceState.get(ACTIVE_SKILLS_KEY) || [],
      pendingQuestions: null, // id of a questions item waiting for answers
    };
    this.skills = []; // full skills, with instructions
  }

  // ------------------------------------------------------------------ plumbing

  post(message) {
    for (const webview of this.webviews) webview.postMessage(message);
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.post({ type: 'state', state: this.state });
  }

  upsert(item) {
    const index = this.items.findIndex((i) => i.id === item.id);
    if (index >= 0) this.items[index] = item;
    else this.items.push(item);
    this.post({ type: 'item', item });
    this.scheduleSave();
  }

  find(id) {
    return this.items.find((i) => i.id === id);
  }

  /** Attach a webview (sidebar view or editor panel) to this controller. */
  attach(webview, { inEditor = false } = {}) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Claude Bridge</title>
</head>
<body class="${inEditor ? 'in-editor' : ''}">
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;

    this.webviews.add(webview);
    const subscription = webview.onDidReceiveMessage((message) =>
      this.handle(message, webview, inEditor).catch((err) => {
        this.upsert({ id: newId(), kind: 'error', message: err && err.message ? err.message : String(err) });
      })
    );
    return {
      dispose: () => {
        this.webviews.delete(webview);
        subscription.dispose();
      },
    };
  }

  // ------------------------------------------------------------- persistence

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 600);
  }

  /** Save the current chat (only once it has a message). */
  saveNow() {
    const firstUser = this.items.find((i) => i.kind === 'user');
    if (!firstUser || !this.session) return;
    const items = this.items.map((item) => {
      if (item.kind === 'command') return { ...item, output: (item.output || '').slice(-SAVED_OUTPUT_CHARS) };
      if (item.kind === 'activity' && item.status === 'running') return { ...item, status: 'done' };
      return item;
    });
    const undo = {};
    let bytes = 0;
    for (const [id, entries] of [...this.undo.entries()].reverse()) {
      const size = entries.reduce((n, e) => n + (e.previous || '').length + e.written.length, 0);
      if (bytes + size > MAX_UNDO_BYTES) continue;
      bytes += size;
      undo[id] = entries;
    }
    const title = this.state.chatTitle || firstUser.text.split('\n')[0].slice(0, 80);
    try {
      this.store.save({
        id: this.chatId,
        title,
        createdAt: this.chatCreatedAt,
        updatedAt: Date.now(),
        messages: this.items.filter((i) => i.kind === 'user').length,
        root: this.project ? this.project.root : '',
        items,
        session: this.session.toJSON(),
        undo,
      });
    } catch (err) {
      console.error('Claude Bridge: could not save chat', err);
    }
  }

  sendChats(webview) {
    const chats = this.store.list();
    if (webview) webview.postMessage({ type: 'chats', chats, current: this.chatId });
    else this.post({ type: 'chats', chats, current: this.chatId });
  }

  /** Resume a saved chat. Proposals that were never decided cannot be applied any more. */
  openChat(id) {
    const chat = this.store.load(id);
    if (!chat) {
      vscode.window.showWarningMessage('Claude Bridge: that conversation could not be loaded.');
      return;
    }
    this.saveNow();
    this.stopAll();
    this.ensureProject();
    this.chatId = chat.id;
    this.chatCreatedAt = chat.createdAt || Date.now();
    this.proposals.clear();
    this.commands.clear();
    this.undo = new Map(Object.entries(chat.undo || {}));
    this.items = (chat.items || []).map((item) => {
      if (item.kind === 'changes' && item.files) {
        return { ...item, files: item.files.map((f) => (f.decision === 'pending' ? { ...f, decision: 'expired' } : f)) };
      }
      if (item.kind === 'command' && (item.state === 'pending' || item.state === 'running')) return { ...item, state: 'expired' };
      if (item.kind === 'plan-approval' && item.state === 'pending') return { ...item, state: 'expired' };
      if (item.kind === 'questions' && item.state === 'pending') return { ...item, state: 'expired' };
      return item;
    });
    if (this.session) this.session.restore(chat.session);
    this.post({ type: 'reset', items: this.items });
    this.setState({ busy: false, chatTitle: chat.title, todos: this.session ? this.session.todos : [], pendingQuestions: null });
  }

  deleteChat(id) {
    this.store.remove(id);
    if (id === this.chatId) this.newChat({ keepSaved: false }); // do not re-save what was just deleted
    this.sendChats();
  }

  // ---------------------------------------------------------------- connection

  async init() {
    this.trackEditor();
    const link = this.context.globalState.get(LINK_KEY);
    const code = await this.context.secrets.get(CODE_KEY);
    if (!link || !code) {
      this.setState({ view: 'connect' });
      return;
    }
    try {
      this.connection = new core.Connection({ url: link, accessCode: code });
    } catch (err) {
      this.setState({ view: 'connect', connectError: err.message });
      return;
    }
    this.setState({ view: 'chat', host: new URL(this.connection.url).host });
    this.ensureProject();
    await this.checkHealth();
  }

  async checkHealth() {
    try {
      const health = await this.connection.health();
      const models = Array.isArray(health.models) ? health.models.filter((m) => typeof m === 'string') : [];
      const model = models.includes(this.state.model) ? this.state.model : '';
      this.setState({ connected: true, models, defaultModel: typeof health.defaultModel === 'string' ? health.defaultModel : '', model });
      return true;
    } catch (err) {
      this.setState({ connected: false });
      if (core.needsReconnect(err)) this.askForNewConnection(err);
      else this.upsert({ id: newId(), kind: 'error', message: err.message, reconnect: true });
      return false;
    }
  }

  /**
   * The link or access code stopped working (host restarted with a new link, code changed, host offline):
   * open the connect form with the reason, the old link filled in, and the chat kept.
   */
  askForNewConnection(err) {
    this.setState({ view: 'connect', connected: false, connectError: err.message, reconnectReason: err.kind || 'link' });
    vscode.window
      .showWarningMessage(`Claude Bridge: ${err.message}`, 'Enter link and code')
      .then((choice) => {
        if (choice) vscode.commands.executeCommand('claudeBridge.connect');
      });
  }

  async connect(link, code) {
    this.setState({ connecting: true, connectError: '' });
    let connection;
    try {
      connection = new core.Connection({ url: link, accessCode: code });
      await connection.health();
    } catch (err) {
      this.setState({ connecting: false, connectError: err.message, link: link || this.state.link });
      return;
    }
    await this.context.globalState.update(LINK_KEY, connection.url);
    await this.context.secrets.store(CODE_KEY, String(code).trim());
    this.connection = connection;
    if (this.session) this.session.connection = connection;
    this.setState({ connecting: false, view: 'chat', link: connection.url, host: new URL(connection.url).host, connectError: '', reconnectReason: '' });
    const last = this.items[this.items.length - 1];
    if (last && last.kind === 'error' && last.retry) this.upsert({ id: newId(), kind: 'info', text: 'Connected again. Click Retry above to send your last message again.' });
    this.ensureProject();
    await this.checkHealth();
  }

  async disconnect() {
    this.stopAll();
    await this.context.globalState.update(LINK_KEY, undefined);
    await this.context.secrets.delete(CODE_KEY);
    this.connection = null;
    this.session = null;
    this.setState({ view: 'connect', connected: false, link: '', host: '', connectError: '', models: [] });
  }

  // ------------------------------------------------------------------- project

  /** The workspace folder of the active file, or the first one. */
  pickFolder() {
    const editor = vscode.window.activeTextEditor;
    const fromEditor = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    return fromEditor || (vscode.workspace.workspaceFolders || [])[0] || null;
  }

  ensureProject() {
    const folder = this.pickFolder();
    if (!folder || folder.uri.scheme !== 'file') {
      this.project = null;
      this.session = null;
      this.setState({ projectName: '', fileCount: 0 });
      return null;
    }
    const root = path.resolve(folder.uri.fsPath);
    if (!this.project || this.project.root !== root) {
      const previous = this.session ? this.session.toJSON() : null;
      this.project = new core.Project(root);
      this.session = this.connection ? new core.Session({ connection: this.connection, project: this.project }) : null;
      if (this.session && previous && this.items.length) this.session.restore(previous);
    } else if (!this.session && this.connection) {
      this.session = new core.Session({ connection: this.connection, project: this.project });
    }
    const tree = this.project.scanTree();
    this.setState({ projectName: this.project.name, fileCount: tree.paths.length });
    this.refreshSkills();
    this.updateActiveFile();
    return this.project;
  }

  /** Re-read built-in, personal and project skills. */
  refreshSkills() {
    this.skills = core.loadSkills(this.project ? this.project.root : null);
    const ids = new Set(this.skills.map((k) => k.id));
    const activeSkills = this.state.activeSkills.filter((id) => ids.has(id));
    this.setState({
      skills: this.skills.map(({ id, name, description, source }) => ({ id, name, description, source })),
      activeSkills,
    });
  }

  async setSkills(ids) {
    const known = new Set(this.skills.map((k) => k.id));
    const activeSkills = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => known.has(id)))].slice(0, MAX_ACTIVE_SKILLS);
    await this.context.workspaceState.update(ACTIVE_SKILLS_KEY, activeSkills);
    this.setState({ activeSkills });
  }

  async toggleSkill(id) {
    const on = this.state.activeSkills.includes(id);
    if (!on && this.state.activeSkills.length >= MAX_ACTIVE_SKILLS) {
      vscode.window.showWarningMessage(`Claude Bridge: at most ${MAX_ACTIVE_SKILLS} skills can be on at once.`);
      return;
    }
    await this.setSkills(on ? this.state.activeSkills.filter((x) => x !== id) : [...this.state.activeSkills, id]);
  }

  /** Command palette: multi-select skills. */
  async pickSkills() {
    if (!this.project) this.ensureProject();
    this.refreshSkills();
    const items = this.skills.map((k) => ({
      label: k.name,
      description: k.source,
      detail: k.description || undefined,
      picked: this.state.activeSkills.includes(k.id),
      id: k.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Claude Bridge: skills',
      placeHolder: 'Tick the skills Claude should follow (several allowed), then press Enter',
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    await this.setSkills(picked.map((p) => p.id));
    vscode.window.setStatusBarMessage(`Claude Bridge: ${picked.length ? picked.map((p) => p.label).join(', ') : 'no skills'}`, 4000);
  }

  trackEditor() {
    const update = () => this.updateActiveFile();
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(update),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) update();
      })
    );
  }

  /** Project-relative path of an editor's file, or null. */
  relOf(uri) {
    if (!this.project || !uri || uri.scheme !== 'file') return null;
    const rel = this.project.relativeOf(uri.fsPath);
    return rel ? rel : null;
  }

  updateActiveFile() {
    const editor = vscode.window.activeTextEditor;
    const rel = editor ? this.relOf(editor.document.uri) : null;
    let activeFile = null;
    if (rel) {
      const sel = editor.selection;
      const selection = sel && !sel.isEmpty ? (sel.start.line === sel.end.line ? `${sel.start.line + 1}` : `${sel.start.line + 1}-${sel.end.line + 1}`) : null;
      activeFile = { path: rel, selection };
    } else if (this.state.activeFile && !editor) {
      activeFile = this.state.activeFile; // focus moved to the panel: keep the last file
    }
    if (JSON.stringify(activeFile) !== JSON.stringify(this.state.activeFile)) this.setState({ activeFile });
  }

  /** What the user is looking at: the open file, the selection and its problems. */
  editorContext() {
    if (!this.state.includeActive || !this.state.activeFile) return { extraFiles: [], note: '' };
    const { path: rel } = this.state.activeFile;
    const editor = vscode.window.visibleTextEditors.find((e) => this.relOf(e.document.uri) === rel);
    let note = `The user has ${rel} open in the editor.`;
    if (editor && !editor.selection.isEmpty) {
      const sel = editor.selection;
      let text = editor.document.getText(sel);
      if (text.length > SELECTION_CHARS) text = `${text.slice(0, SELECTION_CHARS)}\n…`;
      note += ` Selected lines ${sel.start.line + 1}-${sel.end.line + 1}:\n\`\`\`\n${text}\n\`\`\``;
    }
    try {
      const uri = vscode.Uri.file(path.join(this.project.root, rel));
      const names = { 0: 'error', 1: 'warning' };
      const problems = (vscode.languages.getDiagnostics(uri) || [])
        .filter((d) => d.severity === 0 || d.severity === 1)
        .slice(0, MAX_PROBLEMS)
        .map((d) => `- line ${d.range.start.line + 1}: ${names[d.severity]}: ${String(d.message).split('\n')[0].slice(0, 200)}${d.source ? ` (${d.source})` : ''}`);
      if (problems.length) note += `\nProblems VS Code reports in ${rel}:\n${problems.join('\n')}`;
    } catch {
      /* no diagnostics API (tests) */
    }
    return { extraFiles: [rel], note };
  }

  // -------------------------------------------------------------- conversation

  async send(text, { mode, hideUser = false } = {}) {
    if (this.state.busy) return;
    if (!this.connection) {
      this.setState({ view: 'connect' });
      return;
    }
    if (!this.ensureProject() || !this.session) {
      this.upsert({ id: newId(), kind: 'error', message: 'Open a folder first: Claude Bridge works on the workspace folder.' });
      return;
    }
    const effectiveMode = mode || this.state.mode;
    this.lastPrompt = text;
    if (!this.state.chatTitle) this.setState({ chatTitle: text.split('\n')[0].slice(0, 80) });

    if (this.state.pendingQuestions && !hideUser) {
      // The user typed a message instead of using the question card.
      const q = this.find(this.state.pendingQuestions);
      if (q) this.upsert({ ...q, state: 'dismissed' });
      this.setState({ pendingQuestions: null });
    }
    const skills = this.state.activeSkills.map((id) => this.skills.find((k) => k.id === id)).filter(Boolean);
    if (!hideUser) {
      this.upsert({
        id: newId(),
        kind: 'user',
        text,
        mode: effectiveMode === 'plan' ? 'plan' : undefined,
        skills: skills.length ? skills.map((k) => k.name) : undefined,
      });
    }
    const activity = { id: newId(), kind: 'activity', status: 'running', steps: [], round: 1, startedAt: Date.now(), seconds: 0 };
    this.upsert(activity);
    const controller = new AbortController();
    this.abort = controller;
    this.setState({ busy: true });

    const { extraFiles, note } = this.editorContext();
    const onEvent = (event) => {
      switch (event.type) {
        case 'tree':
          if (event.count !== this.state.fileCount) this.setState({ fileCount: event.count });
          return;
        case 'mentions':
          for (const rel of event.added) activity.steps.push({ kind: 'added', text: rel });
          for (const s of event.skipped) activity.steps.push({ kind: 'skip', text: s.path, detail: s.reason, error: true });
          for (const t of event.missing) activity.steps.push({ kind: 'missing', text: `@${core.stripControl(t)}`, detail: 'no such file', error: true });
          break;
        case 'thinking':
          activity.round = event.round;
          activity.queue = null;
          break;
        case 'queue':
          activity.queue = { state: event.state, ahead: event.ahead };
          break;
        case 'plan':
          activity.steps.push({ kind: 'plan', text: core.stripControl(event.text).split('\n')[0].slice(0, 300) });
          break;
        case 'read':
          activity.steps.push(
            event.error
              ? { kind: 'read', text: event.path, detail: event.error, error: true }
              : { kind: 'read', text: event.path, detail: `${event.lines} line${event.lines === 1 ? '' : 's'}` }
          );
          break;
        case 'search':
          activity.steps.push({ kind: 'search', text: core.stripControl(event.query), detail: `${event.count}${event.truncated ? '+' : ''} matches` });
          break;
        default:
          return;
      }
      this.upsert({ ...activity, steps: [...activity.steps] });
    };

    let response;
    try {
      response = await this.session.send(text, {
        onEvent,
        signal: controller.signal,
        extraFiles,
        editorContext: note,
        model: this.state.model,
        effort: this.state.effort,
        mode: effectiveMode === 'plan' ? 'plan' : 'default',
        skills,
      });
    } catch (err) {
      this.finishActivity(activity);
      this.abort = null;
      this.setState({ busy: false });
      if (controller.signal.aborted) this.upsert({ id: newId(), kind: 'info', text: 'Stopped.' });
      else {
        const reconnect = core.needsReconnect(err);
        this.upsert({ id: newId(), kind: 'error', message: core.describeError(err, this.connection.url), retry: true, reconnect });
        if (reconnect) this.askForNewConnection(err);
      }
      return;
    }
    this.finishActivity(activity);
    this.abort = null;

    const usage = response.usage ? { ...response.usage, rounds: response.rounds } : null;
    this.upsert({ id: newId(), kind: 'assistant', markdown: core.stripControl(response.explanation).trim() || '_(no answer)_', usage });
    this.setState({ todos: response.todos || [] });

    if (response.questions && response.questions.length) {
      const qid = newId();
      this.upsert({ id: qid, kind: 'questions', questions: response.questions, state: 'pending' });
      this.setState({ pendingQuestions: qid });
    } else if (effectiveMode === 'plan') {
      this.upsert({ id: newId(), kind: 'plan-approval', state: 'pending' });
    }
    let changesId = null;
    if (response.fileUpdates.length) changesId = this.showChanges(response.fileUpdates);
    const commandIds = [];
    for (const command of response.commands) {
      const id = newId();
      const shown = core.stripControl(command);
      this.commands.set(id, { command, abort: null });
      this.upsert({ id, kind: 'command', command: shown, state: shown === command ? 'pending' : 'blocked', output: '' });
      if (shown !== command) this.session.report(`Command \`${shown}\` was blocked by the client (control characters).`);
      else commandIds.push(id);
    }
    this.setState({ busy: false });

    if (changesId && this.state.mode === 'auto') await this.applyChanges(changesId);
    for (const id of commandIds) {
      const entry = this.commands.get(id);
      if (entry && this.state.allowedCommands.includes(entry.command)) await this.runCommand(id, { auto: true });
    }
  }

  finishActivity(activity) {
    activity.status = 'done';
    activity.seconds = Math.round((Date.now() - activity.startedAt) / 1000);
    this.upsert({ ...activity, steps: [...activity.steps] });
  }

  showChanges(updates) {
    const id = newId();
    const plan = this.project.planUpdates(updates);
    const files = plan.map((item) => {
      const writable = item.status === 'new' || item.status === 'modified';
      const preview = {
        path: item.path,
        status: item.status,
        added: item.added,
        removed: item.removed,
        error: item.error || '',
        decision: writable ? 'pending' : 'none',
      };
      if (writable) {
        const hunks = core.diffHunks(core.diffLines(item.previous || '', item.content), 3);
        let budget = PREVIEW_LINES_PER_FILE;
        let more = 0;
        preview.hunks = [];
        for (const hunk of hunks) {
          if (budget <= 0) {
            more += hunk.lines.length;
            continue;
          }
          const lines = hunk.lines.slice(0, budget);
          more += hunk.lines.length - lines.length;
          budget -= lines.length;
          preview.hunks.push(lines.map((l) => ({ t: l.type, x: core.stripControl(l.text), o: l.oldNo, n: l.newNo })));
        }
        preview.more = more;
      }
      return preview;
    });
    this.proposals.set(id, { plan });
    this.upsert({ id, kind: 'changes', files });
    return id;
  }

  /** Accept one file (`only`) or every undecided file of a changes card. */
  async applyChanges(id, only) {
    const proposal = this.proposals.get(id);
    const item = this.find(id);
    if (!proposal || !item) return;
    const targets = item.files.filter((f) => f.decision === 'pending' && (!only || f.path === only));
    if (!targets.length) return;

    const files = item.files.map((f) => ({ ...f }));
    const written = [];
    const undoEntries = this.undo.get(id) || [];
    for (const target of targets) {
      const change = proposal.plan.find((c) => c.path === target.path);
      const file = files.find((f) => f.path === target.path);
      const abs = path.join(this.project.root, change.path);
      const dirty = vscode.workspace.textDocuments.some((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs && d.isDirty);
      if (dirty) {
        file.note = 'Unsaved edits in the editor. Save or revert them, then accept again.';
        continue;
      }
      const result = this.project.writeFile(change.path, change.content);
      if (result.ok) {
        file.decision = 'applied';
        file.note = '';
        written.push(result.path);
        undoEntries.push({ path: result.path, previous: result.previous, written: change.content });
        this.session.addToView(result.path);
      } else {
        file.decision = 'failed';
        file.note = result.error;
      }
    }
    if (undoEntries.length) this.undo.set(id, undoEntries);
    this.upsert({ ...item, files });
    if (written.length) this.session.report(`The user APPLIED the changes to: ${written.join(', ')}.`);
    const failed = files.filter((f) => targets.some((t) => t.path === f.path) && f.decision === 'failed');
    if (failed.length) this.session.report(`Not written: ${failed.map((f) => `${f.path} (${f.note})`).join('; ')}`);
  }

  /** Reject one file (`only`) or every undecided file of a changes card. */
  rejectChanges(id, only) {
    const item = this.find(id);
    if (!item || !this.proposals.has(id)) return;
    const rejected = [];
    const files = item.files.map((f) => {
      if (f.decision !== 'pending' || (only && f.path !== only)) return f;
      rejected.push(f.path);
      return { ...f, decision: 'rejected', note: '' };
    });
    if (!rejected.length) return;
    this.upsert({ ...item, files });
    this.session.report(`The user REJECTED the proposed changes to: ${rejected.join(', ')}. Those files are unchanged.`);
  }

  /** Undo every applied file of a changes card. */
  async undoChanges(id) {
    const item = this.find(id);
    const entries = this.undo.get(id);
    if (!item || !entries || !entries.length || !this.project) return;
    const conflicts = [];
    for (const entry of entries) {
      const check = this.project.revertWrite(entry.path, entry.previous, entry.written, { force: false });
      if (!check.ok && check.conflict) conflicts.push(entry.path);
      else if (check.ok) entry.done = true;
    }
    if (conflicts.length) {
      const choice = await vscode.window.showWarningMessage(
        `${conflicts.join(', ')} changed after Claude's edit. Undo anyway and lose those later edits?`,
        { modal: true },
        'Undo anyway'
      );
      if (choice === 'Undo anyway') {
        for (const entry of entries.filter((e) => conflicts.includes(e.path))) {
          const result = this.project.revertWrite(entry.path, entry.previous, entry.written, { force: true });
          if (result.ok) entry.done = true;
        }
      }
    }
    const undone = entries.filter((e) => e.done).map((e) => e.path);
    const files = item.files.map((f) => (undone.includes(f.path) ? { ...f, decision: 'undone', note: '' } : f));
    this.undo.set(id, entries.filter((e) => !e.done));
    this.upsert({ ...item, files });
    if (undone.length) this.session.report(`The user UNDID your changes to: ${undone.join(', ')}. Those files are back to how they were before.`);
  }

  /** Undo the most recent card that still has something to undo. */
  async undoLast() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item.kind === 'changes' && (this.undo.get(item.id) || []).length) return this.undoChanges(item.id);
    }
    this.upsert({ id: newId(), kind: 'info', text: 'Nothing to undo.' });
  }

  async openDiff(id, rel) {
    const proposal = this.proposals.get(id);
    const change = proposal && proposal.plan.find((c) => c.path === rel);
    const item = this.find(id);
    const file = item && item.files.find((f) => f.path === rel);
    if (!change || !file || file.decision !== 'pending') return this.openFile(rel);
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/proposed/${id}/${rel}` });
    this.proposed.set(right, change.content);
    let left;
    if (change.previous === null) {
      left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/empty/${id}/${rel}` });
      this.proposed.set(left, '');
    } else {
      left = vscode.Uri.file(path.join(this.project.root, rel));
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(rel)} ↔ proposed by Claude`, { preview: true });
  }

  async openFile(rel, line) {
    if (!this.project) return;
    const target = this.project.locate(rel);
    if (target.error || !fs.existsSync(target.abs)) return;
    try {
      const options = { preview: true, viewColumn: vscode.ViewColumn.One };
      if (line && vscode.Range) options.selection = new vscode.Range(line - 1, 0, line - 1, 0);
      await vscode.window.showTextDocument(vscode.Uri.file(target.abs), options);
    } catch {
      /* deleted meanwhile */
    }
  }

  async runCommand(id, { auto = false } = {}) {
    const entry = this.commands.get(id);
    const item = this.find(id);
    if (!entry || !item || item.state !== 'pending') return;
    const controller = new AbortController();
    entry.abort = controller;
    const live = { ...item, state: 'running', output: '', startedAt: Date.now(), auto };
    this.upsert(live);

    let timer = null;
    const flush = () => {
      timer = null;
      this.upsert({ ...live });
    };
    const result = await core.runCommand(entry.command, {
      cwd: this.project.root,
      detached: true,
      signal: controller.signal,
      onOutput: (text) => {
        live.output = (live.output + core.stripControl(text)).slice(-OUTPUT_KEEP_CHARS);
        if (!timer) timer = setTimeout(flush, 120);
      },
    });
    if (timer) clearTimeout(timer);
    const status = core.describeCommandResult(result);
    this.upsert({ ...live, state: 'done', code: result.code, status });
    entry.abort = null;
    const tail = core.stripControl(result.tail).trim();
    this.session.report(`The user ran \`${entry.command}\` → ${status}.${tail ? `\nOutput (tail):\n${tail}` : ''}`);
  }

  skipCommand(id) {
    const entry = this.commands.get(id);
    const item = this.find(id);
    if (!entry || !item || item.state !== 'pending') return;
    this.upsert({ ...item, state: 'skipped' });
    this.session.report(`The user chose NOT to run \`${entry.command}\`.`);
  }

  async allowCommand(id) {
    const entry = this.commands.get(id);
    if (!entry) return;
    const allowed = [...new Set([...this.state.allowedCommands, entry.command])];
    await this.context.workspaceState.update(ALLOWED_COMMANDS_KEY, allowed);
    this.setState({ allowedCommands: allowed });
    await this.runCommand(id);
  }

  async removeAllowed(command) {
    const allowed = this.state.allowedCommands.filter((c) => c !== command);
    await this.context.workspaceState.update(ALLOWED_COMMANDS_KEY, allowed);
    this.setState({ allowedCommands: allowed });
  }

  /** The user answered Claude's questions in the question card. */
  async answerQuestions(id, answers) {
    const item = this.find(id);
    if (!item || item.kind !== 'questions' || item.state !== 'pending' || this.state.busy) return;
    const clean = item.questions.map((q, i) => {
      const a = (Array.isArray(answers) && answers[i]) || {};
      const labels = new Set(q.options.map((o) => o.label));
      let selected = Array.isArray(a.selected) ? a.selected.filter((l) => typeof l === 'string' && labels.has(l)) : [];
      if (!q.multiSelect) selected = selected.slice(0, 1);
      const other = typeof a.other === 'string' ? a.other.trim().slice(0, 2000) : '';
      return { selected, other };
    });
    this.upsert({ ...item, state: 'answered', answers: clean });
    this.setState({ pendingQuestions: null });
    await this.send(core.formatAnswers(item.questions, clean), { hideUser: true });
  }

  async skipQuestions(id) {
    const item = this.find(id);
    if (!item || item.kind !== 'questions' || item.state !== 'pending' || this.state.busy) return;
    this.upsert({ ...item, state: 'skipped' });
    this.setState({ pendingQuestions: null });
    await this.send('[answers]\nThe user skipped your questions. Continue with your best judgement and say which assumptions you made.', { hideUser: true });
  }

  /** Plan mode: the user approved (or not) the plan Claude wrote. */
  async decidePlan(id, decision) {
    const item = this.find(id);
    if (!item || item.state !== 'pending') return;
    if (decision === 'keep') {
      this.upsert({ ...item, state: 'kept' });
      return;
    }
    const mode = decision === 'auto' ? 'auto' : 'default';
    this.upsert({ ...item, state: decision === 'auto' ? 'approved-auto' : 'approved' });
    await this.setMode(mode);
    await this.send('The plan is approved. Go ahead and implement it.');
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) return;
    await this.context.workspaceState.update(MODE_KEY, mode);
    this.setState({ mode });
  }

  async setModel(model, effort) {
    if (model !== undefined) {
      const valid = model === '' || this.state.models.includes(model);
      if (valid) {
        await this.context.globalState.update(MODEL_KEY, model);
        this.setState({ model });
      }
    }
    if (effort !== undefined && EFFORTS.includes(effort)) {
      await this.context.globalState.update(EFFORT_KEY, effort);
      this.setState({ effort });
    }
  }

  /** Command palette: pick the model, then the effort. */
  async pickModel() {
    if (!this.connection) {
      vscode.window.showWarningMessage('Claude Bridge: connect to a host first.');
      return;
    }
    if (!this.state.models.length) await this.checkHealth();
    if (!this.state.models.length) {
      vscode.window.showWarningMessage('Claude Bridge: the host\'s server does not offer a model choice. It is an older version: ask the host to restart it with the latest server.js.');
      return;
    }
    const nice = (m) => m.charAt(0).toUpperCase() + m.slice(1);
    const modelItems = [{ label: 'Host default', description: this.state.defaultModel || 'the model the host chose', value: '' }]
      .concat(this.state.models.map((m) => ({ label: nice(m), description: m === this.state.defaultModel ? 'host default' : '', value: m })))
      .map((i) => ({ ...i, picked: i.value === this.state.model, label: `${i.value === this.state.model ? '$(check) ' : ''}${i.label}` }));
    const model = await vscode.window.showQuickPick(modelItems, { title: 'Claude Bridge: model', placeHolder: 'Choose the model for your next messages' });
    if (!model) return;
    const efforts = [['', 'Default'], ['low', 'Low — fastest'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max — slowest, most thorough']]
      .map(([value, label]) => ({ label: `${value === this.state.effort ? '$(check) ' : ''}${label}`, value }));
    const effort = await vscode.window.showQuickPick(efforts, { title: 'Claude Bridge: effort', placeHolder: 'How hard should Claude think? (Esc keeps the current setting)' });
    await this.setModel(model.value, effort ? effort.value : undefined);
    vscode.window.setStatusBarMessage(`Claude Bridge: ${model.value || 'host default'}${this.state.effort ? ` · ${this.state.effort}` : ''}`, 4000);
  }

  /** Ask Claude to summarize the conversation and continue from the summary only. */
  async compact() {
    if (this.state.busy || !this.session) return;
    if (!this.session.history.length) {
      this.upsert({ id: newId(), kind: 'info', text: 'Nothing to compact yet.' });
      return;
    }
    const activity = { id: newId(), kind: 'activity', status: 'running', steps: [{ kind: 'plan', text: 'Summarizing the conversation' }], round: 1, startedAt: Date.now() };
    this.upsert(activity);
    const controller = new AbortController();
    this.abort = controller;
    this.setState({ busy: true });
    try {
      const response = await this.session.send('Summarize our conversation so far.', {
        signal: controller.signal,
        mode: 'compact',
        model: this.state.model,
        effort: this.state.effort,
      });
      this.finishActivity(activity);
      this.upsert({ id: newId(), kind: 'compacted', summary: core.stripControl(response.explanation).trim() });
    } catch (err) {
      this.finishActivity(activity);
      if (!controller.signal.aborted) {
        this.upsert({ id: newId(), kind: 'error', message: core.describeError(err, this.connection.url), reconnect: core.needsReconnect(err) });
        if (core.needsReconnect(err)) this.askForNewConnection(err);
      }
    }
    this.abort = null;
    this.setState({ busy: false });
  }

  stopAll() {
    if (this.abort) this.abort.abort();
    for (const entry of this.commands.values()) if (entry.abort) entry.abort.abort();
  }

  newChat({ keepSaved = true } = {}) {
    if (keepSaved) this.saveNow();
    this.stopAll();
    this.items = [];
    this.proposals.clear();
    this.commands.clear();
    this.undo.clear();
    this.chatId = newId();
    this.chatCreatedAt = Date.now();
    if (this.session) this.session.clear();
    this.ensureProject();
    this.post({ type: 'reset', items: [] });
    this.setState({ busy: false, todos: [], chatTitle: '', pendingQuestions: null });
  }

  /** Put "@path" (with the selected lines, if any) into the message box. */
  insertReference(uri, { withSelection = false } = {}) {
    const editor = vscode.window.activeTextEditor;
    const target = uri instanceof vscode.Uri ? uri : editor && editor.document.uri;
    if (!target || target.scheme !== 'file') {
      vscode.window.showWarningMessage('Claude Bridge: open a saved file, or pick one in the explorer.');
      return;
    }
    this.ensureProject();
    const rel = this.relOf(target);
    if (!rel) {
      vscode.window.showWarningMessage('Claude Bridge: that file is outside the workspace folder.');
      return;
    }
    if (/\s/.test(rel)) {
      vscode.window.showWarningMessage('Claude Bridge: paths with spaces cannot be mentioned with @.');
      return;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(target.fsPath).isDirectory();
    } catch {
      /* treat as a file */
    }
    let range = '';
    if (withSelection && editor && !isDir && editor.document.uri.fsPath === target.fsPath && !editor.selection.isEmpty) {
      const a = editor.selection.start.line + 1;
      const b = editor.selection.end.line + 1 - (editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line ? 1 : 0);
      range = a === b ? `#L${a}` : `#L${a}-${b}`;
    }
    this.post({ type: 'insert', text: `@${rel}${isDir ? '/' : ''}${range} ` });
  }

  // ------------------------------------------------------------------ messages

  async handle(message, webview, inEditor) {
    switch (message.type) {
      case 'ready':
        webview.postMessage({ type: 'state', state: { ...this.state, inEditor } });
        webview.postMessage({ type: 'reset', items: this.items });
        if (this.state.view === 'loading') await this.init();
        else this.ensureProject();
        break;
      case 'send':
        if (typeof message.text === 'string' && message.text.trim()) await this.send(message.text.trim());
        break;
      case 'retry':
        if (this.lastPrompt) await this.send(this.lastPrompt);
        break;
      case 'stop':
        if (this.abort) this.abort.abort();
        break;
      case 'connect':
        await this.connect(message.link, message.code);
        break;
      case 'show-connect':
        this.setState({ view: 'connect', connectError: '' });
        break;
      case 'back-to-chat':
        if (this.connection) this.setState({ view: 'chat', connectError: '', reconnectReason: '' });
        break;
      case 'disconnect':
        await this.disconnect();
        break;
      case 'new-chat':
        this.newChat();
        break;
      case 'history':
        this.saveNow();
        this.sendChats(webview);
        break;
      case 'open-chat':
        this.openChat(String(message.id));
        break;
      case 'delete-chat':
        this.deleteChat(String(message.id));
        break;
      case 'toggle-active':
        this.setState({ includeActive: !this.state.includeActive });
        await this.context.globalState.update(INCLUDE_ACTIVE_KEY, this.state.includeActive);
        break;
      case 'set-mode':
        await this.setMode(message.mode);
        break;
      case 'set-model':
        await this.setModel(message.model, message.effort);
        break;
      case 'answer-questions':
        await this.answerQuestions(message.id, message.answers);
        break;
      case 'skip-questions':
        await this.skipQuestions(message.id);
        break;
      case 'refresh-skills':
        this.refreshSkills();
        break;
      case 'set-skills':
        await this.setSkills(message.ids);
        break;
      case 'toggle-skill':
        await this.toggleSkill(String(message.id));
        break;
      case 'refresh-models':
        if (this.connection) await this.checkHealth();
        break;
      case 'compact':
        await this.compact();
        break;
      case 'undo-last':
        await this.undoLast();
        break;
      case 'apply':
        await this.applyChanges(message.id, message.path);
        break;
      case 'reject':
        this.rejectChanges(message.id, message.path);
        break;
      case 'undo':
        await this.undoChanges(message.id);
        break;
      case 'plan-decision':
        await this.decidePlan(message.id, message.decision);
        break;
      case 'open-diff':
        await this.openDiff(message.id, message.path);
        break;
      case 'open-file':
        await this.openFile(message.path, message.line);
        break;
      case 'run':
        await this.runCommand(message.id);
        break;
      case 'allow-command':
        await this.allowCommand(message.id);
        break;
      case 'remove-allowed':
        await this.removeAllowed(String(message.command));
        break;
      case 'skip':
        this.skipCommand(message.id);
        break;
      case 'stop-command': {
        const entry = this.commands.get(message.id);
        if (entry && entry.abort) entry.abort.abort();
        break;
      }
      case 'request-files':
        if (this.ensureProject()) webview.postMessage({ type: 'files', paths: this.project.scanTree().paths });
        break;
      case 'open-link': {
        const url = core.normalizeUrl(message.url);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(message.url));
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

let panel = null; // the editor-tab chat, if open

function activate(context) {
  const controller = new BridgeController(context);

  const openPanel = () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Beside);
      panel.webview.postMessage({ type: 'focus' });
      return;
    }
    panel = vscode.window.createWebviewPanel('claudeBridge.panel', 'Claude Bridge', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    const handle = controller.attach(panel.webview, { inEditor: true });
    panel.onDidDispose(() => {
      handle.dispose();
      panel = null;
    });
  };

  const focusChat = async () => {
    if (panel) openPanel();
    else await vscode.commands.executeCommand('claudeBridge.chat.focus');
    controller.post({ type: 'focus' });
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, controller.proposed),

    vscode.window.registerWebviewViewProvider(
      'claudeBridge.chat',
      {
        resolveWebviewView(view) {
          const handle = controller.attach(view.webview, { inEditor: false });
          view.onDidDispose(() => handle.dispose());
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    ),

    vscode.commands.registerCommand('claudeBridge.open', openPanel),
    vscode.commands.registerCommand('claudeBridge.focus', focusChat),
    vscode.commands.registerCommand('claudeBridge.focusSidebar', () => vscode.commands.executeCommand('claudeBridge.chat.focus')),
    vscode.commands.registerCommand('claudeBridge.newChat', () => controller.newChat()),
    vscode.commands.registerCommand('claudeBridge.history', async () => {
      await focusChat();
      controller.post({ type: 'show-history' });
      controller.sendChats();
    }),
    vscode.commands.registerCommand('claudeBridge.cycleMode', () => {
      const next = MODES[(MODES.indexOf(controller.state.mode) + 1) % MODES.length];
      return controller.setMode(next);
    }),
    vscode.commands.registerCommand('claudeBridge.undoLast', () => controller.undoLast()),
    vscode.commands.registerCommand('claudeBridge.changeModel', () => controller.pickModel()),
    vscode.commands.registerCommand('claudeBridge.skills', () => controller.pickSkills()),
    vscode.commands.registerCommand('claudeBridge.connect', async () => {
      await vscode.commands.executeCommand('claudeBridge.chat.focus');
      controller.setState({ view: 'connect', connectError: '' });
    }),
    vscode.commands.registerCommand('claudeBridge.disconnect', () => controller.disconnect()),
    vscode.commands.registerCommand('claudeBridge.insertReference', async (uri) => {
      if (controller.webviews.size === 0) await vscode.commands.executeCommand('claudeBridge.chat.focus');
      controller.insertReference(uri, { withSelection: true });
      controller.post({ type: 'focus' });
    }),
    { dispose: () => {
      controller.saveNow();
      controller.stopAll();
    } }
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
