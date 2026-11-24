#!/usr/bin/env node
'use strict';

/**
 * claude-bridge — terminal client for a claude-remote-bridge host.
 *
 * Chat with the host's Claude about the project in the current folder.
 * Claude sees the project's file list and reads the files it needs by itself;
 * those reads happen here, on this machine. Everything that changes the
 * project also happens here, and only after you approve it:
 *   - proposed file changes are shown as a diff and written only after "y"
 *   - proposed commands are shown one by one and run only after "y"
 *
 * Connecting needs two things from the host: the link and the access code.
 * The access code is never sent anywhere; it is the encryption key.
 *
 * Zero npm dependencies. Requires Node.js 18+.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const core = require('./bridge-core');

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const VERSION = (() => {
  try {
    return require('./package.json').version;
  } catch {
    return 'dev';
  }
})();

const USAGE = `Usage: claude-bridge [options] [prompt]

Chat with a remote Claude through a claude-remote-bridge host.
Run it inside the project folder you want to work on.

  claude-bridge                           start an interactive session
  claude-bridge "explain the auth flow"   start a session with a first message
  claude-bridge -p "question"             print one answer and exit

Options:
  -p, --print     answer once and exit; proposed changes are listed, never applied
      --setup     enter the link and the access code again
  -v, --version   show the version
  -h, --help      show this help

Claude reads the project files it needs. @path still points it at a file or folder.
Settings live in ~/.bridge.json, or in the BRIDGE_URL and ACCESS_CODE environment variables.`;

function parseArgs(argv) {
  const args = { print: false, setup: false, help: false, version: false, unknown: null, prompt: '' };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-p' || arg === '--print') args.print = true;
    else if (arg === '--setup') args.setup = true;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '-v' || arg === '--version') args.version = true;
    else if (arg.length > 1 && arg.startsWith('-')) args.unknown = args.unknown || arg;
    else words.push(arg);
  }
  args.prompt = words.join(' ').trim();
  return args;
}

const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log(USAGE);
  process.exit(0);
}
if (ARGS.version) {
  console.log(`${VERSION} (claude-bridge)`);
  process.exit(0);
}
if (ARGS.unknown) {
  console.error(`Unknown option: ${ARGS.unknown}\n\n${USAGE}`);
  process.exit(2);
}
if (ARGS.print && !ARGS.prompt) {
  console.error('-p needs a prompt, e.g.  claude-bridge -p "what does this project do?"');
  process.exit(2);
}

const ROOT = process.cwd();
const CONFIG_NAME = '.bridge.json';
const CONFIG_PATHS = [path.join(ROOT, CONFIG_NAME), path.join(os.homedir(), CONFIG_NAME)];
const DIFF_PREVIEW_LINES = 24; // per file, before "d" shows everything

/** Choices for this terminal session (not saved). */
const prefs = {
  mode: 'default', // 'default' (ask before edits) | 'auto' (auto-accept edits) | 'plan'
  model: '', // '' = host default
  effort: '', // '' = default
  models: [], // what the host allows
  skills: [], // every available skill (built-in, personal, project)
  activeSkills: [], // ids of the skills that are on
};
const MODE_LABELS = { default: 'ask before edits', auto: 'auto-accept edits', plan: 'plan mode' };
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Applied changes, newest last: [{ files: [{ path, previous, written }] }] for /undo. */
const undoStack = [];

// ---------------------------------------------------------------------------
// Styling — Electric Lime (#D1FE17) accent
// ---------------------------------------------------------------------------

const out = ARGS.print ? process.stderr : process.stdout; // with -p, stdout carries only the answer
const useColor = Boolean(out.isTTY) && !process.env.NO_COLOR;
const trueColor = /truecolor|24bit/i.test(process.env.COLORTERM || '');
const sgr = (open, close = '0') => (text) => (useColor ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
const fg = (r, g, b, ansi256) => sgr(trueColor ? `38;2;${r};${g};${b}` : `38;5;${ansi256}`, '39');
const bg = (r, g, b, ansi256) => sgr(trueColor ? `48;2;${r};${g};${b}` : `48;5;${ansi256}`, '49');
const onColor = (r, g, b, ansi256) => (text) => bg(r, g, b, ansi256)(sgr('30', '39')(text));

const c = {
  bold: sgr('1', '22'),
  dim: sgr('2', '22'),
  accent: fg(209, 254, 23, 190), // Electric Lime #D1FE17
  code: fg(222, 255, 120, 191),
  red: fg(240, 110, 110, 203),
  green: fg(209, 254, 23, 190),
  yellow: fg(230, 200, 90, 179),
  addBg: bg(40, 50, 0, 58),
  delBg: bg(66, 26, 26, 52),
  tagNew: onColor(209, 254, 23, 190),
  tagEdit: onColor(230, 200, 90, 179),
};

const visible = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, '');
const width = () => Math.max(40, Math.min(out.columns || 80, 120));
const write = (text = '') => out.write(`${text}\n`);
const info = (text) => write(c.dim(`  ${text}`));
const warn = (text) => write(c.yellow(`  ! ${text}`));
const fail = (text) => write(c.red(`  ✗ ${text}`));

