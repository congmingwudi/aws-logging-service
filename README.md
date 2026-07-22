# aws-logging-service

A minimal, dependency-free serverless logging API — the single logging endpoint
across all of my projects.

Any client (browser app, Node.js service, CLI tool, Claude Code hook, cron job,
…) POSTs a structured log event with a shared API key. The service:

1. Writes it to CloudWatch Logs (90-day retention).
2. Delivers a Slack notification to one or more channels — either explicit
   destinations chosen by the client (`targets`) or a default route based on
   the client's `source`.

Originally built for the TDX '26 Mega Demo, now the primary logging service
for anything that needs "tell me in Slack when X happened, and keep a searchable
record of it."

## Design goals

- **One endpoint, many callers.** Every project points at the same URL and
  key. No per-project infrastructure.
- **Data-configured fan-out.** Routing lives in a JSON parameter
  (`SlackWebhookRoutes`), not in code. Adding a new destination = updating the
  deploy parameter, not editing the handler.
- **Callers choose the destination, but not the URL.** A client says
  `{"type":"slack","channel":"claude-notify"}` and the service resolves that key
  server-side. Clients can never POST to arbitrary webhooks — the service owns
  the whitelist.
- **Explicit routing wins; implicit routing is safe.** If a client sends
  `targets`, that is exactly where the event goes. If they omit it, the service
  falls back to source-based routing plus the default webhook (matching the
  original Mega Demo behavior).
- **Extensible target types.** `targets` is a discriminated union on `type`
  — currently `slack` is the only kind, but future kinds (email, generic
  webhook, PagerDuty, SMS…) plug in without breaking existing clients.
- **Fail-soft.** Notification failures are logged but never turn into HTTP 5xx.
  A Slack outage doesn't take the logging API down with it.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 22.x (ESM) |
| Compute | AWS Lambda (arm64 / Graviton) |
| API | AWS API Gateway REST API (with request body validation) |
| Logging | AWS CloudWatch Logs (90-day retention) |
| Notifications | Slack Incoming Webhooks (extensible to other targets) |
| IaC | AWS SAM (CloudFormation) |
| Region | us-west-2 |

No npm dependencies — uses only the Node.js 22 built-in `fetch` API.

## Architecture

```
Any client
  → POST /log  (X-Api-Key header)
    → API Gateway (validates body against schema in template.yaml)
      → Lambda Function (Node.js 22, arm64, 128 MB)
          ├─ stdout → CloudWatch Logs  (/aws/lambda/mega-demo-logger, 90-day retention)
          └─ Target dispatch:
             • `targets` present → deliver to those and only those
             • `targets` absent  → source-based route + default SlackWebhookUrl
             Slack channel keys are resolved server-side via SLACK_WEBHOOK_ROUTES.
```

Everything lives in one Lambda function (`src/handler.mjs`). Infrastructure is
`template.yaml` (AWS SAM). The stack name is `mega-demo-logging` (kept for
backwards compatibility with the deployed API URL that clients already point at).

The canonical request schema is in [`openapi.yaml`](./openapi.yaml) and is
mirrored into API Gateway's request model in `template.yaml`.

## Request Format

```json
POST /log
X-Api-Key: <your-api-key>
Content-Type: application/json

{
  "source":    "mega-demo",
  "level":     "error|warn|info|success|notify",
  "message":   "Human-readable description",
  "timestamp": "2026-07-11T18:22:04.123Z",
  "detail":    "optional string or object",
  "targets":   [
    { "type": "slack", "channel": "claude-notify" }
  ]
}
```

All fields are optional. Behavior when omitted:

| Field | Default |
|-------|---------|
| `source` | `"unknown"` |
| `level` | `"error"` |
| `message` | `"(no message)"` |
| `timestamp` | server's receipt time |
| `detail` | omitted |
| `targets` | implicit routing (see below) |

## Targets and routing

### Target types

Each entry in `targets` is a discriminated union on `type`. Today only `slack`
is supported.

**Slack target**
```json
{ "type": "slack", "channel": "claude-notify" }
```

`channel` is a **key** into the service's `SLACK_WEBHOOK_ROUTES` map — not a raw
webhook URL, and not a literal Slack channel name. Deploy the routes as a JSON
string parameter:

```json
{
  "mega-demo":     "https://hooks.slack.com/services/AAA/BBB/CCC",
  "claude-notify": "https://hooks.slack.com/services/AAA/BBB/DDD",
  "billing-alerts": ["https://hooks.slack.com/.../ops", "https://hooks.slack.com/.../finance"]
}
```

Each Slack incoming webhook URL is bound to exactly one channel — that binding
is fixed on Slack's side when you create the webhook, and the service has no
way to redirect a URL to a different channel at request time.

