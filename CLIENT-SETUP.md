# Claude Bridge: guest setup and use

This guide is for the person connecting to someone else's Claude Bridge. It takes about five minutes.

You chat with Claude from VS Code or from your terminal. Your project stays on your computer. Claude explores the project by itself, but nothing is changed or run on your machine until you approve it.

## What you need

From the host (the person sharing their Claude):

| Item | Looks like |
| --- | --- |
| Link | `https://some-random-words.trycloudflare.com` |
| Access code | `7K2QF-9XHTM-4BWZ8-PLR3D-0CVN6` (or a long string of letters and digits) |
| VS Code extension | `claude-bridge-vscode-3.6.0.vsix` |
| Terminal client (optional) | `claude-remote-bridge-3.6.0.tgz` |

You need both the link and the access code. Neither works alone.

## Option A: VS Code (recommended)

Nothing else to install: the extension works on its own.

### 1. Install the extension

```bash
code --install-extension claude-bridge-vscode-3.6.0.vsix
```

Or in VS Code: open the Extensions view, click the `…` menu, choose **Install from VSIX…** and pick the file.

### 2. Connect

1. Open your project folder in VS Code (**File → Open Folder…**).
2. Click the **Claude Bridge** icon in the activity bar on the left (a chat bubble with a diamond).
3. Paste the link and the access code, then click **Connect**.

The green dot next to the title means you are connected. The access code is kept in VS Code's secret storage.

### 3. Chat

Type in the box at the bottom and press **Enter**. **Shift+Enter** starts a new line.

You do not need to attach files. Claude sees the list of files in your project and opens the ones it needs. While it works you see each step:

```
● Exploring · 3 files, 1 search
    Read    src/routes/checkout.js   2 lines
    Read    src/cart.js              9 lines
    Search  "priceWithTax"           3 matches
  ■ Thinking · step 2   12s
```

Click a file name to open it. Click **Stop** (or press **Esc**) to cancel.

Ways to point Claude at something:

- **The file you have open** is included automatically. The chip under the message box shows it; click the chip to turn this off or on. If you select lines, Claude sees the selection too.
- **`@` mentions**: type `@` and start typing a file name, then pick it from the list. Add `#L10-20` to point at specific lines.
- **From the explorer**: right-click a file or folder and choose **Claude Bridge: Mention File in Chat** (or press `Ctrl+Alt+Shift+K` in the editor).

### 4. Review changes

When Claude wants to change files, a card shows every file with its diff:

- Click a file row to expand its diff in the chat.
- Click the diff icon on the row to open it side by side in VS Code's diff editor.
- Click **Accept all** / **Reject all**, or the ✓ / ✗ on each file to decide file by file.
- After applying, **Undo** puts the files back.

If a file has unsaved edits in your editor, it is not overwritten. Save or revert the file, then accept it again.

Keep your project in git so you can review with `git diff` and undo with `git checkout`.

### 5. Run commands

When Claude suggests a command (like `npm test`), it appears as a card. Click **Run** to run it in your project folder, **Always allow** to run it and never be asked about that exact command again in this project, or **Skip**. The output appears in the card, and **Stop** ends a long-running command.

### Claude keeps going on its own

You never need to type "continue". As soon as every change and command of a step is decided (applied, run, or skipped), the results go back to Claude automatically and it carries on with the next step: it reads the test output, fixes what failed, and so on until the task is done. If you reject a change or skip a command in **Ask before edits** or **Auto-accept edits** mode, Claude stops and waits for you to say what to do instead.

When Claude needs a decision from you (which library, which approach, which option after some research), it asks in a popup that takes the place of the message box. Pick an option or type your own answer, and Claude continues straight away.

For safety, Claude pauses after 30 steps for one message (setting `claudeBridge.autoMode.maxSteps`). Send `continue` to go on. **Esc** or the stop button stops it at any time.

### Modes

The button at the bottom left of the message box switches between four modes. **Shift+Tab** cycles through them.

| Mode | What happens |
| --- | --- |
| **Ask before edits** (default) | Every change waits for you to accept it |
| **Auto-accept edits** | Changes are written right away; the card shows **Undo**. Commands still ask |
| **Auto mode** | Claude works on its own, like Claude Code's auto mode: changes are written and commands run without asking, and it keeps going until the task is done. Risky commands (`sudo`, `git push`, `git reset --hard`, `rm -rf` outside the project, publishing, global installs, `curl … \| sh`) still ask. A command that runs without a click is stopped after 5 minutes. VS Code asks you to confirm the first time you turn it on |
| **Plan mode** | Claude explores and writes a plan with a task list, and changes nothing. If the plan depends on a choice, it asks in a popup first. A **Ready to code?** popup then lets you approve the plan in auto mode, auto-accept edits, or ask before edits (Claude then implements it without further prompting), or keep planning |

