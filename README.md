# claude-remote-bridge

Let someone else chat with the Claude Code installed on your machine, from their own computer or phone, without giving them access to your machine.

| Part | Runs on | What it does |
| --- | --- | --- |
| `server.js` | The host: the machine logged in to Claude Code | Prints a link and an access code, then runs one `claude -p` per request |
| VS Code extension (`vscode-extension/`) | The guest's VS Code | Chat panel: Claude explores the workspace, the guest reviews diffs and approves commands |
| `claude-bridge` (npm package: `client.js` + `bridge-core.js`) | The guest's terminal | The same chat in a terminal |

Nothing here needs `npm install`: every part uses only what ships with Node.js and VS Code.

## How it works

1. The host runs `node server.js --share`. It prints two things: a **link** and an **access code**.
2. The guest enters both, once, in VS Code or in the terminal client. Neither one works without the other.
3. The guest asks something about the project open on their machine.
4. The client sends the message, the project's file list and the files already in view, encrypted with a key made from the access code. The access code itself is never sent.
5. The host decrypts the request and runs `claude -p` once. Claude has no tools, no MCP servers, no settings and no hooks, and runs in an empty temporary directory, so it works as a text generator only.
6. Claude answers in one of two ways:
   - **Explore:** it names files to read (`readFiles`) and text to search for (`searches`). The guest's client reads them from the guest's disk, automatically, and asks again. This repeats up to 6 times per message.
   - **Answer:** `explanation`, `fileUpdates` (complete file contents) and `commands` (suggested shell commands).
7. The client shows proposed changes as diffs and each command separately. Nothing is written or run until the guest approves it.

The host runs one Claude request at a time. Up to 5 more can wait in the queue, and each run is stopped after 120 seconds. One guest message can take several runs while Claude explores.

## Requirements

- **Host:** Node.js 18+, Claude Code installed and logged in (`claude --version` must work), and `cloudflared` for `--share`.
- **Guest, VS Code:** VS Code 1.85 or newer and the `.vsix` file.
- **Guest, terminal:** Node.js 18+ and the `.tgz` package file.

## Host setup

### 1. Start sharing

```bash
cd claude-remote-bridge
node server.js --share
```

After a few seconds it prints:

```
──────────────────────────────────────────────────────────────────
  Your Claude bridge is live. Share BOTH of these with your guest:

    Link:         https://example-words.trycloudflare.com
    Access code:  7K2QF-9XHTM-4BWZ8-PLR3D-0CVN6
──────────────────────────────────────────────────────────────────
```

- The **access code** is created on the first start and saved in `.env`. It stays the same until you change it.
- The **link** is new every time the server starts. Send the guest the new link after a restart; they keep the same access code.
- `Ctrl+C` stops the server and the link.

If port 4000 is taken on your machine, set another one in `.env`, for example `PORT=4001`.

**Choosing the model.** Start with `--model` to set the default model for everyone, for example `node server.js --share --model opus` (or set `CLAUDE_MODEL` in `.env`). Guests can still switch, per message, to any model listed in `ALLOWED_MODELS` (default: `sonnet,opus,haiku,fable`). Set `ALLOWED_MODELS=sonnet` to allow only one.

`--share` needs `cloudflared`. Install it from <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>, or set `CLOUDFLARED_BIN` in `.env` to the full path of the binary.