**A route key mapping to an array is a fan-out, not a menu.** `"billing-alerts":
[urlA, urlB]` means every event routed to `billing-alerts` posts to *both*
channels A and B, every time — the client doesn't pick which one, it always
gets the union. Use this when one logical event should always mirror to
multiple fixed channels together (e.g. `#eng-oncall` and `#status-page`).

**If you want a client to choose between distinct channels**, give each
channel its own route key, and have the client pass the specific key it wants:

```json
{
  "billing-alerts-eng":     "https://hooks.slack.com/.../eng",
  "billing-alerts-finance": "https://hooks.slack.com/.../finance"
}
```

```json
{ "type": "slack", "channel": "billing-alerts-eng" }
```

### Resolution rules

- **`targets` present** → deliver ONLY to the listed targets. Unresolvable
  entries (unknown `type`, unknown Slack channel key, missing required fields)
  are logged and skipped. `targets: []` is valid and means "CloudWatch only."
- **`targets` absent** → implicit routing: if `source` matches a route key,
  deliver to those webhook(s) plus the default; otherwise deliver only to the
  default `SlackWebhookUrl`. This matches pre-`targets` behavior — legacy
  clients (like the Mega Demo) work unchanged.

### Adding future target kinds

To add e.g. `email`:
1. Add a new arm in `openapi.yaml`'s `Target` schema (`EmailTarget` component).
2. Extend `template.yaml`'s `Models.LogEvent.properties.targets.items.properties` to include the new fields.
3. Add a dispatch branch in `resolveTargets()` inside `src/handler.mjs`.
4. Bump the OpenAPI version and redeploy.

Existing clients keep working because they never send the new `type`.

## Deployment

### Prerequisites

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured (`aws configure` or SSO)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

Verify both:
```bash
aws sts get-caller-identity
sam --version
```

### 1. Generate an API key (first deploy only)

```bash
openssl rand -hex 32
```

Save it — you'll use it as `ApiKeyValue` below and as `LOGGING_API_KEY` in every
client. Rotating this later requires updating every consumer, so store it in a
password manager.

### 2. Create Slack webhooks