Auto mode settings (VS Code settings, search for "Claude Bridge"):

| Setting | Default | Meaning |
| --- | --- | --- |
| `claudeBridge.autoMode.maxSteps` | `30` | Steps per message before Claude pauses (in every mode) |
| `claudeBridge.autoMode.commandTimeoutSeconds` | `300` | Time limit for commands that run without a click; `0` = none |
| `claudeBridge.autoMode.askBeforeRiskyCommands` | `true` | Turn off to let auto mode run every command without asking |

Auto mode runs commands on your machine without showing them to you first. Use it in a project that is in git, and do not use it on a project you would not let Claude change freely.

### Model and effort

Three ways to change the model:

- Click the chip at the bottom right of the message box (it shows the current model, for example **Default**).
- Type `/model` in the message box.
- Press `Ctrl+Alt+Shift+M` (`Cmd+Alt+Shift+M` on macOS), or run **Claude Bridge: Change Model** from the command palette.

You get the models the host allows (Sonnet, Opus, Haiku, Fable) and the effort level. Haiku is fastest; Opus and higher effort are slower but stronger. The choice applies to your next messages; the usage line under each answer shows which model replied.

If the menu says the host's server does not offer a model choice, the host is running an older server: ask them to restart it.

### When Claude asks you something

If Claude needs a decision (which approach, which option), the message box turns into a question popup: each question has clickable options (checkboxes when you can pick several), a box to type your own answer, **Submit answers** and **Skip**. Claude continues as soon as you submit. If you type a normal message instead, Claude takes that as the answer.

### Skills

Skills are instruction sets Claude follows while they are on, for example `code-review`, `write-tests`, `debug` or `security-review`. Several can be on at once (up to 8).

- Click **Skills** under the message box (or type `/skills`, or run **Claude Bridge: Choose Skills**), tick the ones you want, click **Done**.
- Active skills show as chips above the message box; click × to turn one off. Type `/<skill-name>` (for example `/debug`) to switch one on or off quickly.
- Your own skills appear too: any `.claude/skills/<name>/SKILL.md` in the project, or in `~/.claude/skills/` on your computer. Their text is sent to Claude only while they are on.

### Tasks

For bigger jobs Claude keeps a task list. It shows above the message box as **Tasks 1/4**; click it to see every step.

### Undo

Every applied change card has an **Undo** button, and `/undo` undoes the most recent one. If you edited the file after Claude did, you are asked before your edits are overwritten.

### Slash commands

Type `/` in the message box:

| Command | What it does |
| --- | --- |
| `/new` | New conversation |
| `/history` | Open a past conversation |
| `/plan`, `/auto`, `/accept-edits`, `/ask` | Switch mode (plan, auto mode, auto-accept edits, ask before edits) |
| `/model` | Choose the model and effort |
| `/skills` | Choose skills (several at once) |
| `/<skill-name>` | Turn that skill on or off |
| `/undo` | Undo the last applied changes |
| `/compact` | Summarize a long conversation so Claude has room to continue |
| `/settings` | Link, access code and always-allowed commands |
| `/help` | Shortcuts |

### History

Conversations are saved per project. The clock button in the header lists them; click one to continue it. Changes that were never decided in an old conversation cannot be applied any more.

### Always allow

A command card has **Always allow**: it runs that exact command now and in the future without asking, in this project only. Remove entries under the gear (Settings).

### Problems and selections

When **the file you have open** is included, Claude also sees VS Code's errors and warnings for it, so "fix the errors in this file" works. Select lines and press **Alt+K** to put a reference like `@src/app.js#L10-20` in the message box.

### Buttons and shortcuts

| Button or key | What it does |
| --- | --- |
| Clock (header) | Past conversations |
| `+` (header) | New conversation |
| Gear (header) | Settings: link, access code, always-allowed commands |
| `Ctrl+Esc` (`Cmd+Esc` on macOS) | Focus the chat |
| `Alt+K` | Mention the current file and selected lines |
| `Ctrl+Alt+Shift+M` (`Cmd+Alt+Shift+M`) | Change the model |
| `Ctrl+Alt+Shift+B` (`Cmd+Alt+Shift+B`) | Open the chat in an editor tab |
| `Shift+Tab` (in the message box) | Switch mode |
| `Esc` | Stop Claude |

## Option B: terminal

Needs Node.js 18 or newer. Check with `node --version`.

### 1. Install

```bash
npm install -g ./claude-remote-bridge-3.6.0.tgz
```

