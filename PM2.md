# Running the bridge server with pm2

pm2 keeps `server.js` running in the background, restarts it if it crashes, and can start it again after a reboot. Run every command below from the `claude-remote-bridge` folder.

## One-time setup

Install pm2 if you don't have it:

```bash
npm install -g pm2
```

Start the server with a public link:

```bash
cd ~/Desktop/apps/claudecodeshare/claude-remote-bridge
pm2 start server.js --name claude-bridge --max-restarts 10 --restart-delay 5000 -- --share
pm2 save
```

- `--name claude-bridge` is the name used in all the commands below.
- Everything after `--` is passed to `server.js`. To pick a default model, add it there: `-- --share --model opus`.
- `--max-restarts 10 --restart-delay 5000` stops pm2 from retrying forever if the server can't start.
- `pm2 save` stores this setup so pm2 can restore it.

## Start automatically after a reboot

Run this once:

```bash
pm2 startup
```

It prints a `sudo env PATH=… pm2 startup …` command. Copy and run that line, then:

```bash
pm2 save
```

## Get the link and access code

```bash
pm2 logs claude-bridge --lines 40
```

Look for the box:

```
    Link:         https://example-words.trycloudflare.com
    Access code:  XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
    Model:        CLI default  (guests can switch to: sonnet, opus, haiku, fable)
```

Press `Ctrl+C` to leave the log view; the server keeps running.

**With the default quick tunnel, the link changes every time the server restarts**, including automatic restarts after a crash or a reboot. The access code stays the same. After a restart, send your guest the new link, or set up [a link that never changes](#a-link-that-never-changes). They enter it under the gear in VS Code, or run `claude-bridge --setup` in the terminal.

A new link can take about a minute before it works. Until then, guests see "Could not reach …".

## A link that never changes

By default (`TUNNEL=quick`) every start gives a new random link. To keep one link forever, pick one of these, put the settings in `.env`, and restart: `pm2 restart claude-bridge`. Guests then enter the link once. The access code already stays the same (it is the `ACCESS_CODE` / `AUTH_TOKEN` line in `.env`).

### Option 1: ngrok free static domain (easiest, no domain needed)

1. Create a free account at <https://ngrok.com>.
2. In the ngrok dashboard:
   - **Your Authtoken**: copy the token.
   - **Domains**: claim your free static domain, for example `quiet-river-1234.ngrok-free.app`.
3. Install ngrok into `~/.local/bin` (no sudo):

   ```bash
   curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar xz -C ~/.local/bin
   ngrok version
   ```

4. In `.env`:

   ```
   TUNNEL=ngrok
   NGROK_DOMAIN=quiet-river-1234.ngrok-free.app
   NGROK_AUTHTOKEN=<your token>
   ```

5. `pm2 restart claude-bridge`. The log shows `Link: https://quiet-river-1234.ngrok-free.app` and "This link stays the same too".

### Option 2: Cloudflare named tunnel (your own domain)

Needs a domain that uses Cloudflare DNS.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → type **Cloudflared**, name it, and copy the **token** from the install command it shows (the long string after `--token`).
2. In the tunnel, add a **Public hostname**, for example `bridge.example.com`, with service `HTTP` → `localhost:4001` (your `PORT`).
3. In `.env`:

   ```
   TUNNEL=cloudflare
   CLOUDFLARE_TUNNEL_TOKEN=<token>
   PUBLIC_URL=https://bridge.example.com
   ```

4. `pm2 restart claude-bridge`.

### Option 3: Tailscale Funnel

Gives `https://<your-pc>.<tailnet>.ts.net`, which stays the same.

1. Install Tailscale (<https://tailscale.com/download>) and sign in.
2. `sudo tailscale funnel --bg 4001` (your `PORT`). It prints the public address.
3. In `.env`:

   ```
   TUNNEL=none
   PUBLIC_URL=https://<your-pc>.<tailnet>.ts.net
   ```

4. `pm2 restart claude-bridge`.

The tunnel tokens are secrets: keep them only in `.env` (owner-only). The server passes them to the tunnel program through its environment, not its command line.

## Everyday commands

| What | Command |
| --- | --- |
| Status | `pm2 status` |
| Show the link, access code and recent activity | `pm2 logs claude-bridge --lines 40` |
| Follow activity live | `pm2 logs claude-bridge` |
| Restart (gives a new link) | `pm2 restart claude-bridge` |
| Stop sharing | `pm2 stop claude-bridge` |
| Start again after stopping | `pm2 start claude-bridge` |
| Remove it from pm2 | `pm2 delete claude-bridge`, then `pm2 save` |

## Changing settings

Settings live in `.env` next to `server.js` (see `.env.example`). After editing it:

```bash
pm2 restart claude-bridge
```

| Setting | Example | Meaning |
| --- | --- | --- |
| `PORT` | `PORT=4001` | Local port (use a free one) |
| `TIMEOUT_MS` | `TIMEOUT_MS=0` | Longest Claude run in milliseconds; `0` = no limit |
| `CLAUDE_MODEL` | `CLAUDE_MODEL=sonnet` | Default model |
| `ALLOWED_MODELS` | `ALLOWED_MODELS=sonnet,haiku` | Models guests may pick |
| `MAX_QUEUE` | `MAX_QUEUE=5` | Requests that may wait behind the running one |
| `ACCESS_CODE` | — | Delete the line and restart to get a new access code; the old one stops working |
| `TUNNEL` | `TUNNEL=ngrok` | How the public link is made: `quick`, `ngrok`, `cloudflare`, `none` (see above) |

To change the arguments themselves (for example add `--model opus`), recreate the process:

```bash
pm2 delete claude-bridge
pm2 start server.js --name claude-bridge --max-restarts 10 --restart-delay 5000 -- --share --model opus
pm2 save
```

## After updating server.js

```bash
pm2 restart claude-bridge
```

Then check the log for the new link.

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| `server.js: command not found`, exit code 127, status `errored` | The command was quoted: `pm2 start "server.js --share"` makes bash run `server.js` as a program. Run `pm2 delete <name>`, then start it as shown above, with `--` before `--share`. |
| `Port 4001 is already used by another program` | Another copy is still running, maybe in a terminal. Stop it (`Ctrl+C` there, or `pm2 status` to find a duplicate), or set another `PORT` in `.env`. |
| `--share needs cloudflared` | pm2 cannot find `cloudflared`. Add `CLOUDFLARED_BIN=/home/<you>/.local/bin/cloudflared` to `.env` and restart. |
| `Could not run "claude --version"` | pm2 was started from a shell where `claude` is not on `PATH`. Add `CLAUDE_BIN=/home/<you>/.local/bin/claude` to `.env` and restart. |
| Guests get "Could not reach …" or "HTTP 530" | The server restarted and the quick link changed (check the log for the new one), or the link is less than a minute old. Their app asks them for the new link. A fixed link avoids this. |
| `TUNNEL=ngrok needs …` / `TUNNEL=cloudflare needs …` | A setting is missing in `.env`; the message says which. |
| Status keeps flipping between online and errored | Read the reason with `pm2 logs claude-bridge --err --lines 50`. |

pm2 keeps its logs in `~/.pm2/logs/` (`claude-bridge-out.log` and `claude-bridge-error.log`). The server logs sizes and counts only, never prompts or code. The startup box does contain the access code, so don't share those log files.