// ---------------------------------------------------------------------------
// Markdown → terminal (headings, lists, code blocks, `code`, **bold**)
// ---------------------------------------------------------------------------

function styleInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, code) => c.code(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => c.bold(bold));
}

/** Word-wrap one paragraph; `code spans` and **bold spans** are never split. */
function wrap(text, max) {
  const words = [];
  for (const piece of text.split(' ')) {
    const last = words[words.length - 1];
    const open = last !== undefined && ((last.split('`').length - 1) % 2 === 1 || (last.split('**').length - 1) % 2 === 1);
    if (open) words[words.length - 1] = `${last} ${piece}`;
    else words.push(piece);
  }
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Render markdown with a fixed left indent. */
function renderMarkdown(markdown, indent) {
  const max = width() - indent.length - 2;
  const lines = core.stripControl(markdown).replace(/\r/g, '').split('\n');
  const result = [];
  let inCode = false;
  let blank = false;

  for (const line of lines) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      inCode = !inCode;
      if (inCode) result.push(indent + c.dim(`┌${fence[1].trim() ? ` ${fence[1].trim()}` : ''}`));
      else result.push(indent + c.dim('└'));
      blank = false;
      continue;
    }
    if (inCode) {
      result.push(`${indent}${c.dim('│')} ${c.code(line)}`);
      continue;
    }
    if (!line.trim()) {
      if (!blank && result.length) result.push('');
      blank = true;
      continue;
    }
    blank = false;

    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      result.push(indent + c.bold(c.accent(styleInline(heading[1]))));
      continue;
    }
    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const pad = '  '.repeat(Math.min(3, Math.floor(bullet[1].length / 2)));
      const marker = /\d/.test(bullet[2]) ? `${bullet[2]} ` : '• ';
      wrap(bullet[3], max - pad.length - marker.length).forEach((part, i) => {
        const lead = i === 0 ? c.accent(marker) : ' '.repeat(marker.length);
        result.push(indent + pad + lead + styleInline(part));
      });
      continue;
    }
    for (const part of wrap(line.trim(), max)) result.push(indent + styleInline(part));
  }
  while (result.length && result[result.length - 1] === '') result.pop();
  return result;
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

let spinnerStop = null;

function startSpinner(label) {
  stopSpinner();
  if (!out.isTTY) return;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const started = Date.now();
  let i = 0;
  const draw = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    out.write(`\r\x1b[2K  ${c.accent(frames[i++ % frames.length])} ${label} ${c.dim(`${seconds}s · ctrl+c to stop`)}`);
  };
  draw();
  const timer = setInterval(draw, 90);
  spinnerStop = () => {
    clearInterval(timer);
    out.write('\r\x1b[2K');
  };
}

function stopSpinner() {
  if (spinnerStop) {
    spinnerStop();
    spinnerStop = null;
  }
}

// ---------------------------------------------------------------------------
// Line input
//
// Lines go through a small queue instead of rl.question(), so the client
// behaves the same with a keyboard and with piped input. On a real terminal,
// anything typed *before* a question appears is discarded — a stray "y" typed
// while waiting must never approve a write or a command.
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const isTTY = Boolean(process.stdin.isTTY);
const bufferedLines = [];
let lineWaiter = null;
let inputClosed = false;
let inflight = null; // AbortController of the request in progress

rl.on('line', (line) => {
  if (lineWaiter) {
    const resolve = lineWaiter;
    lineWaiter = null;
    resolve(line);
  } else {
    bufferedLines.push(line);
  }
});

rl.on('close', () => {
  inputClosed = true;
  if (lineWaiter) {
    const resolve = lineWaiter;
    lineWaiter = null;
    resolve(null);
  }
});

rl.on('SIGINT', () => {
  if (inflight) {
    inflight.abort();
    return;
  }
  write();
  rl.close();
});

function ask(question) {
  if (isTTY) bufferedLines.length = 0;
  if (bufferedLines.length > 0) {
    process.stdout.write(`${question}\n`);
    return Promise.resolve(bufferedLines.shift());
  }
  if (inputClosed) return Promise.resolve(null);
  return new Promise((resolve) => {
    lineWaiter = resolve;
    rl.setPrompt(question);
    rl.prompt();
  });
}

/** Ask until one of `keys` is typed. End of input counts as the last key ("no"). */
async function choose(question, keys) {
  const words = { y: 'yes', n: 'no', d: 'diff' };
  for (;;) {
    const answer = await ask(`  ${question} ${c.accent('›')} `);
    if (answer === null) return keys[keys.length - 1];
    const key = answer.trim().toLowerCase();
    const hit = keys.find((k) => key === k || key === words[k]);
    if (hit) return hit;
    warn(`Type ${keys.join(', ')}.`);
  }
}

// ---------------------------------------------------------------------------
// Configuration (.bridge.json)
// ---------------------------------------------------------------------------

