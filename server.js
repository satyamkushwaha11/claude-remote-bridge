#!/usr/bin/env node
'use strict';

/**
 * claude-remote-bridge — HOST SERVER (runs on the machine that is logged in to Claude Code)
 *
 * Turns an encrypted request into one non-interactive `claude -p` run and
 * returns a structured, encrypted answer:
 *
 *   request : { prompt: string, files: [{ path, content }], history: [{ role, content }] }
 *   request : ... plus tree: [path] (project file list) and context: string (client notes)
 *   response: { explanation: string, fileUpdates: [{ path, content }], commands: [string],
 *               readFiles: [path], searches: [string] }   (readFiles/searches = "show me more first")
 *
 * Design rules:
 *   - Zero npm dependencies (built-in Node.js modules only).
 *   - A guest needs two things: the link (where the server is) and the access code.
 *     The access code is never sent over the network. Both sides derive an
 *     AES-256-GCM key from it and every request and reply is encrypted with that
 *     key, so only someone who knows the code can talk to the server or read
 *     the traffic — not even the tunnel provider can.
 *   - Claude runs as a pure text generator: no built-in tools, no MCP servers,
 *     no hooks/plugins/skills, in an empty throw-away directory. Nothing the
 *     guest sends can read files or execute anything on this machine.
 *   - Guest input never touches a shell: the prompt is piped over stdin and the
 *     CLI is spawned with an argument array (shell: false).
 *   - One Claude run at a time (FIFO queue), with a hard timeout per run.
 *
 * Usage:
 *   node server.js --share      # start, open a Cloudflare tunnel, print the link + access code
 *   node server.js --share --model opus   # same, with a different default model
 *   TUNNEL=ngrok / cloudflare / none in .env   # a link that stays the same (see tunnelPlan)
 *   node server.js              # start without a tunnel (localhost / Tailscale)
 *   node server.js --gen-code   # print a new random access code and exit
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Minimal .env loader (KEY=VALUE per line, optional quotes, `#` comments).
 * Real environment variables always win over the file.
 */
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env file — that's fine
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** Read a positive integer from the environment, falling back to a default. */
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[config] ${name} must be a positive integer (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

/** A random access code: 25 base32 characters (125 bits of entropy), grouped for readability. */
function generateAccessCode() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
  const bytes = crypto.randomBytes(25);
  let code = '';
  for (let i = 0; i < bytes.length; i++) {
    code += alphabet[bytes[i] & 31];
    if (i % 5 === 4 && i < bytes.length - 1) code += '-';
  }
  return code;
}

/** Value of "--name value" or "--name=value" on the command line, or undefined. */
function argValue(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

if (process.argv.includes('--gen-code') || process.argv.includes('--gen-token')) {
  console.log(generateAccessCode());
  process.exit(0);
}

const ENV_FILE = path.join(__dirname, '.env');
loadDotEnv(ENV_FILE);

const CONFIG = {
  // 127.0.0.1 is the safe default: only a local tunnel (cloudflared / tailscale serve)
  // can reach the server. Set HOST to your Tailscale IP to listen on the tailnet directly.
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 4000),
  // AUTH_TOKEN is the old name of the same secret and still works.
  accessCode: (process.env.ACCESS_CODE || process.env.AUTH_TOKEN || '').trim(),
  share: process.argv.includes('--share'), // open a Cloudflare quick tunnel and print the link
  // Max duration of one `claude` run; 0 = no limit (a run then ends only when Claude
  // finishes, the guest presses Stop / disconnects, or the server stops).
  timeoutMs: process.env.TIMEOUT_MS === '0' ? 0 : intEnv('TIMEOUT_MS', 120_000),
  maxQueue: intEnv('MAX_QUEUE', 5), // requests allowed to wait behind the running one
  maxBodyBytes: intEnv('MAX_BODY_BYTES', 8 * 1024 * 1024),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  // Default model: --model on the command line, else CLAUDE_MODEL, else the CLI's own default.
  // Guests may pick another one from allowedModels.
  claudeModel: (argValue('--model') || process.env.CLAUDE_MODEL || '').trim(),
  allowedModels: (process.env.ALLOWED_MODELS || 'sonnet,opus,haiku,fable')
    .split(',')
    .map((m) => m.trim())
    .filter((m) => /^[a-z0-9][a-z0-9.-]{0,40}$/i.test(m)),
  sandboxBase: process.env.SANDBOX_DIR || path.join(os.tmpdir(), 'claude-bridge-sandbox'),
};

// Request-shape limits (the body-size cap above bounds everything in aggregate).
const LIMITS = {
  promptChars: 200_000,
  files: 300,
  pathChars: 1024,
  historyEntries: 40, // older entries are dropped, newest kept
  treeEntries: 5000, // project file list sent by the client
  contextChars: 300_000, // notes from the client: search results, skipped reads, ...
  readFiles: 25, // files Claude may ask for in one round
  searches: 8, // searches Claude may ask for in one round
  searchChars: 200,
  skills: 8, // active skills per request
  skillChars: 40_000, // instructions per skill
  skillsTotalChars: 150_000,
  questions: 4, // questions Claude may ask at once
  questionOptions: 6,
  outputBytes: 32 * 1024 * 1024, // cap on what we buffer from the CLI
};

if (CONFIG.claudeModel && !/^[a-z0-9][a-z0-9.-]{0,40}$/i.test(CONFIG.claudeModel)) {
  console.error(`Invalid model name "${CONFIG.claudeModel}". Use an alias such as sonnet, opus, haiku or fable.`);
  process.exit(1);
}
if (CONFIG.claudeModel && !CONFIG.allowedModels.includes(CONFIG.claudeModel)) CONFIG.allowedModels.unshift(CONFIG.claudeModel);

const MIN_CODE_LENGTH = 16;
const PROTOCOL_VERSION = 2; // encrypted envelopes; version 1 was a plain bearer token
const KEY_SALT = 'claude-remote-bridge/v2'; // must match the client
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // how far a request timestamp may be off
const HEARTBEAT_MS = 10_000;
const AUTH_FAILURE_DELAY_MS = 400;
const KILL_GRACE_MS = 3_000;