If `npm install -g` fails with a permission error on Linux or macOS, run it with `sudo`.

### 2. Connect

```bash
claude-bridge --setup
```

Paste the link, then the access code. They are saved in `.bridge.json` in your home folder.

### 3. Chat

```bash
cd my-project
claude-bridge
```

Type a message and press Enter. Claude explores the project by itself and shows each step:

```
  ● Reading the cart, pricing and tests.
    ↳ read   src/cart.js · 9 lines
    ↳ read   src/price.js · 8 lines
```

Proposed changes are shown as a colored diff:

```
  ● Proposed changes · 1 file  +1 −2
    ╭─  EDIT  src/price.js  +1 −2
    │    4 -   return price * (1 + TAX_RATE) * (1 + TAX_RATE);
    │    4 +   return price * (1 + TAX_RATE);
    ╰─
  Apply these changes?  y apply   d full diff   n discard ›
```

Type `y` to write, `n` to discard, or `d` to see the whole diff first. Suggested commands are asked about one by one: `y` runs, `n` skips.

| Type | What it does |
| --- | --- |
| `@path` | Make sure a file or folder is included |
| `/context` | Files Claude currently has in view |
| `/drop <path>` | Take a file or folder out of view |
| `/clear` | Start a new conversation |
| `/plan`, `/auto`, `/ask` | Plan mode, auto-accept edits, ask before edits |
| `/model [name]` | Show or pick the model (`sonnet`, `opus`, `haiku`, `fable`) |
| `/effort [level]` | `low`, `medium`, `high`, `xhigh`, `max` |
| `/undo` | Undo the last applied changes |
| `/skills [name\|off]` | Pick skills by number (several at once), toggle one, or turn all off |
| `/compact` | Summarize a long conversation |
| `/status` | Check the connection |
| `/help` | Show the commands |
| `/exit` or `Ctrl+D` | Quit |
| `Ctrl+C` | Stop the current request |

Other ways to start:

```bash
claude-bridge "explain how checkout works"   # open the chat with a first message
claude-bridge -p "what does this project do?"  # print one answer and exit (never changes anything)
```

## When the link or access code stops working

If the host restarted their server (quick links change on every restart) or changed the access code, you see a message such as *"The link answered with HTTP 530…"* or *"Could not reach…"*. You are asked for the new ones right away:

- **VS Code** opens the connection form with your old link filled in. Paste the new link and the access code, click **Connect**, then click **Retry** in the chat to resend your message. Your conversation is kept.
- **Terminal** asks *"Enter the new link and access code now?"*. Type `y`, paste the new link (Enter keeps the old one), and the access code (Enter keeps the current one). It is saved, and you can resend your message.

You can also change them any time: the gear in VS Code, or `claude-bridge --setup`.

If the host set up a fixed link, this only happens when their server is off.

## What leaves your computer

Sent to the host, encrypted with the access code:

- your messages
- the list of file paths in your project
- the contents of files Claude reads (it reads what it needs, automatically)
- the search results it asks for
- the output of commands you ran

Never read or sent, even if Claude asks:

- `.env` files, SSH keys, `.pem` and `.key` files, `.npmrc`, `.netrc`, `.bridge.json`
- `.git/` and `node_modules/`
- files listed in your project's `.gitignore` are left out of the file list
- binary files such as images, archives and executables
- files larger than 200 KB
- anything outside the project folder

The host can read everything that is sent, and it is passed on to Anthropic as part of the Claude request. If your project contains anything you would not show the host, keep it out of the folder or add it to `.gitignore`.

## Troubleshooting

| Message | What to do |
| --- | --- |
| `Could not reach …` | The host's server is off, or the link has changed. Ask the host for the current link |
| `The link answered … but not from the bridge` | Same as above |
| `The host rejected the access code` | The access code is wrong. Enter it again |
| `The host runs an older or newer bridge version` | Ask the host which version to install |
| `…the clocks differ too much` | Fix the date and time on your computer |
| `The host is busy (queue full)` | Wait a moment and send the message again |
| `Claude did not finish within 120s` | Ask for less in one message |
| `Request too large` | Start a new chat (`+` or `/clear`) so fewer files are in view |
| `Claude returned an error: …` | A problem on the host's side, usually a usage limit. Tell the host |
| `Unsaved edits in the editor` (VS Code) | Save or revert that file, then click **Apply** again |

## Remove it

- VS Code: click the gear, choose **Forget saved link and code**, then uninstall the extension from the Extensions view.
- Terminal: `npm uninstall -g claude-remote-bridge`, then delete `.bridge.json` from your home folder.