async function loadConfig() {
  let fileConfig = {};
  let source = null;
  for (const candidate of CONFIG_PATHS) {
    if (!fs.existsSync(candidate)) continue;
    try {
      fileConfig = JSON.parse(fs.readFileSync(candidate, 'utf8')) || {};
      source = candidate;
      break;
    } catch (err) {
      warn(`Ignoring unreadable config ${candidate}: ${err.message}`);
    }
  }

  // Environment variables override the file.
  const fromEnv = process.env.ACCESS_CODE || '';
  const fromFile = fileConfig.ACCESS_CODE || '';
  let url = ARGS.setup ? null : core.normalizeUrl(process.env.BRIDGE_URL || fileConfig.BRIDGE_URL || '');
  let code = ARGS.setup ? '' : String(fromEnv || fromFile).trim();

  // Commands you approve later must not inherit the secret.
  delete process.env.ACCESS_CODE;

  if (!url || !code) {
    if (ARGS.print) {
      fail('No bridge configured yet. Run `claude-bridge --setup` once, then try again.');
      process.exit(1);
    }
    write();
    write(`  ${c.accent('◆')} ${c.bold(ARGS.setup ? 'Bridge setup' : 'Welcome to Claude Bridge')}`);
    info('You need two things from the host: the link and the access code.');
    write();
    while (!url) {
      const answer = await ask(`  ${c.bold('Link')} ${c.dim('(https://….trycloudflare.com)')} ${c.accent('›')} `);
      if (answer === null) process.exit(1);
      url = core.normalizeUrl(answer);
      if (!url) warn('Enter the full link, starting with https:// or http://');
    }
    while (!code) {
      const answer = await ask(`  ${c.bold('Access code')} ${c.accent('›')} `);
      if (answer === null) process.exit(1);
      code = answer.trim();
    }
    const target = CONFIG_PATHS[1]; // home directory: never ends up in a project repo
    fs.writeFileSync(target, `${JSON.stringify({ BRIDGE_URL: url, ACCESS_CODE: code }, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* best effort (e.g. Windows) */
    }
    info(`Saved to ${target}`);
    if (source && source !== target) warn(`${source} also exists and takes priority in this project.`);
  }
  return { url, code };
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function box(lines) {
  const inner = Math.min(width() - 4, 64);
  const body = lines.map((line) => {
    const pad = Math.max(0, inner - 2 - visible(line).length);
    return `${c.accent('│')} ${line}${' '.repeat(pad)} ${c.accent('│')}`;
  });
  return [c.accent(`╭${'─'.repeat(inner)}╮`), ...body, c.accent(`╰${'─'.repeat(inner)}╯`)].map((l) => `  ${l}`).join('\n');
}

function shortHost(url) {
  const host = new URL(url).host;
  return host.length > 44 ? `${host.slice(0, 41)}…` : host;
}

function printHeader(connection, fileCount, status) {
  const label = (text) => c.dim(text.padEnd(9));
  const inner = Math.min(width() - 4, 64);
  const title = `${c.accent('◆')} ${c.bold('Claude Bridge')}`;
  const versionText = c.dim(`v${VERSION}`);
  const gap = Math.max(1, inner - 2 - visible(title).length - visible(versionText).length);
  write();
  write(
    box([
      `${title}${' '.repeat(gap)}${versionText}`,
      '',
      `${label('project')}${path.basename(ROOT)} ${c.dim(`· ${fileCount} files`)}`,
      `${label('host')}${shortHost(connection.url)}`,
      `${label('status')}${status}`,
      `${label('mode')}${MODE_LABELS[prefs.mode]} ${c.dim(`· model ${prefs.model || 'host default'} · /skills`)}`,
    ])
  );
  write(c.dim('   Ask anything about this project — Claude reads the files it needs.'));
  write(c.dim('   /help commands · @path point at a file · ctrl+c stop · ctrl+d quit'));
}

function printHelp() {
  const row = (cmd, text) => write(`  ${c.accent(cmd.padEnd(16))}${text}`);
  write();
  write(`  ${c.bold('Commands')}`);
  row('/context', 'files Claude currently has in view');
  row('/drop <path>', 'take a file or folder out of view');
  row('/clear', 'start a new conversation');
  row('/plan', 'plan mode: Claude plans, nothing changes until you approve');
  row('/auto', 'auto-accept edits (commands still ask; /undo reverts)');
  row('/ask', 'ask before every edit (default)');
  row('/model [name]', 'show or pick the model');
  row('/effort [level]', 'show or set the effort: low, medium, high, xhigh, max');
  row('/undo', 'undo the last applied changes');
  row('/skills [name|off]', 'pick skills (several at once) Claude should follow');
  row('/compact', 'summarize the conversation to free up room');
  row('/status', 'check the connection to the host');
  row('/help', 'show this help');
  row('/exit', 'quit (or ctrl+d)');
  write();
  write(`  ${c.bold('Tips')}`);
  write('  Claude explores the project by itself: it sees the file list, reads files and');
  write('  searches. Mention a file with @path to make sure it is included, e.g. @src/app.js');
  write(c.dim('  Never read: .env and other secrets, .git, node_modules, binaries, files over 200 KB.'));
}

// ---------------------------------------------------------------------------
// Rendering a turn
// ---------------------------------------------------------------------------

function onEvent(event) {
  const step = (label, text, extra = '') => write(`    ${c.dim('↳')} ${label} ${text}${extra ? ` ${c.dim(extra)}` : ''}`);
  switch (event.type) {
    case 'mentions':
      stopSpinner();
      for (const rel of event.added) step(c.dim('added '), rel);
      for (const s of event.skipped) step(c.yellow('skip  '), s.path, `— ${s.reason}`);
      for (const token of event.missing) step(c.yellow('none  '), `@${core.stripControl(token)}`, '— no such file');
      break;
    case 'thinking':
      startSpinner(event.round === 1 ? 'Thinking…' : `Thinking… ${c.dim(`(step ${event.round})`)}`);
      break;
    case 'queue':
      if (event.state === 'queued' && event.ahead > 0) {
        startSpinner(`Waiting for the host… ${c.dim(`${event.ahead} request${event.ahead === 1 ? '' : 's'} ahead of you`)}`);
      } else {
        startSpinner('Thinking…');
      }
      break;
    case 'plan':
      stopSpinner();
      write(`  ${c.accent('●')} ${core.stripControl(event.text).split('\n')[0].slice(0, width() - 6)}`);
      break;
    case 'read':
      stopSpinner();
      if (event.error) step(c.yellow('read  '), event.path, `— ${event.error}`);
      else step(c.dim('read  '), event.path, `· ${event.lines} line${event.lines === 1 ? '' : 's'}`);
      break;
    case 'search':
      stopSpinner();
      step(c.dim('search'), `"${core.stripControl(event.query)}"`, `· ${event.count}${event.truncated ? '+' : ''} matches`);
      break;
    default:
      break;
  }
}

function printDiffLine(line) {
  const no = String((line.type === '-' ? line.oldNo : line.newNo) || '').padStart(4);
  const text = core.stripControl(line.text).replace(/\t/g, '  ');
  const room = width() - 16;
  const clipped = text.length > room ? `${text.slice(0, room - 1)}…` : text;
  const gutter = `    ${c.accent('│')} ${c.dim(no)} `;
  if (line.type === '+') write(gutter + c.addBg(c.green(`+ ${clipped}`)));
  else if (line.type === '-') write(gutter + c.delBg(c.red(`- ${clipped}`)));
  else write(gutter + c.dim(`  ${clipped}`));
}

/** Show one planned file update; returns how many diff lines were left out. */
function printFilePlan(item, full) {
  if (item.status === 'blocked') {
    write(`    ${c.red('✗')} ${item.path}  ${c.red(`blocked: ${item.error}`)}`);
    return 0;
  }
  if (item.status === 'unchanged') {
    write(`    ${c.dim(`· ${item.path}  unchanged`)}`);
    return 0;
  }
  const label = item.status === 'new' ? c.tagNew(' NEW ') : c.tagEdit(' EDIT ');
  write(`    ${c.accent('╭─')} ${label} ${c.bold(item.path)}  ${c.green(`+${item.added}`)} ${c.red(`−${item.removed}`)}`);

  const diff = core.diffLines(item.previous || '', item.content);
  const lines = full ? diff.lines : core.diffHunks(diff, 2).flatMap((h, i) => (i ? [{ type: 'gap' }, ...h.lines] : h.lines));
  const limit = full ? Infinity : DIFF_PREVIEW_LINES;
  let shown = 0;
  let hidden = 0;
  for (const line of lines) {
    if (line.type === 'gap') {
      if (shown < limit) write(`    ${c.accent('│')} ${c.dim('   ⋯')}`);
    } else if (shown < limit) {
      printDiffLine(line);
      shown++;
    } else {
      hidden++;
    }
  }
  write(`    ${c.accent('╰─')}${hidden ? c.dim(` ${hidden} more lines · type d to see everything`) : ''}`);
  return hidden;
}

/** Show proposed file changes, ask, write. Returns a report line for Claude. */
async function reviewFileUpdates(session, updates) {
  const plan = session.project.planUpdates(updates);
  const writable = plan.filter((item) => item.status === 'new' || item.status === 'modified');
  const added = writable.reduce((n, i) => n + i.added, 0);
  const removed = writable.reduce((n, i) => n + i.removed, 0);

  write();
  write(`  ${c.accent('●')} ${c.bold('Proposed changes')} ${c.dim(`· ${writable.length} file${writable.length === 1 ? '' : 's'}`)}  ${c.green(`+${added}`)} ${c.red(`−${removed}`)}`);
  let anyHidden = false;
  for (const item of plan) anyHidden = printFilePlan(item, false) > 0 || anyHidden;

  if (writable.length === 0) {
    info('Nothing to write.');
    return 'File updates were proposed but none could be applied.';
  }

  for (;;) {
    if (prefs.mode === 'auto') {
      info('Auto-accept is on: applying. Type /undo to revert.');
      break;
    }
    const keys = anyHidden ? ['y', 'd', 'n'] : ['y', 'n'];
    const hint = `${c.accent('y')} apply   ${anyHidden ? `${c.accent('d')} full diff   ` : ''}${c.accent('n')} discard`;
    const answer = await choose(`${c.bold('Apply these changes?')}  ${c.dim(hint)}`, keys);
    if (answer === 'd') {
      for (const item of writable) printFilePlan(item, true);
      anyHidden = false;
      continue;
    }
    if (answer === 'n') {
      info('Changes discarded.');
      return `The user DECLINED the proposed changes to: ${writable.map((i) => i.path).join(', ')}. The files on disk are unchanged.`;
    }
    break;
  }

  const written = [];
  const undoFiles = [];
  for (const item of writable) {
    const result = session.project.writeFile(item.path, item.content);
    if (result.ok) {
      written.push(result.path);
      undoFiles.push({ path: result.path, previous: result.previous, written: item.content });
      session.addToView(result.path);
      write(`    ${c.green('✓')} ${result.path}`);
    } else {
      fail(`${item.path}: ${result.error}`);
    }
  }
  if (undoFiles.length) undoStack.push({ files: undoFiles });
  return written.length ? `The user APPLIED the changes to: ${written.join(', ')}.` : 'Writing the proposed changes failed.';
}

/** Run one approved command with the terminal handed over to it. */
async function runInTerminal(command) {
  // Stop readline and leave raw mode so Ctrl+C reaches the command as a normal SIGINT.
  if (!inputClosed) rl.pause();
  if (isTTY && !inputClosed) process.stdin.setRawMode(false);
  const ignoreSigint = () => {};
  process.on('SIGINT', ignoreSigint);

  let atLineStart = true;
  const prefix = `    ${c.dim('│')} `;
  const result = await core.runCommand(command, {
    cwd: ROOT,
    stdin: 'inherit',
    onOutput: (text) => {
      let chunk = '';
      for (const ch of text) {
        if (atLineStart && ch !== '\n') {
          chunk += prefix;
          atLineStart = false;
        }
        chunk += ch;
        if (ch === '\n') atLineStart = true;
      }
      process.stdout.write(chunk);
    },
  });
  if (!atLineStart) process.stdout.write('\n');

  process.removeListener('SIGINT', ignoreSigint);
  if (isTTY && !inputClosed) process.stdin.setRawMode(true);
  if (!inputClosed) rl.resume();
  return result;
}

/** Offer each proposed command; returns report lines for Claude. */
async function reviewCommands(commands) {
  const reports = [];
  for (const command of commands) {
    const shown = core.stripControl(command);
    write();
    write(`  ${c.accent('●')} ${c.bold('Run a command')}`);
    write(`    ${c.accent('$')} ${c.code(shown)}`);
    if (shown !== command) {
      fail('Refusing to run: the command contains hidden control characters.');
      reports.push(`Command \`${shown}\` was blocked by the client (control characters).`);
      continue;
    }
    const answer = await choose(`${c.bold('Run it here?')}  ${c.dim(`${c.accent('y')} run   ${c.accent('n')} skip`)}`, ['y', 'n']);
    if (answer === 'n') {
      reports.push(`The user chose NOT to run \`${command}\`.`);
      continue;
    }
    const result = await runInTerminal(command);
    const status = core.describeCommandResult(result);
    write(result.code === 0 ? `    ${c.green(`✓ ${status}`)}` : `    ${c.red(`✗ ${status}`)}`);
    const tail = core.stripControl(result.tail).trim();
    reports.push(`The user ran \`${command}\` → ${status}.${tail ? `\nOutput (tail):\n${tail}` : ''}`);
  }
  return reports;
}

