# flotilla

A calm, local web dashboard for your Claude Code background agents.
One browser tab instead of a dozen terminals.

```bash
git clone https://github.com/Felischwarz/flotilla.git
cd flotilla
npm install
npm start          # → http://127.0.0.1:4823
```

Localhost only. No login, no cloud service, nothing exposed to the network.

> flotilla is an independent project. It is not affiliated with, endorsed by,
> or supported by Anthropic.

---

## What it does

- **Every agent at a glance.** A sidebar lists all your background agents,
  grouped into lanes: *Needs you*, *Failed*, *Working*, *Done*, *Ready*,
  *Stopped*.
  Unread marks work like email: an agent that finished or asked something
  since you last looked is bold until you open it.
- **Panes side by side.** Open as many agents as you like in columns; drag the
  dividers, stack panes, move them around. A pane only closes when you close it.
- **A real terminal.** *Reply* opens `claude attach <id>` in a genuine PTY
  (xterm.js + node-pty), right inside the pane. No home-made chat protocol.
- **Start agents from the browser.** Prompt, folder, model, effort, runtime,
  attachments. Under the hood it is just `claude --bg …`.
- **Drafts that survive.** Half-written prompts are stored on the server, not in
  the tab, so a reload, a crash or a closed window loses nothing.
- **Workspaces.** Each browser window can be pinned to one folder; it then shows
  only that folder's agents and starts new ones there.
- **Search** every agent by name, status line, first prompt, folder or id, in
  any word order, including finished and archived ones.
- **Pin, archive, sort, group.**
- **Usage and context budget.** Token usage read from your transcripts, and how
  much every session in a repo pays before it starts working (CLAUDE.md files,
  imports, memory), with a daily history so you notice when it creeps up.
- **RAM panel and auto-stop.** What your Mac's memory is actually spent on, by
  kind (agents, the tools they started, browser, editor, the rest), plus an
  optional auto-stop that runs `claude stop` on agents that finished and have
  been quiet for an hour. The conversation is kept; attaching wakes it up again.
- **Floating overview.** A small always-on-top window (Document
  Picture-in-Picture) for your other monitor.
- **Sounds and phone push.** A chime when an agent finishes or needs you, and
  optional push notifications to your phone via [ntfy](https://ntfy.sh), with
  replies from the phone back into the agent.
- **Other runtimes.** Run the same `claude` binary against the Claude API,
  Amazon Bedrock or DeepSeek instead of your subscription, with a spending
  guard for Bedrock.

## Requirements

- **macOS.** The RAM panel, notifications and the "open in Terminal" action use
  macOS tools (`vm_stat`, `sysctl`, `osascript`, Terminal.app).
- **Node.js 20 or newer.**
- **Claude Code** with background agents (`claude --bg`, `claude agents`).
  flotilla looks for the binary in `~/.local/bin`, `/opt/homebrew/bin` and
  `/usr/local/bin`; set `CLAUDE_BIN` if yours lives elsewhere.

## How it works

flotilla never invents state and never writes into `~/.claude`. It reads what
Claude Code already writes, and every button runs a real `claude` command.

| It reads | for |
|---|---|
| `~/.claude/jobs/<id>/state.json` | state, one-line status, the original prompt |
| `~/.claude/jobs/<id>/timeline.jsonl` | state changes over time |
| `~/.claude/projects/**/<uuid>.jsonl` | the full transcript |
| `claude agents --json --all` | whether the process is alive and waiting on you |

| Button | Command |
|---|---|
| Reply | `claude attach <id>` (real PTY) |
| Stop | `claude stop <id>` |
| Respawn | `claude respawn <id>` |
| Delete | `claude rm <id>` |
| + New agent | `claude --bg [--name …] [--model …] [--effort …] "prompt"` |

Everything flotilla stores lives in **`~/.flotilla`**: drafts, read/unread and
archive state, workspaces, attachments, the usage index, context history,
automatic backups of its own state, and (if you add them) runtime keys.

## Security model

- The server binds **127.0.0.1** only.
- Browser requests, including the terminal WebSocket, are only accepted from
  flotilla's own page: the `Host` header must name this machine (which defeats
  DNS rebinding), and the `Origin` header, when present, must be flotilla's own. A website open in
  another tab therefore cannot start agents or type into a terminal.
- There is no login. Anything that can already run programs as your user can
  use flotilla, exactly as it could run `claude` directly.
- API keys are read from files in `~/.flotilla` (create them with `chmod 600`)
  or from environment variables. They are handed to Claude Code through a
  settings file or an `apiKeyHelper`, never through the command line, and are
  never sent to the browser.

## Runtimes (optional)

