# Operator Setup — Stand Up a Configured Daemon

This is the runbook for standing up a working, configured Engineer daemon for a human, end to end. It is written to be **driven by an agent** on the human's behalf: every step is concrete and verifiable, and it names the exact moment to bring the human in. You can also follow it yourself.

The shape of the job: **the agent self-serves everything it can, and pulls the human in only for the irreducibly-human steps — obtaining secrets — leading them precisely.** Configuration, plugin discovery, tool-to-plugin mapping, and verification are all the agent's to do without a human present. The only thing a person must do is create a token in a web UI, because only they hold the account. When that moment comes, the daemon prints exactly what to do, and the agent relays it.

This runbook assumes an **editable clone** with `engineer` built and linked (the [README → Get Running](https://github.com/FarzamMohammadi/the-engineer/blob/main/README.md#get-running) section). It does not cover installing from npm.

The worked example throughout is a human who uses **GitHub** (issues + code), **Telegram** (chat), and **Claude Code** (their coding CLI) — all of which ship as plugins. Step 4a covers the harder, more impressive case: a tool with **no shipping plugin** (Linear, Discord, GitLab), where the agent authors one on the spot and returns to finish.

---

## The model in one picture

```
agent interviews human → discovers shipping plugins → maps tools to plugins
        │
        ├─ every tool has a plugin ──→ assemble seed → start --seed
        │                                                   │
        └─ a tool has NO plugin ──→ author it (authoring.md) ┘
                                                             │
                              start reports a missing secret │
                                                             ▼
                        agent reads the printed acquisition steps,
                        brings the human in with EXACTLY those steps,
                        resumes when the human confirms the token is set
                                                             │
                                                             ▼
                              doctor --json (exit 0) → dashboard → done
```

---

## Step 0 — Build and link the CLI

Every later step calls the `engineer` command, and a fresh clone has no `engineer` to call: the `bin` in `package.json` points at `./dist/index.mjs`, which does not exist until the project is built. Do this once, first, before anything else.

Run the project's setup, which installs dependencies, builds, and links the `engineer` CLI globally — the [README → Get Running](https://github.com/FarzamMohammadi/the-engineer/blob/main/README.md#get-running) section is canonical:

```bash
pnpm run setup
```

Then confirm the CLI is on your PATH and runnable:

```bash
engineer doctor
```

If `engineer` is not found, `pnpm run setup` has not completed (or pnpm's global bin directory is not on your PATH — `setup` tells you how to fix that). Do not proceed to Step 1 until `engineer doctor` runs.

## Step 1 — Interview the human for their tooling

Before touching a file, ask the human a short set of questions. The Engineer fills four adapter slots; you need one answer per slot:

| Slot | The question to ask | Example answers |
|------|---------------------|-----------------|
| **Coding CLI** (the agent that does the work) | "Which coding-agent CLI do you use?" | Claude Code, OpenCode, Gemini CLI |
| **Issue tracker / task source** | "Where do the tasks come from — what do you file work in?" | GitHub Issues, Linear, Jira |
| **Git host** (where code and PRs live) | "Where does your code live?" | GitHub, GitLab |
| **Chat** (how The Engineer reaches them) | "How should The Engineer reach you?" | Telegram, GitHub comments, Discord |

Keep it brief — four short questions, one answer each. One tool can fill more than one slot (GitHub commonly fills issue tracker, git host, **and** chat). Write the human's answers down; they drive every later step.

For the worked example: coding CLI = **Claude Code**, issue tracker = **GitHub Issues**, git host = **GitHub**, chat = **Telegram**.

## Step 2 — Discover which plugins ship

Do not assume which plugins exist — **discover them from the repo.** The shipping plugins are documented under [`docs/plugins/`](../../../plugins/plugin-context.md), one directory per adapter type, each with a `README.md` whose **Built-in Plugins** table lists every plugin that ships for that adapter:

- [`docs/plugins/trigger/README.md`](../../../plugins/trigger/README.md) — issue-tracker / task-source plugins
- [`docs/plugins/communication/README.md`](../../../plugins/communication/README.md) — chat plugins
- [`docs/plugins/git-hosting/README.md`](../../../plugins/git-hosting/README.md) — git-host plugins
- [`docs/plugins/agent/README.md`](../../../plugins/agent/README.md) — coding-CLI plugins

Read those four tables and build your own list of what ships, per slot. The single registry the code itself reads is `src/plugins/builtin.ts` — if you want the ground-truth list straight from source, the `manifests` array there is it (each entry's `type` is the slot and `id` is the plugin id). Either way, **the list comes from the repo, never from this runbook** — this document names GitHub, Telegram, and Claude Code only as *examples*, and the shipped set can grow.

## Step 3 — Map the human's tools to plugins

For each tool the human named in Step 1, find the matching plugin in the list from Step 2:

- **Coding CLI = Claude Code** → `claude-code-agent` (agent slot)
- **Issue tracker = GitHub Issues** → `github-trigger` (trigger slot)
- **Git host = GitHub** → `github-hosting` (git-hosting slot)
- **Chat = Telegram** → `telegram-comm` (communication slot)

If **every** tool maps to a shipping plugin, go to Step 4. If **any** tool has no plugin (the human said Linear, or Discord, or GitLab and you found no match), go to **Step 4a** first — you will author the missing plugin, then return here.

## Step 4 — Assemble a seed directory

The Engineer configures non-interactively from a **seed directory**: a folder with `plugins/` and `configs/` subdirectories of YAML, passed to `engineer start --seed <dir>`. You do not write this YAML from scratch and you do not read `config.ts` Zod schemas to synthesize it — **you copy the shipped example and edit values.**

The repo ships [`seed-example/`](https://github.com/FarzamMohammadi/the-engineer/tree/main/seed-example) as a complete, working reference layout:

```
seed-example/
  plugins/          # one YAML per plugin (github-trigger.yaml, telegram-comm.yaml, …)
  configs/          # core configs: people.yaml, daemon.yaml, safety.yaml, …
```

**Copy it to a personal, gitignored seed** (the `seed-example-*` pattern is already gitignored, so your copy never gets committed):

```bash
cp -r seed-example seed-example-acme
```

Now edit `seed-example-acme/` for the chosen plugins:

1. **Keep only the plugin YAMLs you need.** Delete from `plugins/` any plugin the human is not using. For the worked example keep `claude-code-agent.yaml`, `github-trigger.yaml`, `github-hosting.yaml`, `telegram-comm.yaml`; delete `github-comm.yaml` (Telegram is the chat channel). A plugin is active if and only if its YAML is present in the seed.
2. **Fill in the real values** in each kept YAML. Replace placeholders like `your-github-username` and `your-repo-name` with the human's actual values (and the agent `cli_path` only if your coding CLI isn't on `PATH`). **Leave the `${VAR}` secret references as-is** (`${GITHUB_TOKEN}`, `${TELEGRAM_BOT_TOKEN}`) — those resolve from `~/.engineer/.env` and are filled in Step 6, not inlined here.
3. **Edit `configs/people.yaml`** with the human's real name and contact handles, and confirm the `owner` role. The owner is the single person The Engineer reaches; a missing owner only warns, it never blocks — but fill it, since it is who gets pulled in for decisions and secrets. (Single-user is a deliberate v1 constraint — see [`docs/constraints.md`](../../../constraints.md).) **Remove (or comment out) any owner contact whose communication plugin you did not keep in step 1** — the shipped owner has both a `telegram` and a `github` contact, so if you deleted `github-comm.yaml` (Telegram-only), delete the owner's `github` contact too, or `doctor` warns `unreachable_owner_channel` and exits 2.
4. **Leave the other `configs/` (daemon, safety, workspace, orchestrator) at their shipped defaults** unless the human asked for something specific.

For what each field means, the references are:

- [`docs/cli.md` § First Run](../../../cli.md#first-run) — the seed-directory contract and what `--seed` does.
- [`docs/configuration/`](../../../configuration/README.md) — one page per core config (daemon, safety, workspace, orchestrator, people) explaining every field.

Only when a plugin field is **not shown in the example** do you reach into that plugin's `src/plugins/<type>/<plugin-id>/config.ts` to see the field name and default — the example covers the common case, the schema is the fallback.

## Step 5 — Start the daemon from the seed

Run the non-interactive setup, pointing at your seed directory. When you are driving setup unattended, add `--daemon` so the daemon detaches and runs in the background instead of blocking your shell:

```bash
engineer start --daemon --seed seed-example-acme
```

`--daemon` is the right choice for an agent: bare `engineer start` runs the daemon in the **foreground** (it blocks until `Ctrl+C`), which is fine when a human wants to watch live activity scroll, but an agent driving setup needs the command to return so it can run `doctor` and continue. Drop `--daemon` only if you intend to watch the daemon run live yourself.

This copies your plugin configs and core configs into `~/.engineer/`, then validates that every `${VAR}` reference resolves. One of two things happens:

- **Setup completes and the daemon starts** — go to Step 7.
- **Setup reports a missing secret and stops** — that is expected on a fresh machine; go to Step 6.

## Step 6 — Bring the human in for secrets (the only human-gated step)

When a `${VAR}` has no value yet, setup stops and prints the **precise acquisition steps** for each missing secret — not a generic "set the env var," but the actual how-to. For the worked example it prints something like:

```
✗ Seed incomplete — missing required environment variables:
    GITHUB_TOKEN — obtain it: Create a GitHub personal access token with the repo scope — scopes: repo — https://github.com/settings/tokens
    TELEGRAM_BOT_TOKEN — obtain it: Message @BotFather on Telegram, send /newbot, and copy the bot token — https://t.me/BotFather
  Add them to ~/.engineer/.env or set them in your environment, then restart.
```

This is the one place a human is irreplaceable: only they hold the account that can mint the token. **Read what setup printed and relay exactly those instructions to the human** — the URL, the scope, the one-line how-to — in a "do this, then tell me when it's done" form. For example:

> I need two tokens to finish setup. Please:
> 1. **GitHub token** — go to https://github.com/settings/tokens, create a personal access token with the **repo** scope, and paste it back to me.
> 2. **Telegram bot token** — message **@BotFather** on Telegram, send `/newbot`, and paste the token it gives you.
> Tell me when you have both.

Do not invent steps, scopes, or URLs — use exactly what the daemon printed. (That text comes from the plugin manifest's secret-acquisition metadata; if a plugin declares none, the message degrades to a plain "add `VAR=…` to `.env`", and you relay that.)

When the human hands you the tokens, write them to the env file (mode `0600`, never committed) and resume:

```bash
printf 'GITHUB_TOKEN=%s\nTELEGRAM_BOT_TOKEN=%s\n' "<token-from-human>" "<token-from-human>" >> ~/.engineer/.env
chmod 600 ~/.engineer/.env
engineer start --daemon --seed seed-example-acme
```

Setup now finds every secret and the daemon starts. If a *different* secret is still missing, the report names it with its own acquisition steps — repeat this step for that one. For the worked GitHub + Telegram stack there are exactly **two** such pauses.

### The Telegram `/start` handshake — when `telegram-comm` is configured

A token alone does not let The Engineer reach the human over Telegram. Telegram bots cannot start a conversation; the `telegram-comm` plugin only learns the owner's `chat_id` after the human messages the bot. Until that happens the bot has a valid token but no one to send to — and `engineer doctor` **cannot** detect this (it verifies the token, not whether the human has opened the chat). This is a Telegram platform requirement, not a plugin limitation — see [the `/start` handshake](../../../plugins/communication/telegram-comm.md#the-start-handshake).

So whenever your seed includes `telegram-comm`, this is a second human-gated action — relay it explicitly:

> Two more one-time things so I can actually message you on Telegram:
> 1. **Open your Telegram bot and send it `/start` once.** Until you do, The Engineer cannot send you anything.
> 2. **Set your owner `handle` in `configs/people.yaml` to your exact Telegram username** (case-insensitive, no leading `@`). That is how I match messages to you.
> Tell me when you've sent `/start`.

Because `doctor` cannot confirm the handshake, you must get the human's explicit confirmation that they sent `/start` before you declare setup done. A green `doctor` with no handshake means the daemon is healthy but silently unable to notify the human — exactly the gap this step closes.

## Step 7 — Verify the daemon is ready

Confirm readiness with the machine-readable self-check — it validates config, secrets, manifests, and dependencies and returns a parseable result with an exit code:

```bash
engineer doctor --json
```

The output is `{ "checks": [...], "exitCode": N }` where:

- **`exitCode: 0`** — everything passed; the daemon is ready. You are done with verification.
- **`exitCode: 2`** — warnings only (e.g. no owner configured, no cost limits). The daemon runs, but read the warning `checks` and decide with the human whether to address them.
- **`exitCode: 1`** — a hard failure. Read the failing `checks`; each carries a `remedy` string telling you exactly what to fix (a missing secret's remedy includes the same acquisition steps from Step 6). Fix it and re-run.

Then confirm the daemon is actually serving: when `engineer start` reported ready, it printed the **dashboard URL** ([http://localhost:3847](http://localhost:3847)). Open it (or `curl` it) and confirm the daemon's live activity renders. A green `doctor --json` plus a live dashboard means the daemon is up, configured, and watching for work.

That's the whole hero flow: interview, discover, map, seed, start, pause once per secret with precise instructions, verify. Everything except minting the tokens — and, for Telegram, sending `/start` (Step 6) — the agent did on its own. Do not declare setup done on a green `doctor` alone when `telegram-comm` is configured: confirm with the human that they sent `/start`, since that is the one readiness fact `doctor` cannot see.

---

## Step 4a — When a tool has no shipping plugin: author one, then come back

This is the case that turns "configure what ships" into "support anything." The human named a tool — say **Linear** for issue tracking, or **Discord** for chat, or **GitLab** for hosting — and in Step 2 you found **no shipping plugin for it**. The Engineer is plugin-extensible by design: the answer is not "unsupported," it is "author the plugin, then finish setup." This is one continuous story, not a separate project.

**This bridge is your inference, not a code path.** Nothing in the daemon routes "the human wants Linear" into the authoring flow — Core is plugin-opaque and only ever enumerates the plugins that exist, never the tools a human wishes for. The connection is made *here, by you*:

1. **Diff what the human named against what ships.** You have the human's tools (Step 1) and the shipping-plugin list (Step 2). For each tool with no match, identify which **adapter slot** it fills using the same table from Step 1 — Linear reports new work, so it fills the **trigger** slot; Discord is how The Engineer reaches the human, so **communication**; GitLab hosts code and PRs, so **git-hosting**. The daemon itself never tells you "the human wants Linear" — Core only enumerates the plugins that exist (you can confirm which are configured with `engineer doctor`, which lists each enabled plugin from its config file, plugin-opaquely). The gap between *named tool* and *existing plugin* is yours to spot.
2. **Conclude: "no plugin for `<tool>` → author one."** That is the bridge. You are not blocked; you have a build task.
3. **Follow [Authoring a Plugin](../plugins/authoring.md) end to end** for that tool. That methodology is the full build: pick the adapter slot (the one you just identified), read the contract, scaffold from the reference plugin, implement the `do*` methods, register it in `src/plugins/builtin.ts` (including the **secret-acquisition metadata** for its token — that is what makes Step 6 print precise instructions for *this* new plugin too), run the contract suite until green, and configure it. Build exactly the one plugin for the one missing slot.
4. **Return to Step 3 of this runbook.** The tool now has a plugin — it appears in `src/plugins/builtin.ts` and its `docs/plugins/<type>/` page. Map it like any other, add its YAML to your seed (Step 4), and continue to Step 5. From here the flow is identical: start, pause for that plugin's secret with the precise instructions the metadata you wrote now produces, verify, done.

The result is one unbroken arc: the human named a tool nobody had built for yet, and they end with a green daemon that supports it — because the agent authored the plugin mid-setup and walked straight back into the runbook. No setup code was changed; the daemon stayed plugin-opaque; the bridge lived entirely in the agent's reasoning.