For each Slack channel you want the service to deliver to (personal `#logs`,
`claude-notify`, project-specific channels, …), create an incoming webhook at
[api.slack.com/apps](https://api.slack.com/apps) → your app → Incoming Webhooks →
Add New Webhook to Workspace → pick the channel → copy the URL.

### 3. Build and deploy

```bash
sam build && sam deploy --parameter-overrides \
  "SlackWebhookUrl=<default-webhook-url>" \
  "SlackWebhookRoutes={\"claude-notify\":\"https://hooks.slack.com/services/.../claude-channel\"}" \
  "ApiKeyValue=<your-generated-key>"
```

The `SlackWebhookRoutes` parameter is optional (defaults to `{}`) but is what
lets clients target specific channels.

SAM will print the API endpoint at the end:
```
Outputs:
  ApiEndpoint  https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log
```

### 4. Smoke test

```bash
# Legacy path — no targets, uses source-based default routing:
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <your-api-key>" \
  -d '{"source":"test","level":"info","message":"deploy smoke test"}' \
  https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log

# Explicit target — should hit ONLY the claude-notify channel:
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <your-api-key>" \
  -d '{"source":"test","level":"success","message":"targets test","targets":[{"type":"slack","channel":"claude-notify"}]}' \
  https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log
```

Both should return `{"ok":true}` and post to the corresponding Slack channels.

Check CloudWatch logs:
```bash
aws logs tail /aws/lambda/mega-demo-logger --follow --region us-west-2
```

### 5. Redeployment

After any changes to `src/handler.mjs` or `template.yaml`:

```bash
sam build && sam deploy --parameter-overrides \
  "SlackWebhookUrl=..." "SlackWebhookRoutes=..." "ApiKeyValue=..."
```

The `samconfig.toml` file leaves `parameter_overrides` empty by design — pass
secrets on the CLI only, never commit them.

## Wiring in a client app (browser / Node)

```
LOGGING_API_URL=https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log
LOGGING_API_KEY=<your-generated-key>
```

Post errors / events with `fetch`:

```js
await fetch(process.env.LOGGING_API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.LOGGING_API_KEY },
  body: JSON.stringify({
    source: 'my-app',
    level: 'error',
    message: 'thing broke',
    detail: { stack: err.stack },
    // Optional: explicit target
    // targets: [{ type: 'slack', channel: 'claude-notify' }],
  }),
});
```

Vite apps use `VITE_LOGGING_API_URL` / `VITE_LOGGING_API_KEY` so the values are
exposed to the browser bundle.

## Claude Code notification hook

The repo ships a POSIX bash script — `hooks/claude-notify.sh` — that reads a
Claude Code hook event on stdin and POSTs a log event to this service, to get
Slack pings when Claude finishes a task, a subagent completes, or Claude is
awaiting input.

### Install the hook once, globally — don't reference this repo's path

**Decision:** the hook is registered exactly once, in the *global*
`~/.claude/settings.json`, pointing at a copy of the script under
`~/.claude/hooks/`. Individual projects only set a `LOGGING_CHANNEL` env
override — they never register the hook or point at this repo's checkout.

Why: pointing a project's `.claude/settings.json` directly at
`<this-repo>/hooks/claude-notify.sh` makes that project's hook wiring depend
on this specific repo still existing at that exact path on that exact
machine. Move, rename, or delete this checkout and every project referencing
it breaks silently (the script fails soft by design, so you may not notice).
It also doesn't generalize across machines — a fresh clone of a project has
no reason to know where you happen to keep `aws-logging-service` checked out.
Copying the script to a stable, hook-dedicated location and registering it
once avoids both problems, and matches how other global hooks on this machine
are already organized (e.g. `~/.aisuite/hooks/`, `~/.devbar/bin/`).

**1. One-time service configuration:**

Create a new Slack incoming webhook pointing at the channel you want Claude
notifications in, then redeploy the service with a `SlackWebhookRoutes` entry
for `claude-notify` (or any key name you prefer — this doc uses `claude-notify`
consistently):

```bash
sam build && sam deploy --parameter-overrides \
  "SlackWebhookUrl=<default-webhook>" \
  "SlackWebhookRoutes={\"claude-notify\":\"<claude-channel-webhook>\"}" \
  "ApiKeyValue=<your-api-key>"
```

**2. Install the script into the global hooks directory:**

```bash
mkdir -p ~/.claude/hooks
cp hooks/claude-notify.sh ~/.claude/hooks/claude-notify.sh
chmod +x ~/.claude/hooks/claude-notify.sh
```

This repo remains the source of truth for edits to the script — re-run the
copy step after pulling changes. The deployed copy under `~/.claude/hooks/`
is what every project's hook actually invokes.

**3. Register the hook and shared credentials once, in `~/.claude/settings.json`:**

```json
{
  "env": {
    "LOGGING_API_URL": "https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log",
    "LOGGING_API_KEY": "<your-api-key>"
  },
  "hooks": {
    "Stop":         [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/<you>/.claude/hooks/claude-notify.sh"}]}],
    "SubagentStop": [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/<you>/.claude/hooks/claude-notify.sh"}]}],
    "Notification": [{"matcher": "", "hooks": [{"type": "command", "command": "/Users/<you>/.claude/hooks/claude-notify.sh"}]}]
  }
}
```

Every Claude Code session on the machine will now send hook events. Merge
these entries into any hooks/env you already have configured — don't
overwrite existing arrays under `Stop`/`SubagentStop`/`Notification`, append
to them instead.

**4. Per-project: only set the routing/labeling overrides you need.**

In `<project>/.claude/settings.local.json` (untracked; keep secrets and
machine-specific config out of the tracked `settings.json`):

```json
{
  "env": {
    "LOGGING_CHANNEL": "claude-notify"
  }
}
```

Project-level `env` merges with global `env`, so the URL/key are inherited and
each project only overrides `LOGGING_CHANNEL` (and optionally `LOGGING_SOURCE`
/ `LOGGING_LEVEL` — see the environment contract below). No project should
need to touch `hooks` or `LOGGING_API_URL`/`LOGGING_API_KEY` — those live in
the global config, set up once.

### Environment contract

The hook script reads these:

| Variable | Required | Purpose |
|----------|----------|---------|
| `LOGGING_API_URL` | yes | Full URL of the `/log` endpoint |
| `LOGGING_API_KEY` | yes | `X-Api-Key` header value |
| `LOGGING_CHANNEL` | no  | Slack channel key from `SLACK_WEBHOOK_ROUTES`. If set, the script emits `targets: [{type:"slack", channel: LOGGING_CHANNEL}]`. If unset, no `targets` is sent and the service falls back to source-based routing. |
| `LOGGING_SOURCE`  | no  | Override the event `source` (defaults to `basename $PWD`) |
| `LOGGING_LEVEL`   | no  | Force a specific level; otherwise derived from the hook event name |

### Level derivation

The script maps the Claude hook event to a log level:

| Hook event | Level sent | Slack indicator |
|------------|-----------|-----------------|
| `Stop` | `success` | :large_green_circle: |
| `SubagentStop` | `success` | :large_green_circle: |
| `Notification` (Claude awaiting input) | `notify` | :bell: |
| `PreToolUse` / `PostToolUse` | `info` | :large_blue_circle: |
| anything else | `info` | :large_blue_circle: |

Override with `LOGGING_LEVEL` in `env` if you want e.g. `notify` for `Stop` too.

### What ends up in Slack

- **Text:** `<emoji> *[<source>]* <summary>` where `<summary>` is the hook's
  `message` / `stop_reason` / `notification.message` (whichever the payload has),
  falling back to `"<hook_event> in <repo>"`.
- **Attachment (code block):** the full hook JSON, plus `cwd` and `hook_event`
  added by the script. Useful for debugging what triggered the ping.

### Failure behavior

The script exits `0` on any error (missing env vars, network failure, JSON parse
error). Claude Code is **never** blocked by a logging outage. Errors go to
stderr, which Claude Code surfaces in its hook logs.

### Prerequisites

- The hook script is executable (`chmod +x hooks/claude-notify.sh` — done in this repo).
- `bash` (macOS/Linux). Windows requires WSL or a bash-in-PATH.
- `jq` is optional but recommended (safer JSON escaping). Without it the script
  falls back to hand-built JSON.
- `curl` (standard on macOS and most Linux).

### Verifying the hook end-to-end

1. Configure `~/.claude/settings.json` per Option A above.
2. Start a Claude Code session in any directory and let it finish a task.
3. On `Stop`, you should see a green-circle message in your `claude-notify`
   channel within a couple of seconds.
4. In CloudWatch, `aws logs tail /aws/lambda/mega-demo-logger --region us-west-2`
   should show the corresponding structured log line with the full hook payload
   in `detail`.

## Codex notification hook

The repo also ships `hooks/codex-notify.sh` — the same idea as the Claude Code
hook, but for [Codex](https://openai.com/codex) lifecycle hooks. It reads a
Codex hook JSON event on stdin and POSTs the same log shape to this service,
so Codex sessions can ping Slack too (routed independently via its own
`SLACK_WEBHOOK_ROUTES` key, `codex-notify`, kept parallel to `claude-notify`).

### Credential reuse

Unlike the Claude hook, `codex-notify.sh` doesn't require its own copy of
`LOGGING_API_URL` / `LOGGING_API_KEY`. If those aren't set in the environment,
it falls back to reading `env.LOGGING_API_URL` / `env.LOGGING_API_KEY` /
`env.LOGGING_CHANNEL` out of `~/.claude/settings.json` (path overridable via
`CODEX_NOTIFY_SETTINGS`) via `jq`. This avoids duplicating the API key into a
second config file — set explicit environment variables in Codex's own hook
config only if you want Codex to use different credentials or a different
`LOGGING_CHANNEL` than Claude Code.

### One-time service configuration

Create a new Slack incoming webhook for the channel you want Codex
notifications in, then redeploy with a `codex-notify` entry in
`SlackWebhookRoutes` alongside any existing routes:

```bash
sam build && sam deploy --parameter-overrides \
  "SlackWebhookUrl=<default-webhook>" \
  "SlackWebhookRoutes={\"claude-notify\":\"<claude-channel-webhook>\",\"codex-notify\":\"<codex-channel-webhook>\"}" \
  "ApiKeyValue=<your-api-key>"
```

### Install the script

Codex reads its hook config from its own settings (outside this repo's
scope), but the script itself should live at a stable path the same way
`claude-notify.sh` does:

```bash
mkdir -p ~/.codex/hooks
cp hooks/codex-notify.sh ~/.codex/hooks/codex-notify.sh
chmod +x ~/.codex/hooks/codex-notify.sh
```

Point Codex's own hook configuration (e.g. its `Stop` / `PermissionRequest`
equivalents) at `~/.codex/hooks/codex-notify.sh`, and set `LOGGING_CHANNEL=codex-notify`
if you want Codex events routed to its own channel rather than inheriting
whatever `LOGGING_CHANNEL` Claude Code's settings specify.

### Level derivation

| Hook event | Level sent | Slack indicator |
|------------|-----------|-----------------|
| `Stop` | `success` | :large_green_circle: |
| `SubagentStop` | `success` | :large_green_circle: |
| `PermissionRequest` | `notify` | :bell: |
| anything else | `info` | :large_blue_circle: |

Override with `LOGGING_LEVEL` if you want different behavior.

### Failure behavior

Same fail-soft contract as `claude-notify.sh`: exits `0` on any error (missing
credentials, network failure), never blocks Codex, and logs errors to stderr.

## Teardown

```bash
aws cloudformation delete-stack --stack-name mega-demo-logging --region us-west-2
```

This deletes the API Gateway, Lambda, and CloudWatch log group. The Slack
webhooks themselves are not touched (revoke them in the Slack app dashboard if
you need to).