// ---------------------------------------------------------------------------
// The Claude invocation
// ---------------------------------------------------------------------------

/** Tells Claude what it is in this setup. Replaces Claude Code's agentic system prompt. */
const SYSTEM_PROMPT = `You are a coding assistant working on the user's project through a bridge.

How this works:
- You have NO tools of your own. You never see the user's disk directly.
- A client program on the user's machine works for you. On every request it sends:
  <project_tree>  every file path in the project (ignored and secret files are left out),
  <project_files> the contents of files that were attached or that you asked for,
  <client_notes>  results of your searches and anything the client could not do.
- Explore the project yourself. Do not ask the user to attach or paste files.

Your answer must match the required JSON schema. Each answer is one of two kinds:

1. EXPLORE: you need to look at code first.
   - Put file paths from <project_tree> in "readFiles" and/or text to look for in "searches".
   - Leave "fileUpdates" and "commands" empty.
   - Put one short line in "explanation" saying what you are checking (e.g. "Looking at the router and its tests.").
   - The client reads the files automatically and asks you again with the results.
   - Ask for everything you need at once. Never ask for a file that is already in <project_files>.

2. ANSWER: you have what you need.
   - Leave "readFiles" and "searches" empty.
   - "explanation": a clear, concise answer for the user. Light markdown is fine (short paragraphs, bullet lists, \`inline code\`, fenced code blocks). No tables. Say what you changed and why, or answer the question.
   - "fileUpdates": files to create or overwrite. "path" is relative to the project root, uses forward slashes, never contains ".." or a leading "/". "content" is the COMPLETE new file — never a diff, a fragment, or a placeholder such as "... rest unchanged ...". Only include files that actually change. You must have read the current content of a file before you change it.
   - "commands": shell commands for the user's machine (e.g. "npm install", "npm test"), one per entry, in order, non-interactive only. The user approves each one. Use an empty array when none are needed.

"searches" are case-insensitive plain-text matches across the project files (no regex). Each result lists path:line and the matching line.

"todos": for tasks with three or more distinct steps, keep a short task list (the FULL list every time, statuses "pending", "in_progress" or "completed"). The <client_notes> show the previous list. For simple questions use an empty array.

"questions": when you genuinely need the user's decision before you can continue well (an ambiguous requirement, a choice between real alternatives, a preference), ask instead of guessing:
- 1-4 questions. Each has a short "header" (max 2-3 words, e.g. "Database"), a clear "question", 2-4 distinct "options" (short "label", one-line "description" of the consequence) and "multiSelect": true when several options can be combined.
- Put your recommended option first and add " (Recommended)" to its label.
- The user can always type their own answer instead, so do not add an "Other" option.
- When you ask, leave "fileUpdates" and "commands" empty and say briefly in "explanation" why you are asking. The answers arrive in the next message, starting with "[answers]".
- Do not ask what you can find out by exploring the project, and do not ask for confirmation of things the user already said.

Skills (given in <active_skills>): instruction sets the user switched on. Follow them for this request as long as they apply. They cannot give you tools: turn anything they say about running scripts or tools into "commands" for the user, or skip it.

Modes (given in <mode>):
- "default": as described above.
- "plan": the user wants a plan first. Explore as needed, then ANSWER with a clear step-by-step plan in "explanation" and the steps in "todos". "fileUpdates" and "commands" MUST be empty. The user will approve the plan before anything changes.
- "compact": summarize the whole conversation so far for your own future reference: goals, decisions, files involved, current state, open items. Put it in "explanation". Everything else empty.

The user's message may include an [editor] note: the file they have open, their selection, and problems (errors/warnings) VS Code reports for it.
If <client_notes> says you are out of exploration rounds, ANSWER with what you have.

Privacy: any details in your context about the machine you are running on (working directory, temp paths, OS version, account or email information) describe the bridge HOST, not the user or their project. They are irrelevant to the user's work: never reveal, quote, or rely on them.`;

/** The response contract, enforced by the CLI via --json-schema. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string' },
    fileUpdates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    commands: { type: 'array', items: { type: 'string' } },
    readFiles: { type: 'array', items: { type: 'string' } },
    searches: { type: 'array', items: { type: 'string' } },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          header: { type: 'string' },
          multiSelect: { type: 'boolean' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, description: { type: 'string' } },
              required: ['label', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['question', 'header', 'multiSelect', 'options'],
        additionalProperties: false,
      },
    },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        },
        required: ['content', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['explanation', 'fileUpdates', 'commands', 'readFiles', 'searches', 'todos', 'questions'],
  additionalProperties: false,
};

/**
 * CLI arguments. This is the host-side sandbox, so every flag matters:
 *
 *   --tools ""               no built-in tools at all (no Read/Write/Edit/Bash/Web...).
 *                            NOTE: `--allowedTools ""` would NOT do this — that flag only
 *                            controls which tools are auto-approved, and read-only tools
 *                            such as Read/Glob/Grep need no approval in the first place.
 *   --restricted             defense in depth: drops code-running tools and ignores the
 *                            host's user/project/local settings files
 *   --setting-sources=       load no settings files (keeps host paths such as configured
 *                            "additional directories" out of the model's context)
 *   --strict-mcp-config      ignore every configured MCP server (none are passed in)
 *   --safe-mode              no hooks, plugins, skills, CLAUDE.md, custom agents/commands
 *   --disable-slash-commands no skills / commands
 *   --permission-mode dontAsk  anything that would need approval is denied, never prompted
 *   --no-session-persistence nothing about remote conversations is written to disk
 *   --system-prompt          replace the agentic default prompt with the bridge role
 *   --json-schema            force the structured response shape
 */