To keep it running in the background (and start it after a reboot), use pm2: see [PM2.md](PM2.md). For a link that stays the same across restarts (ngrok static domain, named Cloudflare tunnel or Tailscale Funnel), set `TUNNEL` in `.env`: see [PM2.md → A link that never changes](PM2.md#a-link-that-never-changes).

### 2. Build the guest packages (once per version)

```bash
npm pack                                  # -> claude-remote-bridge-3.5.0.tgz (terminal client)
cd vscode-extension
npx @vscode/vsce package --allow-missing-repository --skip-license   # -> claude-bridge-vscode-3.5.0.vsix
```

### 3. Send the guest

- the link
- the access code (over a private channel)
- `claude-bridge-vscode-3.5.0.vsix` for VS Code, and/or `claude-remote-bridge-3.5.0.tgz` for the terminal
- `CLIENT-SETUP.md`, the guest's guide

### Changing the access code

Delete the `ACCESS_CODE=` line from `.env` and start the server again. A new code is created and printed. The old code stops working at once.

### Alternative: Tailscale instead of a public link

Run `node server.js` without `--share`. No tunnel is opened and the server listens only where `HOST` says.

Install Tailscale on the host and on each guest device, sign them in to the same tailnet, then:

```bash
tailscale ip -4                      # prints something like 100.101.102.103
echo "HOST=100.101.102.103" >> .env
node server.js
```

The guest's link is `http://100.101.102.103:4000` (use your `PORT`). The access code is in `.env`.

## Guest setup

The full guest guide is [CLIENT-SETUP.md](CLIENT-SETUP.md). In short:

**VS Code**

```bash
code --install-extension claude-bridge-vscode-3.5.0.vsix
```

Open the project folder, click the **Claude Bridge** icon in the activity bar, paste the link and the access code, and click **Connect**. The panel works on its own; the terminal client is not needed.

- Claude explores the workspace by itself. The file open in the editor (and any selection) is included automatically; `@` picks other files.
- Proposed changes appear as diff cards with **Apply** / **Discard** and a button for VS Code's diff editor. Files with unsaved editor changes are never overwritten.
- Suggested commands appear as cards with **Run** / **Skip**; output streams into the card.
- Modes: ask before edits, auto-accept edits (with Undo), plan mode (plan + task list, approve before anything changes). Shift+Tab switches.
- Model and effort picker (the host decides which models are allowed with `ALLOWED_MODELS`), per-file accept/reject, Undo, saved conversation history, `/` commands, always-allowed commands, VS Code problems and selections sent with the message, Alt+K to mention selected lines, Ctrl+Esc to focus.
- Claude can ask clarifying questions; they appear as a popup with options. Skills (built-in, `~/.claude/skills`, project `.claude/skills`) can be switched on several at a time with `/skills`.
- `+` starts a new chat; the clock shows past chats; the gear holds settings. `Ctrl+Alt+Shift+B` opens the chat in an editor tab.

**Terminal**

```bash
npm install -g ./claude-remote-bridge-3.5.0.tgz
claude-bridge --setup           # enter the link and the access code
cd your-project && claude-bridge
```

`claude-bridge "message"` starts with a first message; `claude-bridge -p "question"` prints one answer and exits without changing anything.

## Guest: phone

**Android**

1. Install Termux.
2. Run `pkg install nodejs`.
3. Copy the package file to the phone and run `npm install -g ./claude-remote-bridge-3.5.0.tgz`.
4. Run `cd your-project && claude-bridge`.

**iPhone**

There is no good option. A shell app such as iSH can run Node.js, but it is slow. The bridge has no web page or mobile app; the terminal client is the only interface.

## Using the terminal client

| Type this | Result |
| --- | --- |
| `why is the checkout total wrong?` | Claude explores the project and answers |
| `explain @src/index.js` | Makes sure that file is included |
| `/context` | Lists the files Claude has in view |
| `/drop <path>` | Takes a file or folder out of view |
| `/clear` | Starts a new conversation |
| `/status` | Checks the connection |
| `/help` | Shows the commands |
| `/exit` | Quits |
| `Ctrl+C` | Stops the request in progress, or quits when idle |

Files in view are re-read from disk on every message, so Claude always sees the current version.

Client limits: 200 KB per file, 3 MB of file contents per request, 60 files in view, 5,000 files in the project list, 6 exploration steps per message, 40 history entries.

## Configuration

### Host (`.env` next to `server.js`, or environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACCESS_CODE` | created on first start | The secret the guest needs with the link; at least 16 characters |
| `HOST` | `127.0.0.1` | Address to listen on |
| `PORT` | `4000` | Port to listen on |
| `TIMEOUT_MS` | `120000` | Longest allowed Claude run, in ms; `0` = no limit |
| `MAX_QUEUE` | `5` | Requests allowed to wait behind the running one |
| `MAX_BODY_BYTES` | `8388608` | Largest accepted request body |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `CLAUDE_MODEL` | CLI default | Default model, for example `sonnet` |
| `ALLOWED_MODELS` | `sonnet,opus,haiku,fable` | Models a guest may pick |
| `TUNNEL` | `quick` | Public link with `--share`: `quick` (new link each start), `ngrok`, `cloudflare`, `none` |
| `NGROK_DOMAIN`, `NGROK_AUTHTOKEN` | — | For `TUNNEL=ngrok` |
| `CLOUDFLARE_TUNNEL_TOKEN`, `PUBLIC_URL` | — | For `TUNNEL=cloudflare`; `PUBLIC_URL` alone for `TUNNEL=none` |
| `CLOUDFLARED_BIN` | `cloudflared` | Path to cloudflared, used by `--share` |
| `SANDBOX_DIR` | `<tmp>/claude-bridge-sandbox` | Where the throw-away run directories are created |

Server options: `--share` opens the public link, `--gen-code` prints a new random access code and exits.

### Guest, terminal (`.bridge.json` in the project folder or the home folder)

```json
{
  "BRIDGE_URL": "https://example-words.trycloudflare.com",
  "ACCESS_CODE": "the-access-code-from-the-host"
}
```

The environment variables `BRIDGE_URL` and `ACCESS_CODE` override the file. The VS Code extension keeps its own copy: the link in its settings storage, the access code in VS Code secret storage.

## Security

**How the link and access code work together**

- The link only says where the server is. Without the access code, the server answers nothing but "rejected".
- The access code is never sent over the network. Both sides turn it into an AES-256-GCM key (with scrypt), and every request and reply is encrypted with that key.
- A request that was not encrypted with the right code is rejected with `401`. So is a captured request that is sent a second time, and one whose timestamp is more than 5 minutes off.
- Prompts, files and answers cannot be read by anyone between the two machines, including the tunnel provider.

**Protecting the host**

- Claude runs with no tools in an empty directory, so a guest's prompt cannot read host files or run host commands.
- Guest input is piped to the CLI over stdin and never passes through a shell.
- Nothing about guest conversations is saved on the host.
- `.env` is set to owner-only permissions when the server starts.

**Protecting the guest**

- Claude reads files automatically, but only inside the project folder, and never `.env` files, key files, `.npmrc`, `.netrc`, `.bridge.json`, binaries, files over 200 KB, `.git` or `node_modules`. Files matched by the project's `.gitignore` are left out of the file list.
- Symlinks are never followed out of the project folder.
- File writes are limited to the project folder and need approval. VS Code never overwrites a file with unsaved editor changes.
- Each command is shown exactly as it will run and needs its own approval. Commands do not receive the access code in their environment.

**Things to know before sharing**

- Anyone with the link and the access code uses the host's Claude usage limits. If the code leaks, change it (see "Changing the access code").
- The host can read everything the guest sends, and Anthropic receives it as part of the Claude request. The encryption protects the path between the two machines, not the host itself.
- In the terminal client, the access code is stored as plain text in `~/.bridge.json`, readable only by that user. Only the VS Code extension stores it encrypted.
- Anthropic's consumer terms generally do not allow making a personal Claude account available to other people. Check the terms before sharing a subscription this way. An API key from the Claude Developer Platform, or separate seats on a Team plan, are the supported ways to give several people access.

## Troubleshooting

| Message | Likely cause |
| --- | --- |
| `Could not reach …` or `The link answered … but not from the bridge` | The server is not running, or it was restarted and the link has changed. Ask the host for the current link |
| `The host rejected the access code` | The access code is wrong. Run `claude-bridge --setup`, or **Claude Bridge: Connect** in VS Code |
| `This host only accepts encrypted requests` | The guest still has version 1 of the client. Install version 3.1.0 |
| `…the clocks differ too much` | The date or time on one of the machines is wrong by more than 5 minutes |
| `The host is busy (queue full)` | Too many requests are waiting; try again shortly |
| `Claude did not finish within 120s` | The request was too big; attach fewer files or raise `TIMEOUT_MS` |
| `Request too large` | Too many or too large attachments; use `/files` and `/drop` |
| `Claude returned an error: …` | The host's Claude Code hit a usage limit or is not logged in |
| `Port … is already used by another program` (host) | Set a different `PORT` in `.env` |
| `--share needs cloudflared` (host) | Install cloudflared, or set `CLOUDFLARED_BIN` |

To check the server by hand, from the host:

```bash
BRIDGE_URL=http://127.0.0.1:4000 ACCESS_CODE=<your code> node client.js -p "say hello"
```
