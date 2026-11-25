# Claude Bridge for VS Code

A chat panel for a Claude shared through claude-remote-bridge. Claude explores your workspace by itself; you review every change as a diff and approve every command.

## Connect

You need two things from the host: the link and the access code.

1. Open your project folder.
2. Click the **Claude Bridge** icon in the activity bar.
3. Paste the link and the access code, then click **Connect**.

The access code is kept in VS Code's secret storage and is never sent: it encrypts the connection.

## Use

| Action | How |
| --- | --- |
| Ask something | Type in the box and press Enter (Shift+Enter for a new line) |
| Point at a file | Type `@` and pick a file, or right-click it and choose **Claude Bridge: Mention File in Chat** |
| Include the open file | On by default; click the file chip under the message box to toggle |
| Review a change | Expand the file row, or click the diff icon to open VS Code's diff editor |
| Apply or discard | **Accept all** / **Reject all** on the changes card |
| Run a suggested command | **Run** / **Skip** on the command card |
| Switch mode (ask / auto-accept / auto / plan) | Mode chip, Shift+Tab in the message box, `/auto`, or **Claude Bridge: Turn On Auto Mode** |
| Choose model and effort | Model chip, `/model`, or Ctrl+Alt+Shift+M (**Claude Bridge: Change Model**) |
| Accept or reject per file | ✓ / ✗ on each file row |
| Undo applied changes | **Undo** on the card, or `/undo` |
| Past conversations | Clock in the panel header, or `/history` |
| Run a command without asking next time | **Always allow** on the command card |
| Answer Claude's questions | The question popup that replaces the message box: pick options or type your own, then **Submit answers** |
| Turn skills on (several at once) | **Skills** under the message box, `/skills`, or **Claude Bridge: Choose Skills** |
| Slash commands | Type `/` |
| Mention selected lines | Alt+K in the editor |
| Focus the chat | Ctrl+Esc (Cmd+Esc on macOS) |
| Stop | Stop button or Esc |
| New chat | `+` in the panel header |
| Change link or code | Gear in the panel header |
| Open in an editor tab | `Ctrl+Alt+Shift+B` (`Cmd+Alt+Shift+B` on macOS) or the icon in the editor title bar |

Files with unsaved edits in the editor are never overwritten. Secrets (`.env`, keys), `.git`, `node_modules`, binaries and files over 200 KB are never read.

## Build

```bash
npx @vscode/vsce package --allow-missing-repository --skip-license
```

Packaging copies `../bridge-core.js` into this folder first (the `vscode:prepublish` script), so build from inside the repository.