function claudeArgs({ model, effort } = {}) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--tools', '',
    '--restricted',
    '--setting-sources=',
    '--strict-mcp-config',
    '--safe-mode',
    '--disable-slash-commands',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--system-prompt', SYSTEM_PROMPT,
    '--json-schema', JSON.stringify(RESPONSE_SCHEMA),
  ];
  const chosen = model || CONFIG.claudeModel;
  if (chosen) args.push('--model', chosen);
  if (effort) args.push('--effort', effort);
  return args;
}

/** Environment for the CLI: ours, minus the bridge secret (it has no business in there). */
function claudeEnv() {
  const env = { ...process.env };
  delete env.ACCESS_CODE;
  delete env.AUTH_TOKEN;
  return env;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An error that is safe to report to the remote client. */
class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function errorBody(code, message) {
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------
// Sandbox directory
// ---------------------------------------------------------------------------

/** Create the sandbox base (0700) and make sure nobody else planted it first. */
function ensureSandboxBase() {
  fs.mkdirSync(CONFIG.sandboxBase, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(CONFIG.sandboxBase);
  const foreignOwner = typeof process.getuid === 'function' && st.uid !== process.getuid();
  if (!st.isDirectory() || st.isSymbolicLink() || foreignOwner) {
    throw new Error(`Sandbox path ${CONFIG.sandboxBase} is not a directory owned by this user`);
  }
  fs.chmodSync(CONFIG.sandboxBase, 0o700);
}

/** A fresh, empty working directory for a single Claude run. */
function createRunDir() {
  ensureSandboxBase();
  return fs.mkdtempSync(path.join(CONFIG.sandboxBase, 'run-'));
}

function removeRunDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log(`warning: could not remove ${dir}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Combine history, attached files and the new instruction into one prompt.
 * The sections are plain delimiters for the model; nothing here is interpreted
 * by a shell or by the CLI, so no escaping is required.
 */
function buildPrompt({ prompt, files, history, tree, context, mode, skills }) {
  const parts = [`<mode>${mode}</mode>`, ''];

  if (skills.length > 0) {
    parts.push('<active_skills>');
    for (const skill of skills) parts.push(`<skill name=${JSON.stringify(skill.name)}>\n${skill.instructions}\n</skill>`);
    parts.push('</active_skills>', '');
  }

  if (history.length > 0) {
    parts.push('<conversation_history>');
    for (const turn of history) {
      parts.push(`<turn role="${turn.role}">\n${turn.content}\n</turn>`);
    }
    parts.push('</conversation_history>', '');
  }

  if (tree.length > 0) {
    parts.push('<project_tree>', ...tree, '</project_tree>', '');
  } else {
    parts.push('<project_tree>\n(the client did not send a file list)\n</project_tree>', '');
  }

  if (files.length > 0) {
    parts.push('<project_files>');
    for (const file of files) {
      parts.push(`<file path=${JSON.stringify(file.path)}>\n${file.content}\n</file>`);
    }
    parts.push('</project_files>', '');
  } else {
    parts.push('<project_files>\n(none yet — ask for the files you need with "readFiles")\n</project_files>', '');
  }

  if (context) parts.push('<client_notes>', context, '</client_notes>', '');

  parts.push('<instruction>', prompt, '</instruction>');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Running Claude
// ---------------------------------------------------------------------------

let activeChild = null; // the CLI process currently running, if any

/**
 * Run `claude -p` once and resolve with the normalized bridge response.
 * The promise settles only after the child process has fully exited, so the
 * queue can never start a second run while the previous one is still alive.
 */
function runClaude(promptText, signal, options = {}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new BridgeError(499, 'cancelled', 'Request was cancelled before it started.'));
      return;
    }

    let runDir;
    let child;
    try {
      runDir = createRunDir();
      child = spawn(CONFIG.claudeBin, claudeArgs(options), {
        cwd: runDir, // empty directory: nothing to see even if a tool slipped through
        env: claudeEnv(),
        shell: false, // argument array only — remote input never reaches a shell
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      if (runDir) removeRunDir(runDir);
      log(`failed to start claude: ${err.message}`);
      reject(new BridgeError(500, 'spawn_failed', 'Host could not start the claude CLI.'));
      return;
    }

    activeChild = child;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure = null; // set when we decide to kill the run
    let settled = false;
    let killTimer = null;

    const kill = (reason) => {
      if (failure) return;
      failure = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };

    const timeout = CONFIG.timeoutMs > 0 && setTimeout(
      () =>
        kill(
          new BridgeError(
            504,
            'timeout',
            `Claude did not finish within ${Math.round(CONFIG.timeoutMs / 1000)}s.`
          )
        ),
      CONFIG.timeoutMs
    );

    const onAbort = () =>
      kill(new BridgeError(499, 'cancelled', 'Request was cancelled by the client.'));
    signal.addEventListener('abort', onAbort, { once: true });

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      if (activeChild === child) activeChild = null;
      removeRunDir(runDir);
      fn();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > LIMITS.outputBytes) {
        kill(new BridgeError(502, 'output_too_large', 'Claude produced too much output.'));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });

    // The CLI may exit before reading all of stdin; never let EPIPE crash the server.
    child.stdin.on('error', () => {});
    child.stdin.end(promptText);

    child.on('error', (err) => {
      settle(() => {
        log(`claude process error: ${err.message}`);
        const hint = err.code === 'ENOENT' ? ' (claude CLI not found on host PATH)' : '';
        reject(new BridgeError(500, 'spawn_failed', `Host could not run the claude CLI${hint}.`));
      });
    });

    child.on('close', (code) => {
      settle(() => {
        if (failure) {
          reject(failure);
          return;
        }
        try {
          resolve(parseClaudeOutput(stdout));
        } catch (err) {
          // Keep host-side detail (stderr may contain local paths) in the host log only.
          log(`claude exited with code ${code}; stderr: ${stderr.trim().slice(0, 2000) || '(empty)'}`);
          reject(
            err instanceof BridgeError
              ? err
              : new BridgeError(502, 'claude_failed', `The claude CLI failed (exit code ${code}).`)
          );
        }
      });
    });
  });
}

/** Parse the `--output-format json` envelope and extract the structured answer. */
function parseClaudeOutput(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error('claude CLI output was not JSON');
  }
  if (!envelope || typeof envelope !== 'object') throw new Error('unexpected claude CLI output');

  if (envelope.is_error) {
    // Typically "usage limit reached", "not logged in", etc. — useful to the remote user.
    const detail = typeof envelope.result === 'string' ? envelope.result : envelope.subtype;
    throw new BridgeError(502, 'claude_error', `Claude returned an error: ${String(detail || 'unknown').slice(0, 500)}`);
  }

  let data = envelope.structured_output;
  if (!data || typeof data !== 'object') data = parseLooseJson(envelope.result);
  if (!data || typeof data !== 'object') {
    // The model answered in prose instead of the schema: still deliver the text.
    data = { explanation: typeof envelope.result === 'string' ? envelope.result : '' };
  }
  const result = normalizeResult(data);
  result.usage = usageOf(envelope);
  return result;
}

/** Duration, tokens and the main model of one CLI run (no host details). */
function usageOf(envelope) {
  const usage = envelope.usage && typeof envelope.usage === 'object' ? envelope.usage : {};
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const models = envelope.modelUsage && typeof envelope.modelUsage === 'object' ? envelope.modelUsage : {};
  let model = '';
  let most = -1;
  for (const [name, stats] of Object.entries(models)) {
    const out = num(stats && stats.outputTokens);
    if (out > most) {
      most = out;
      model = name;
    }
  }
  return {
    durationMs: num(envelope.duration_ms),
    inputTokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    outputTokens: num(usage.output_tokens),
    costUsd: num(envelope.total_cost_usd),
    model: model.slice(0, 60),
  };
}

/** Best-effort JSON extraction from free text (handles ```json fences). */
function parseLooseJson(text) {
  if (typeof text !== 'string') return null;
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Return a relative, forward-slash path that stays inside the project root,
 * or null if the model produced something unsafe (absolute path, "..", etc.).
 * The client re-validates this — never rely on one side only.
 */
function sanitizeRelativePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().replace(/\\/g, '/');
  if (!p || p.length > LIMITS.pathChars || p.includes('\0')) return null;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return null;
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

/** Coerce whatever the model returned into the exact response contract. */
function normalizeResult(data) {
  const result = {
    explanation: typeof data.explanation === 'string' ? data.explanation : '',
    fileUpdates: [],
    commands: [],
    readFiles: [],
    searches: [],
    todos: [],
    questions: [],
  };
  const rejected = [];

  if (Array.isArray(data.fileUpdates)) {
    for (const update of data.fileUpdates) {
      if (!update || typeof update.content !== 'string') continue;
      const safePath = sanitizeRelativePath(update.path);
      if (safePath) result.fileUpdates.push({ path: safePath, content: update.content });
      else rejected.push(String(update.path).slice(0, 200));
    }
  }

  if (Array.isArray(data.commands)) {
    for (const command of data.commands) {
      if (typeof command === 'string' && command.trim()) result.commands.push(command.trim());
    }
  }

  if (Array.isArray(data.readFiles)) {
    for (const raw of data.readFiles) {
      const safePath = sanitizeRelativePath(raw);
      if (safePath && !result.readFiles.includes(safePath)) result.readFiles.push(safePath);
    }
    result.readFiles = result.readFiles.slice(0, LIMITS.readFiles);
  }

  if (Array.isArray(data.searches)) {
    for (const raw of data.searches) {
      if (typeof raw !== 'string') continue;
      const query = raw.trim().slice(0, LIMITS.searchChars);
      if (query && !result.searches.includes(query)) result.searches.push(query);
    }
    result.searches = result.searches.slice(0, LIMITS.searches);
  }

  if (Array.isArray(data.questions)) {
    for (const q of data.questions.slice(0, LIMITS.questions)) {
      if (!q || typeof q.question !== 'string' || !q.question.trim() || !Array.isArray(q.options)) continue;
      const options = q.options
        .filter((o) => o && typeof o.label === 'string' && o.label.trim())
        .slice(0, LIMITS.questionOptions)
        .map((o) => ({ label: o.label.trim().slice(0, 100), description: typeof o.description === 'string' ? o.description.trim().slice(0, 300) : '' }));
      if (options.length < 2) continue;
      result.questions.push({
        question: q.question.trim().slice(0, 500),
        header: typeof q.header === 'string' ? q.header.trim().slice(0, 24) : '',
        multiSelect: q.multiSelect === true,
        options,
      });
    }
  }

  if (Array.isArray(data.todos)) {
    for (const todo of data.todos.slice(0, 30)) {
      if (!todo || typeof todo.content !== 'string' || !todo.content.trim()) continue;
      const status = ['pending', 'in_progress', 'completed'].includes(todo.status) ? todo.status : 'pending';
      result.todos.push({ content: todo.content.trim().slice(0, 300), status });
    }
  }

  if (rejected.length > 0) {
    result.explanation += `\n\n[bridge] Dropped file update(s) with unsafe paths: ${rejected.join(', ')}`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// FIFO queue — exactly one Claude run at a time
// ---------------------------------------------------------------------------

const queue = [];
let running = false;
let runningTicket = null; // ticket of the request Claude is working on

function pendingCount() {
  return queue.length + (running ? 1 : 0);
}

/**
 * Where a request stands, for the guest's "waiting for the host" display.
 * The ticket is a random id the client sends with /ask and then with /health.
 */
function queueStatus(ticket) {
  if (!ticket) return { state: 'unknown', ahead: null };
  if (running && runningTicket === ticket) return { state: 'running', ahead: 0 };
  const index = queue.findIndex((entry) => entry.ticket === ticket);
  if (index >= 0) return { state: 'queued', ahead: index + (running ? 1 : 0) };
  return { state: 'unknown', ahead: null };
}

function enqueue(job, ticket = null) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject, ticket, queuedAt: Date.now() });
    pump();
  });
}

async function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  runningTicket = next.ticket;
  const waited = Date.now() - next.queuedAt;
  if (waited > 1000) log(`started a queued request after waiting ${(waited / 1000).toFixed(1)}s`);
  try {
    next.resolve(await next.job());
  } catch (err) {
    next.reject(err);
  } finally {
    running = false;
    runningTicket = null;
    pump();
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Encryption (the access code is the key — it is never transmitted)
//
//   key      = scrypt(accessCode, KEY_SALT) -> 32 bytes
//   envelope = { v: 2, iv, ct, tag }   AES-256-GCM, base64 fields
//   request  : plaintext { ts, body }, additional data "req:<route>"
//   reply    : plaintext is the result (or { error }), additional data "res:<request iv>"
//
// A request that does not decrypt was not made with the right access code.
// The timestamp plus a memory of recent IVs stops a captured request from
// being replayed, and binding the reply to the request IV stops replies from
// being swapped between requests.
// ---------------------------------------------------------------------------

let KEY = null; // derived once at startup

function deriveKey(accessCode) {
  return crypto.scryptSync(accessCode, KEY_SALT, 32);
}

function seal(key, value, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: PROTOCOL_VERSION,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/** Decrypt an envelope. Throws when the key, the data or the additional data do not match. */
function unseal(key, envelope, aad) {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** IVs of recently accepted requests (insertion-ordered, so the oldest expire first). */
const seenNonces = new Map();

/** Returns false when this request IV was already used inside the replay window. */
function rememberNonce(iv) {
  const now = Date.now();
  for (const [key, expires] of seenNonces) {
    if (expires > now) break;
    seenNonces.delete(key);
  }
  if (seenNonces.has(iv)) return false;
  seenNonces.set(iv, now + 2 * MAX_CLOCK_SKEW_MS);
  return true;
}

/**
 * Authenticate and decrypt a request body. Returns { iv, body }.
 * Throws BridgeError 400 for a client that does not speak the encrypted
 * protocol and 401 for anything not made with the right access code.
 */
function openRequest(raw, route) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new BridgeError(400, 'bad_request', 'Body must be valid JSON.');
  }
  const shaped =
    envelope &&
    typeof envelope === 'object' &&
    envelope.v === PROTOCOL_VERSION &&
    typeof envelope.iv === 'string' &&
    typeof envelope.ct === 'string' &&
    typeof envelope.tag === 'string';
  if (!shaped) {
    throw new BridgeError(
      400,
      'unsupported_client',
      'This host only accepts encrypted requests. Update the client to claude-remote-bridge 2.x.'
    );
  }

  let message;
  try {
    message = unseal(KEY, envelope, `req:${route}`);
  } catch {
    throw new BridgeError(401, 'unauthorized', 'Access code rejected.');
  }
  if (!message || typeof message.ts !== 'number' || Math.abs(Date.now() - message.ts) > MAX_CLOCK_SKEW_MS) {
    throw new BridgeError(401, 'stale_request', 'Request timestamp is out of range. Check the clock on both machines.');
  }
  if (!rememberNonce(envelope.iv)) {
    throw new BridgeError(401, 'replayed_request', 'This request was already used.');
  }
  return { iv: envelope.iv, body: message.body };
}

/** Send an encrypted 200 reply bound to the request it answers. */
function sendSealed(res, requestIv, value) {
  sendJson(res, 200, seal(KEY, value, `res:${requestIv}`));
}

/** Caller label for the log. Behind a local tunnel every socket is loopback, so use the forwarded address. */
function clientIdOf(req) {
  const remote = req.socket.remoteAddress || 'unknown';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['cf-connecting-ip'];
  if (loopback && typeof forwarded === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(forwarded)) return `${forwarded} (via tunnel)`;
  return remote;
}

/** Read the request body, rejecting anything larger than the configured cap. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BridgeError(413, 'payload_too_large', `Request body exceeds ${limit} bytes.`));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new BridgeError(413, 'payload_too_large', `Request body exceeds ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/** Validate and normalize the decrypted /ask payload. Throws BridgeError(400) on bad input. */
function validatePayload(data) {
  const bad = (message) => new BridgeError(400, 'bad_request', message);

  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Request must be a JSON object.');

  if (typeof data.prompt !== 'string' || !data.prompt.trim()) throw bad('"prompt" must be a non-empty string.');
  if (data.prompt.length > LIMITS.promptChars) throw bad(`"prompt" exceeds ${LIMITS.promptChars} characters.`);

  const files = data.files === undefined ? [] : data.files;
  if (!Array.isArray(files)) throw bad('"files" must be an array.');
  if (files.length > LIMITS.files) throw bad(`"files" may contain at most ${LIMITS.files} entries.`);
  for (const file of files) {
    const ok =
      file &&
      typeof file === 'object' &&
      typeof file.path === 'string' &&
      file.path.length > 0 &&
      file.path.length <= LIMITS.pathChars &&
      typeof file.content === 'string';
    if (!ok) throw bad('Each entry in "files" must be { "path": string, "content": string }.');
  }

  const history = data.history === undefined ? [] : data.history;
  if (!Array.isArray(history)) throw bad('"history" must be an array.');
  for (const turn of history) {
    const ok =
      turn &&
      typeof turn === 'object' &&
      (turn.role === 'user' || turn.role === 'assistant') &&
      typeof turn.content === 'string';
    if (!ok) throw bad('Each entry in "history" must be { "role": "user"|"assistant", "content": string }.');
  }

  const tree = data.tree === undefined ? [] : data.tree;
  if (!Array.isArray(tree)) throw bad('"tree" must be an array of paths.');
  if (tree.length > LIMITS.treeEntries) throw bad(`"tree" may contain at most ${LIMITS.treeEntries} paths.`);
  for (const entry of tree) {
    if (typeof entry !== 'string' || entry.length > LIMITS.pathChars || /[\r\n]/.test(entry)) {
      throw bad('Each entry in "tree" must be a single-line path.');
    }
  }

  const context = data.context === undefined ? '' : data.context;
  if (typeof context !== 'string') throw bad('"context" must be a string.');
  if (context.length > LIMITS.contextChars) throw bad(`"context" exceeds ${LIMITS.contextChars} characters.`);

  const model = data.model === undefined || data.model === '' ? '' : data.model;
  if (model && (typeof model !== 'string' || !CONFIG.allowedModels.includes(model))) {
    throw bad(`"model" must be one of: ${CONFIG.allowedModels.join(', ') || '(none allowed)'}.`);
  }
  const effort = data.effort === undefined || data.effort === '' ? '' : data.effort;
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw bad('"effort" must be low, medium, high, xhigh or max.');
  const mode = data.mode === undefined || data.mode === '' ? 'default' : data.mode;
  if (!['default', 'plan', 'compact'].includes(mode)) throw bad('"mode" must be default, plan or compact.');

  const skills = data.skills === undefined ? [] : data.skills;
  if (!Array.isArray(skills)) throw bad('"skills" must be an array.');
  if (skills.length > LIMITS.skills) throw bad(`At most ${LIMITS.skills} skills can be active at once.`);
  let skillChars = 0;
  for (const skill of skills) {
    const ok =
      skill &&
      typeof skill.name === 'string' &&
      /^[\w .:-]{1,64}$/.test(skill.name) &&
      typeof skill.instructions === 'string' &&
      skill.instructions.length <= LIMITS.skillChars;
    if (!ok) throw bad(`Each skill must be { "name": short name, "instructions": up to ${LIMITS.skillChars} characters }.`);
    skillChars += skill.instructions.length;
  }
  if (skillChars > LIMITS.skillsTotalChars) throw bad(`Active skills exceed ${LIMITS.skillsTotalChars} characters in total.`);

  return {
    model,
    effort,
    mode,
    skills: skills.map((k) => ({ name: k.name, instructions: k.instructions })),
    prompt: data.prompt,
    files: files.map((f) => ({ path: f.path, content: f.content })),
    history: history.slice(-LIMITS.historyEntries).map((t) => ({ role: t.role, content: t.content })),
    tree,
    context,
  };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handleAsk(res, clientId, request) {
  const payload = validatePayload(request.body);

  if (queue.length >= CONFIG.maxQueue) {
    throw new BridgeError(429, 'queue_full', 'Too many requests are waiting. Try again shortly.');
  }

  const started = Date.now();
  const position = pendingCount();
  log(
    `ask from ${clientId}: prompt=${payload.prompt.length} chars, files=${payload.files.length}, ` +
      `tree=${payload.tree.length}, history=${payload.history.length}, queued behind ${position}`
  );

  // From here on the request is accepted. Send headers right away and trickle
  // whitespace while Claude works: proxies such as Cloudflare drop connections
  // that stay silent for ~100s. Leading whitespace is valid JSON, so the client
  // can parse the body as usual. Failures after this point travel inside the
  // encrypted reply as { "error": { code, message } } because the 200 is already sent.
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  });
  res.write(' ');
  const heartbeat = setInterval(() => res.write(' '), HEARTBEAT_MS);

  // If the client hangs up, stop working for it (and kill the CLI if it is running).
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  let body;
  try {
    const ticket = request.body && typeof request.body.ticket === 'string' && /^[a-f0-9]{16,64}$/.test(request.body.ticket) ? request.body.ticket : null;
    body = await enqueue(() => runClaude(buildPrompt(payload), abort.signal, { model: payload.model, effort: payload.effort }), ticket);
    log(
      `done for ${clientId} in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
        `fileUpdates=${body.fileUpdates.length}, commands=${body.commands.length}, ` +
        `readFiles=${body.readFiles.length}, searches=${body.searches.length}`
    );
  } catch (err) {
    if (err instanceof BridgeError) {
      log(`failed for ${clientId}: ${err.code}`);
      body = errorBody(err.code, err.message);
    } else {
      log(`internal error for ${clientId}: ${err && err.stack ? err.stack : err}`);
      body = errorBody('internal_error', 'Internal bridge error.');
    }
  } finally {
    clearInterval(heartbeat);
  }

  if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify(seal(KEY, body, `res:${request.iv}`)));
}

/**
 * Routes: POST /health and POST /ask, both carrying an encrypted envelope.
 * Rule for clients: status 200 means an encrypted reply; any other status is a
 * plain { "error": { code, message } } that contains nothing sensitive.
 */
async function handleRequest(req, res) {
  const clientId = clientIdOf(req);
  const route = (req.url || '').split('?')[0];

  if (route !== '/ask' && route !== '/health') {
    sendJson(res, 404, errorBody('not_found', 'Unknown route.'), { Connection: 'close' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, errorBody('method_not_allowed', 'Use POST.'), { Allow: 'POST', Connection: 'close' });
    return;
  }

  const raw = await readBody(req, CONFIG.maxBodyBytes);

  let request;
  try {
    request = openRequest(raw, route);
  } catch (err) {
    if (err instanceof BridgeError && err.status === 401) {
      log(`401 from ${clientId} (${route}): ${err.code}`);
      // A small fixed delay makes guessing even more pointless than a 125-bit code already does.
      await new Promise((resolve) => setTimeout(resolve, AUTH_FAILURE_DELAY_MS));
    }
    throw err;
  }

  if (route === '/health') {
    sendSealed(res, request.iv, {
      ok: true,
      busy: running,
      queued: queue.length,
      ...(request.body && typeof request.body.ticket === 'string' ? { request: queueStatus(request.body.ticket) } : {}),
      protocol: 4,
      features: ['models', 'plan', 'todos', 'questions', 'skills'],
      models: CONFIG.allowedModels,
      defaultModel: CONFIG.claudeModel || '',
    });
    return;
  }
  await handleAsk(res, clientId, request);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/** Make sure there is an access code; create and save one on first run. */
function ensureAccessCode() {
  if (CONFIG.accessCode) {
    if (CONFIG.accessCode.length < MIN_CODE_LENGTH) {
      console.error(
        `The access code in .env is shorter than ${MIN_CODE_LENGTH} characters.\n` +
          'Remove it to have a new one generated, or create one with:  node server.js --gen-code'
      );
      process.exit(1);
    }
    return;
  }
  CONFIG.accessCode = generateAccessCode();
  let prefix = '';
  try {
    const current = fs.readFileSync(ENV_FILE, 'utf8');
    if (current && !current.endsWith('\n')) prefix = '\n';
  } catch {
    /* no .env yet — it is created below */
  }
  fs.appendFileSync(ENV_FILE, `${prefix}ACCESS_CODE=${CONFIG.accessCode}\n`, { mode: 0o600 });
  log(`created a new access code and saved it to ${ENV_FILE}`);
}

// ---------------------------------------------------------------------------
// --share: the public link
//
// TUNNEL in .env picks how the link is made:
//   quick       (default) Cloudflare quick tunnel: no account, but a NEW random link on every start
//   ngrok       ngrok with your free static domain: the SAME link every time
//                 needs NGROK_DOMAIN (e.g. my-bridge.ngrok-free.app) and NGROK_AUTHTOKEN
//   cloudflare  named Cloudflare tunnel on your own domain: the SAME link every time
//                 needs CLOUDFLARE_TUNNEL_TOKEN and PUBLIC_URL (e.g. https://bridge.example.com)
//   none        start no tunnel; just announce PUBLIC_URL (Tailscale Funnel, your own proxy, ...)
// ---------------------------------------------------------------------------

let tunnelChild = null;
let shuttingDown = false;

/** First candidate that runs `<bin> <versionArg>` successfully, or null. */
function findBinary(candidates, versionArg = '--version') {
  for (const candidate of candidates.filter(Boolean)) {
    const probe = spawnSync(candidate, [versionArg], { encoding: 'utf8', timeout: 15_000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function normalizePublicUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Environment for tunnel programs: ours, minus the bridge secret. */
function tunnelEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ACCESS_CODE;
  delete env.AUTH_TOKEN;
  return env;
}

/**
 * Work out how to open the public link from .env. Exits with a clear message
 * when something required is missing. Returns null when --share was not given.
 */
function tunnelPlan() {
  if (!CONFIG.share) return null;
  const kind = (process.env.TUNNEL || 'quick').trim().toLowerCase();
  const targetHost = CONFIG.host === '0.0.0.0' || CONFIG.host === '::' ? '127.0.0.1' : CONFIG.host;
  const target = `http://${targetHost}:${CONFIG.port}`;
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };
  const cloudflared = () =>
    findBinary([process.env.CLOUDFLARED_BIN, 'cloudflared', path.join(os.homedir(), '.local', 'bin', 'cloudflared')]) ||
    fail(
      'This tunnel needs cloudflared, which was not found.\n' +
        'Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
        'or set CLOUDFLARED_BIN in .env to the full path of the binary.'
    );

  if (kind === 'quick') {
    return {
      kind,
      label: 'Cloudflare quick tunnel',
      bin: cloudflared(),
      args: ['tunnel', '--no-autoupdate', '--url', target],
      env: tunnelEnv(),
      link: null, // read from cloudflared's output
      linkPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      readyPattern: /Registered tunnel connection/,
      fixed: false,
    };
  }

  if (kind === 'cloudflare') {
    const token = (process.env.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
    const link = normalizePublicUrl(process.env.PUBLIC_URL || '');
    if (!token || !link) {
      fail(
        'TUNNEL=cloudflare needs two settings in .env:\n' +
          '  CLOUDFLARE_TUNNEL_TOKEN=<token from Cloudflare Zero Trust → Networks → Tunnels → your tunnel>\n' +
          '  PUBLIC_URL=https://<the public hostname you routed to this tunnel>\n' +
          `Route that public hostname to ${target} in the Cloudflare dashboard. See PM2.md / README.md.`
      );
    }
    return {
      kind,
      label: 'Cloudflare named tunnel',
      bin: cloudflared(),
      args: ['tunnel', '--no-autoupdate', 'run'],
      env: tunnelEnv({ TUNNEL_TOKEN: token }), // passed via the environment, not visible in `ps`
      link,
      readyPattern: /Registered tunnel connection/,
      fixed: true,
    };
  }

  if (kind === 'ngrok') {
    const domain = (process.env.NGROK_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      fail(
        'TUNNEL=ngrok needs your free static domain in .env:\n' +
          '  NGROK_DOMAIN=<name>.ngrok-free.app   (ngrok dashboard → Domains)\n' +
          '  NGROK_AUTHTOKEN=<token>               (ngrok dashboard → Your Authtoken)'
      );
    }
    const bin =
      findBinary([process.env.NGROK_BIN, 'ngrok', path.join(os.homedir(), '.local', 'bin', 'ngrok')], 'version') ||
      fail('TUNNEL=ngrok needs the ngrok program. Install it from https://ngrok.com/download (or put it in ~/.local/bin), or set NGROK_BIN in .env.');
    const help = spawnSync(bin, ['http', '--help'], { encoding: 'utf8', timeout: 15_000 });
    const urlFlag = /--url\b/.test(`${help.stdout}${help.stderr}`) ? `--url=https://${domain}` : `--domain=${domain}`;
    const extra = {};
    if (process.env.NGROK_AUTHTOKEN) extra.NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN.trim();
    return {
      kind,
      label: 'ngrok static domain',
      bin,
      args: ['http', target, urlFlag, '--log', 'stdout', '--log-format', 'logfmt'],
      env: tunnelEnv(extra),
      link: `https://${domain}`,
      readyPattern: /started tunnel|msg="?started tunnel|url=https:\/\//i,
      errorPattern: /lvl=(eror|crit)|ERR_NGROK_/i,
      fixed: true,
    };
  }

  if (kind === 'none') {
    const link = normalizePublicUrl(process.env.PUBLIC_URL || '');
    if (!link) fail('TUNNEL=none needs PUBLIC_URL in .env: the address your own tunnel or proxy (for example Tailscale Funnel) serves.');
    return { kind, label: 'external tunnel', bin: null, link, fixed: true };
  }

  fail(`Unknown TUNNEL="${kind}" in .env. Use quick, ngrok, cloudflare or none.`);
  return null;
}

function printShareBanner(link, plan) {
  const line = '─'.repeat(66);
  console.log(
    [
      '',
      line,
      '  Your Claude bridge is live. Share BOTH of these with your guest:',
      '',
      `    Link:         ${link}`,
      `    Access code:  ${CONFIG.accessCode}`,
      `    Model:        ${CONFIG.claudeModel || 'CLI default'}  (guests can switch to: ${CONFIG.allowedModels.join(', ')})`,
      `    Tunnel:       ${plan.label}`,
      '',
      '  Guest, in a terminal:  claude-bridge --setup',
      '  Guest, in VS Code:     the gear in the Claude Bridge panel',
      '',
      '  Send the access code privately. The access code stays the same',
      plan.fixed
        ? '  (it is in .env). This link stays the same too. Ctrl+C stops sharing.'
        : '  (it is in .env). The link changes each time this server starts;\n  set TUNNEL in .env for a fixed link. Ctrl+C stops sharing.',
      line,
      '',
    ].join('\n')
  );
}

/**
 * Run the tunnel program, wait until it is connected, then print the link.
 * If it dies, start it again with an increasing pause between attempts.
 */
function startTunnel(plan, attempt = 0) {
  if (shuttingDown) return;
  if (!plan.bin) {
    printShareBanner(plan.link, plan);
    return;
  }
  const child = spawn(plan.bin, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], env: plan.env });
  tunnelChild = child;

  let link = plan.link;
  let connected = false;
  let announced = false;
  let pending = '';
  let fallbackTimer = plan.link ? setTimeout(() => announce(), 25_000) : null;

  function announce() {
    if (announced || !link) return;
    announced = true;
    clearTimeout(fallbackTimer);
    printShareBanner(link, plan);
  }

  const onOutput = (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const text of lines) {
      if (plan.linkPattern && !link) {
        const match = plan.linkPattern.exec(text);
        if (match) {
          link = match[0];
          // Normally the "connected" line follows within seconds; do not wait forever for it.
          fallbackTimer = setTimeout(announce, 20_000);
        }
      }
      if (plan.readyPattern && plan.readyPattern.test(text)) connected = true;
      const isError = /\bERR\b/.test(text) || (plan.errorPattern && plan.errorPattern.test(text));
      if (isError && !announced) log(`${plan.kind} tunnel: ${text.trim().slice(0, 300)}`);
    }
    if (link && connected) announce();
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);

  let finished = false;
  const onExit = (detail) => {
    if (finished) return;
    finished = true;
    clearTimeout(fallbackTimer);
    if (tunnelChild === child) tunnelChild = null;
    if (shuttingDown) return;
    const nextAttempt = announced ? 0 : attempt + 1; // a tunnel that worked resets the back-off
    const delaySeconds = Math.min(60, 3 * 2 ** nextAttempt);
    log(
      `tunnel stopped (${detail}); ${plan.fixed ? 'the link stays the same' : 'the old link no longer works'}. ` +
        `Reconnecting in ${delaySeconds}s…`
    );
    setTimeout(() => startTunnel(plan, nextAttempt), delaySeconds * 1000);
  };
  child.on('error', (err) => onExit(err.message));
  child.on('close', (code, signal) => onExit(signal || `exit code ${code}`));
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function start() {
  ensureAccessCode();
  try {
    fs.chmodSync(ENV_FILE, 0o600); // the file holds the access code: owner-only
  } catch {
    /* no .env (code came from the environment) or not ours to change */
  }
  KEY = deriveKey(CONFIG.accessCode);

  ensureSandboxBase();

  const version = spawnSync(CONFIG.claudeBin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (version.error || version.status !== 0) {
    console.error(`Could not run "${CONFIG.claudeBin} --version". Is Claude Code installed and on PATH?`);
    process.exit(1);
  }

  const plan = tunnelPlan();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!(err instanceof BridgeError)) log(`unhandled error: ${err && err.stack ? err.stack : err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err instanceof BridgeError ? err.status : 500;
      const body =
        err instanceof BridgeError
          ? errorBody(err.code, err.message)
          : errorBody('internal_error', 'Internal bridge error.');
      // Close the connection: on early rejections part of the body may still be unread.
      sendJson(res, status, body, { Connection: 'close' });
    });
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${CONFIG.port} is already used by another program. Set a different PORT in .env.`);
    } else {
      console.error(`Could not start the server: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    log(`claude-remote-bridge listening on http://${CONFIG.host}:${CONFIG.port}`);
    log(`claude CLI: ${version.stdout.trim()} | timeout ${CONFIG.timeoutMs ? `${CONFIG.timeoutMs / 1000}s` : 'none'} | sandbox ${CONFIG.sandboxBase}`);
    log(`default model: ${CONFIG.claudeModel || 'CLI default'} | guests may choose: ${CONFIG.allowedModels.join(', ') || '(none)'}`);
    if (CONFIG.host === '0.0.0.0' || CONFIG.host === '::') {
      log('WARNING: listening on all interfaces. Prefer 127.0.0.1 (with a tunnel) or your Tailscale IP.');
    }
    if (plan) {
      log(`opening the public link: ${plan.label}${plan.fixed ? ` (${plan.link})` : ''}…`);
      startTunnel(plan);
    } else {
      log('no tunnel requested. Start with --share to get a public link, or see the README for Tailscale.');
    }
  });

  const shutdown = (signalName) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signalName} received, shutting down`);
    if (activeChild) activeChild.kill('SIGTERM');
    if (tunnelChild) tunnelChild.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), KILL_GRACE_MS).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