By default, agents run on your normal Claude Code login. In the *New agent*
pane you can pick another runtime. It is still the same `claude` binary in the
same folder with the same permissions, CLAUDE.md, hooks and skills; only the
API it talks to changes (via `claude --settings <file>`).

```bash
mkdir -p ~/.flotilla

# Claude API (billed to your Anthropic API account, not your subscription)
printf '{ "apiKey": "sk-ant-YOUR-KEY" }' > ~/.flotilla/claude-api.json
chmod 600 ~/.flotilla/claude-api.json

# Amazon Bedrock (an Amazon Bedrock API key; billed to your AWS account).
# "region" defaults to us-east-1. "profilePrefix" (us | eu | apac | jp | au |
# global) is optional; left out, Claude Code derives it from the region.
printf '{ "apiKey": "YOUR-BEDROCK-KEY", "region": "us-east-1" }' > ~/.flotilla/bedrock.json
chmod 600 ~/.flotilla/bedrock.json

# DeepSeek
printf '{ "apiKey": "sk-YOUR-KEY" }' > ~/.flotilla/deepseek.json
chmod 600 ~/.flotilla/deepseek.json
```

For DeepSeek and Bedrock you can also set `DEEPSEEK_API_KEY` or
`BEDROCK_API_KEY` in the environment instead (the environment wins). Restart the
server afterwards; the startup banner says which runtime is ready and why not.
A runtime without a key stays visible in the dropdown but cannot be selected.

### Bedrock budget

AWS cannot tell flotilla what you spent (a Bedrock API key cannot call Cost
Explorer), so flotilla estimates it from the transcripts of your Bedrock agents
(tokens × list price, deliberately on the high side).

```bash
printf '{ "limitUsd": 100, "alertStepPct": 10, "priceMultiplier": 1.1, "spentOffsetUsd": 0 }' \
  > ~/.flotilla/bedrock-budget.json
```

- Every `alertStepPct` percent you get one notification (macOS, and your phone
  if push is on).
- At 100 % new Bedrock starts and respawns are refused, running Bedrock agents
  are stopped, and their settings file gets a dead key, so a resumed session
  fails at AWS instead of spending.
- Raising the limit lifts the block within 30 seconds.
- `spentOffsetUsd` covers spending that did not go through this machine.

It is an estimate on a 30-second tick. For a hard limit enforced by AWS itself,
also set up an AWS Budget with a budget action.

## Push to your phone (optional)

Click **📱** in the top bar. flotilla uses [ntfy](https://ntfy.sh): this machine
makes outbound connections only, no port is opened and nothing becomes
reachable from outside. Install the ntfy app, subscribe to the topic shown in
the dialog, done.

- **The topic is the password.** Anyone who knows it can read your
  notifications (and, if replies are on, write into your agents). Use the
  *Random topic* button, or reserve a topic on your ntfy server and enter an
  access token.
- **A notification is a pointer, not content:** agent name, folder name, state
  and short id. No prompt, no path, no transcript line, unless you switch on
  *include the last line*.
- **Replies** are off until you enable them. Then `#<id> text` in the topic
  goes to that agent, plain text goes to the agent that notified you last, and
  notifications carry one-tap buttons (*Yes* and *Continue* when an agent needs
  you, *Continue* otherwise).

## Configuration

| Variable | Default | |
|---|---|---|
| `FLOTILLA_PORT` | `4823` | port on 127.0.0.1 |
| `FLOTILLA_DATA_DIR` | `~/.flotilla` | where flotilla keeps its own state |
| `FLOTILLA_DEFAULT_ROOT` | your most-used folder, else `~` | default folder for new workspaces |
| `CLAUDE_BIN` | searched automatically | path to the `claude` binary |

To try a change without touching your running instance, start a second one on
another port **with its own data directory** (two servers sharing one would
overwrite each other's state and answer the same phone reply twice):

```bash
FLOTILLA_PORT=4830 FLOTILLA_DATA_DIR=/tmp/flotilla-dev npm start
```

## Development

```bash
npm test           # runtime registry and budget checks
```

The frontend is plain JavaScript without a build step (`public/`), the server is
a single Node process (`server.mjs`) with a few modules next to it.
`public/vendor/` contains unmodified copies of xterm.js and its fit addon (MIT,
see `public/vendor/LICENSE-xterm.txt`).

### Known pitfalls

- npm unpacks node-pty's `spawn-helper` without its executable bit, and every
  terminal then fails with `posix_spawnp failed`. The `postinstall` script in
  `package.json` fixes that after every `npm install`.
- **A script that types into the live UI writes real data.** Drafts are saved
  on every keystroke, so test text ends up in `drafts.json` and shows up in
  real panes after the next reload. Point automated UI tests at a second
  instance with its own `FLOTILLA_DATA_DIR`.

## License

[MIT](LICENSE)