function printTodos(todos) {
  if (!todos || !todos.length) return;
  const done = todos.filter((t) => t.status === 'completed').length;
  write();
  write(`  ${c.accent('●')} ${c.bold('Tasks')} ${c.dim(`${done}/${todos.length}`)}`);
  for (const t of todos) {
    const box = t.status === 'completed' ? c.green('✔') : t.status === 'in_progress' ? c.accent('▸') : c.dim('○');
    const text = t.status === 'completed' ? c.dim(t.content) : t.status === 'in_progress' ? c.bold(t.content) : t.content;
    write(`    ${box} ${text}`);
  }
}

function usageLine(response) {
  const u = response.usage;
  if (!u || !u.durationMs) return '';
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const model = (u.model || '').replace(/^claude-/, '');
  return [model, response.rounds > 1 ? `${response.rounds} steps` : '', `${(u.durationMs / 1000).toFixed(1)}s`, `${k(u.inputTokens)} in · ${k(u.outputTokens)} out`]
    .filter(Boolean)
    .join(' · ');
}

/** Save the link and access code to ~/.bridge.json (owner-only). */
function saveConnection(url, code) {
  const target = CONFIG_PATHS[1];
  fs.writeFileSync(target, `${JSON.stringify({ BRIDGE_URL: url, ACCESS_CODE: code }, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
  if (fs.existsSync(CONFIG_PATHS[0])) warn(`${CONFIG_PATHS[0]} also exists and takes priority in this project — update or delete it.`);
  return target;
}

/**
 * The link or access code stopped working: ask for new ones, test them, save them,
 * and switch the session over. Returns true when connected again.
 */
async function reconnect(session, err) {
  write();
  warn(err.message);
  const go = await choose(`${c.bold(err.kind === 'code' ? 'Enter the access code again now?' : 'Enter the new link and access code now?')}  ${c.dim(`${c.accent('y')} yes   ${c.accent('n')} no`)}`, ['y', 'n']);
  if (go !== 'y') {
    info('Run `claude-bridge --setup` later to change them.');
    return false;
  }
  let url = session.connection.url;
  for (;;) {
    if (err.kind !== 'code') {
      const answer = await ask(`  ${c.bold('Link')} ${c.dim(`(Enter keeps ${url})`)} ${c.accent('›')} `);
      if (answer === null) return false;
      if (answer.trim()) {
        const next = core.normalizeUrl(answer);
        if (!next) {
          warn('Enter the full link, starting with https:// or http://');
          continue;
        }
        url = next;
      }
    }
    const codeAnswer = await ask(`  ${c.bold('Access code')} ${c.dim(err.kind === 'code' ? '' : '(Enter keeps the current one)')} ${c.accent('›')} `);
    if (codeAnswer === null) return false;
    const code = codeAnswer.trim() || session.accessCode;
    if (!code) continue;
    let connection;
    try {
      connection = new core.Connection({ url, accessCode: code });
      startSpinner('Checking…');
      const health = await connection.health();
      stopSpinner();
      if (Array.isArray(health.models)) prefs.models = health.models.filter((m) => typeof m === 'string');
    } catch (e) {
      stopSpinner();
      fail(e.message);
      err = e;
      const again = await choose(`${c.bold('Try again?')}  ${c.dim(`${c.accent('y')} yes   ${c.accent('n')} no`)}`, ['y', 'n']);
      if (again !== 'y') return false;
      continue;
    }
    session.connection = connection;
    session.accessCode = code;
    info(`Connected · saved to ${saveConnection(url, code)}`);
    return true;
  }
}

async function handleMessage(session, text, { mode } = {}) {
  const controller = new AbortController();
  inflight = controller;
  const effectiveMode = mode || prefs.mode;
  let response;
  write();
  try {
    response = await session.send(text, {
      onEvent,
      signal: controller.signal,
      model: prefs.model,
      effort: prefs.effort,
      mode: effectiveMode === 'plan' ? 'plan' : effectiveMode === 'compact' ? 'compact' : 'default',
      skills: prefs.activeSkills.map((id) => prefs.skills.find((k) => k.id === id)).filter(Boolean),
    });
  } catch (err) {
    stopSpinner();
    inflight = null;
    if (controller.signal.aborted) info('Stopped.');
    else if (core.needsReconnect(err) && !ARGS.print) {
      if (await reconnect(session, err)) {
        const again = await choose(`${c.bold('Send your message again?')}  ${c.dim(`${c.accent('y')} yes   ${c.accent('n')} no`)}`, ['y', 'n']);
        if (again === 'y') await handleMessage(session, text, { mode });
      }
    } else fail(core.describeError(err, session.connection.url));
    return;
  } finally {
    stopSpinner();
    inflight = null;
  }

  const body = renderMarkdown(response.explanation.trim() || '(no answer)', '    ');
  write();
  if (effectiveMode === 'compact') write(`  ${c.accent('●')} ${c.bold('Conversation compacted.')} ${c.dim('Claude continues from this summary:')}`);
  body.forEach((line, i) => write(i === 0 && effectiveMode !== 'compact' ? `  ${c.accent('●')} ${line.slice(4)}` : line));
  const usage = usageLine(response);
  if (usage) write(c.dim(`    ${usage}`));
  if (effectiveMode !== 'compact') printTodos(response.todos);

  if (response.questions && response.questions.length) {
    const answers = await askQuestions(response.questions);
    if (answers === null) return;
    await handleMessage(session, answers);
    return;
  }

  if (effectiveMode === 'plan') {
    write();
    const answer = await choose(
      `${c.bold('Ready to code?')}  ${c.dim(`${c.accent('y')} yes, ask before edits   ${c.accent('a')} yes, auto-accept   ${c.accent('n')} keep planning`)}`,
      ['y', 'a', 'n']
    );
    if (answer === 'n') return;
    prefs.mode = answer === 'a' ? 'auto' : 'default';
    info(`Mode: ${MODE_LABELS[prefs.mode]}.`);
    await handleMessage(session, 'The plan is approved. Go ahead and implement it.');
    return;
  }

  if (response.fileUpdates.length) session.report(await reviewFileUpdates(session, response.fileUpdates));
  if (response.commands.length) for (const line of await reviewCommands(response.commands)) session.report(line);
}

/** Ask Claude's questions one by one. Returns the follow-up message, or null when input ended. */
async function askQuestions(questions) {
  write();
  write(`  ${c.accent('?')} ${c.bold(questions.length === 1 ? 'Claude has a question' : `Claude has ${questions.length} questions`)}`);
  const answers = [];
  for (const q of questions) {
    write();
    write(`    ${q.header ? `${c.tagNew(` ${q.header} `)} ` : ''}${c.bold(q.question)}`);
    q.options.forEach((o, i) => {
      write(`      ${c.accent(`${i + 1}.`)} ${o.label}${o.description ? c.dim(` — ${o.description}`) : ''}`);
    });
    const hint = q.multiSelect ? 'numbers separated by commas (e.g. 1,3)' : 'a number';
    for (;;) {
      const line = await ask(`    ${c.dim(`Answer with ${hint}, or type your own · s to skip`)} ${c.accent('›')} `);
      if (line === null) return null;
      const text = line.trim();
      if (!text) continue;
      if (text.toLowerCase() === 's') {
        answers.push({ selected: [], other: '' });
        break;
      }
      if (/^\d+(\s*,\s*\d+)*$/.test(text)) {
        const picks = [...new Set(text.split(',').map((n) => Number(n.trim())))];
        if (picks.some((n) => n < 1 || n > q.options.length)) {
          warn(`Pick between 1 and ${q.options.length}.`);
          continue;
        }
        if (!q.multiSelect && picks.length > 1) {
          warn('This question takes one answer.');
          continue;
        }
        answers.push({ selected: picks.map((n) => q.options[n - 1].label), other: '' });
        break;
      }
      answers.push({ selected: [], other: text });
      break;
    }
  }
  return core.formatAnswers(questions, answers);
}

/** /skills: show every skill; toggle several by number. */
async function chooseSkills(arg) {
  prefs.skills = core.loadSkills(ROOT);
  const known = new Set(prefs.skills.map((k) => k.id));
  prefs.activeSkills = prefs.activeSkills.filter((id) => known.has(id));
  if (arg === 'off' || arg === 'clear') {
    prefs.activeSkills = [];
    info('All skills off.');
    return;
  }
  if (arg) {
    const skill = prefs.skills.find((k) => k.name.toLowerCase() === arg.toLowerCase());
    if (!skill) return warn(`No skill named "${arg}". Type /skills to see them.`);
    toggleSkill(skill.id);
    return;
  }
  for (;;) {
    write();
    write(`  ${c.bold('Skills')} ${c.dim(`· ${prefs.activeSkills.length} on · built-in, ~/.claude/skills and .claude/skills in this project`)}`);
    prefs.skills.forEach((k, i) => {
      const on = prefs.activeSkills.includes(k.id);
      write(`    ${c.accent(String(i + 1).padStart(2))}. ${on ? c.green('[x]') : c.dim('[ ]')} ${on ? c.bold(k.name) : k.name} ${c.dim(`(${k.source})${k.description ? ` ${k.description}` : ''}`)}`);
    });
    const line = await ask(`  ${c.dim('Numbers to toggle (e.g. 1,4) · Enter when done')} ${c.accent('›')} `);
    if (line === null || !line.trim()) break;
    const nums = line.split(',').map((n) => Number(n.trim()));
    if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > prefs.skills.length)) {
      warn(`Use numbers between 1 and ${prefs.skills.length}.`);
      continue;
    }
    for (const n of nums) toggleSkill(prefs.skills[n - 1].id, true);
  }
  const names = prefs.activeSkills.map((id) => prefs.skills.find((k) => k.id === id).name);
  info(names.length ? `Skills on: ${names.join(', ')}` : 'No skills on.');
}

function toggleSkill(id, quiet = false) {
  const skill = prefs.skills.find((k) => k.id === id);
  if (prefs.activeSkills.includes(id)) prefs.activeSkills = prefs.activeSkills.filter((x) => x !== id);
  else if (prefs.activeSkills.length >= 8) return warn('At most 8 skills can be on at once.');
  else prefs.activeSkills.push(id);
  if (!quiet) info(`${skill.name}: ${prefs.activeSkills.includes(id) ? 'on' : 'off'}.`);
}

/** Undo the most recent applied changes (asks before overwriting later edits). */
async function undoLast(session) {
  const batch = undoStack.pop();
  if (!batch) {
    info('Nothing to undo.');
    return;
  }
  const undone = [];
  for (const file of batch.files) {
    let result = session.project.revertWrite(file.path, file.previous, file.written);
    if (!result.ok && result.conflict) {
      const answer = await choose(`${c.bold(`${file.path} changed after Claude's edit. Undo anyway?`)}  ${c.dim(`${c.accent('y')} yes   ${c.accent('n')} no`)}`, ['y', 'n']);
      if (answer === 'y') result = session.project.revertWrite(file.path, file.previous, file.written, { force: true });
    }
    if (result.ok) {
      undone.push(file.path);
      write(`    ${c.green('↶')} ${file.path}`);
    } else if (!result.conflict) fail(`${file.path}: ${result.error}`);
  }
  if (undone.length) session.report(`The user UNDID your changes to: ${undone.join(', ')}. Those files are back to how they were before.`);
}

/** -p mode: one question, one answer, nothing written or run. */
async function printOnce(session, text) {
  try {
    const response = await session.send(text, { onEvent });
    stopSpinner();
    process.stdout.write(`${core.stripControl(response.explanation).trim()}\n`);
    if (response.fileUpdates.length) {
      process.stdout.write('\nProposed file changes (not applied in -p mode):\n');
      for (const u of response.fileUpdates) process.stdout.write(`  ${core.stripControl(u.path)}\n`);
    }
    if (response.commands.length) {
      process.stdout.write('\nSuggested commands (not run in -p mode):\n');
      for (const cmd of response.commands) process.stdout.write(`  $ ${core.stripControl(cmd)}\n`);
    }
    return true;
  } catch (err) {
    stopSpinner();
    fail(core.describeError(err, session.connection.url));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function showContext(session) {
  write();
  if (session.workingSet.length === 0) {
    info('No files in view yet. Claude picks them up as it explores.');
    return;
  }
  write(`  ${c.bold('In view')} ${c.dim(`(${session.workingSet.length} files, re-read from disk on every message)`)}`);
  for (const rel of session.workingSet) write(`    ${c.accent('·')} ${rel}`);
}

async function showStatus(session) {
  try {
    const health = await session.connection.health();
    if (Array.isArray(health.models)) prefs.models = health.models;
    write(`  ${c.accent('●')} connected · encrypted ${c.dim(health.busy ? `· host busy, ${health.queued} waiting` : '· host idle')}`);
  } catch (err) {
    fail(err.message);
  }
}

/** Returns true when the session should end. */
async function handleSlash(session, line) {
  const [name, ...rest] = line.split(/\s+/);
  switch (name.toLowerCase()) {
    case '/exit':
    case '/quit':
      return true;
    case '/context':
    case '/files':
      showContext(session);
      break;
    case '/drop': {
      const arg = rest.join(' ').trim().replace(/^@/, '');
      if (!arg) warn('Usage: /drop <path>');
      else {
        const n = session.removeFromView(arg);
        if (n) info(`Took ${n} file(s) out of view.`);
        else warn(`Nothing in view matches "${arg}".`);
      }
      break;
    }
    case '/clear':
    case '/new':
      session.clear();
      info('New conversation started.');
      break;
    case '/plan':
    case '/auto':
    case '/ask':
      prefs.mode = { '/plan': 'plan', '/auto': 'auto', '/ask': 'default' }[name.toLowerCase()];
      info(`Mode: ${MODE_LABELS[prefs.mode]}.`);
      break;
    case '/model': {
      const arg = rest.join(' ').trim();
      if (!arg) {
        write(`  ${c.bold('Model')} ${prefs.model || 'host default'} ${c.dim(`· available: ${prefs.models.join(', ') || 'unknown (run /status)'} · "default" resets`)}`);
      } else if (arg === 'default') {
        prefs.model = '';
        info('Model: host default.');
      } else if (prefs.models.includes(arg)) {
        prefs.model = arg;
        info(`Model: ${arg}.`);
      } else warn(`The host allows: ${prefs.models.join(', ') || '(unknown — run /status)'}.`);
      break;
    }
    case '/effort': {
      const arg = rest.join(' ').trim().toLowerCase();
      if (!arg) write(`  ${c.bold('Effort')} ${prefs.effort || 'default'} ${c.dim(`· ${EFFORT_LEVELS.join(', ')}, default`)}`);
      else if (arg === 'default') {
        prefs.effort = '';
        info('Effort: default.');
      } else if (EFFORT_LEVELS.includes(arg)) {
        prefs.effort = arg;
        info(`Effort: ${arg}.`);
      } else warn(`Effort must be one of: ${EFFORT_LEVELS.join(', ')}, default.`);
      break;
    }
    case '/undo':
      await undoLast(session);
      break;
    case '/skills':
      await chooseSkills(rest.join(' ').trim());
      break;
    case '/compact':
      if (!session.history.length) info('Nothing to compact yet.');
      else await handleMessage(session, 'Summarize our conversation so far.', { mode: 'compact' });
      break;
    case '/status':
      await showStatus(session);
      break;
    case '/help':
      printHelp();
      break;
    default:
      warn(`Unknown command ${name}. Try /help.`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (typeof fetch !== 'function') {
    console.error('This client needs Node.js 18 or newer (built-in fetch).');
    process.exit(1);
  }

  const config = await loadConfig();
  const connection = new core.Connection({ url: config.url, accessCode: config.code });
  const project = new core.Project(ROOT);
  const session = new core.Session({ connection, project });
  session.accessCode = config.code; // kept so "Enter keeps the current one" works when reconnecting
  prefs.skills = core.loadSkills(ROOT);

  if (ARGS.print) {
    const ok = await printOnce(session, ARGS.prompt);
    rl.close();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const fileCount = project.scanTree().paths.length;
  let problem = null;
  try {
    const health = await connection.health();
    if (Array.isArray(health.models)) prefs.models = health.models.filter((m) => typeof m === 'string');
  } catch (err) {
    problem = err;
  }
  printHeader(connection, fileCount, problem ? c.red('● not connected') : `${c.accent('●')} connected ${c.dim('· encrypted')}`);
  if (problem) {
    if (core.needsReconnect(problem)) await reconnect(session, problem);
    else {
      fail(problem.message);
      info('Keep typing to retry, or run `claude-bridge --setup` to change the link and access code.');
    }
  }

  if (ARGS.prompt) {
    write();
    write(`  ${c.accent('❯')} ${ARGS.prompt}`);
    await handleMessage(session, ARGS.prompt);
  }

  for (;;) {
    write();
    write(c.dim(`  ${'─'.repeat(width() - 4)}`));
    const line = await ask(`  ${c.accent('❯')} `);
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    if (/^\/[a-z]+(\s|$)/i.test(text)) {
      if (await handleSlash(session, text)) break;
      continue;
    }
    await handleMessage(session, text);
  }

  rl.close();
  write();
  info('Bye.');
}

main().catch((err) => {
  stopSpinner();
  console.error(c.red(`Fatal: ${err && err.stack ? err.stack : err}`));
  process.exit(1);
});
