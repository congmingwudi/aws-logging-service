# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Service Overview

**aws-logging-service** is a general-purpose, minimal AWS Lambda logging API. Any
client can POST structured log events (error / warn / info / success / notify);
the service records them to CloudWatch and delivers notifications to one or
more explicit `targets` (currently only Slack channels, resolved through a
routing map). When `targets` is omitted, the service falls back to routing by
`source` plus a default webhook.

It was originally built to support the TDX '26 Mega Demo but is now the primary
logging endpoint across projects.

### Request Flow
```
Any client
  ↓ POST /log (X-Api-Key header)
API Gateway REST (request body validated against Models schema in template.yaml)
  ↓
Lambda Function (Node.js 22, arm64)
  ├→ stdout → CloudWatch Logs (90-day retention)
  └→ fetch  → Target dispatch:
              • Explicit `targets` → deliver only to those targets
                (slack channels resolved via the routes map in SSM Parameter Store)
              • Absent `targets`  → source-based route + default SLACK_WEBHOOK_URL
```

### Request Format
```json
POST /log
X-Api-Key: <api-key>
Content-Type: application/json

{
  "source": "mega-demo",
  "level": "error|warn|info|success|notify",
  "message": "Human-readable message",
  "timestamp": "2026-07-11T18:22:04.123Z",
  "detail": "optional string or object",
  "targets": [
    { "type": "slack", "channel": "claude-notify" }
  ]
}
```

The canonical schema is defined in two places that must stay in sync:
- `openapi.yaml` — documentation-facing OpenAPI 3 spec
- `template.yaml` (`LoggingApi.Properties.Models.LogEvent`) — JSON Schema used
  by API Gateway to validate request bodies at the edge

When adding a field, update BOTH. All fields are optional; the handler applies
defaults.

## Build & Deployment Commands

| Task | Command |
|------|---------|
| Build Lambda artifact | `sam build` |
| Deploy to AWS | `sam deploy --parameter-overrides "SlackWebhookUrl=..." "ApiKeyValue=..."` |
| Redeploy after code changes | `sam build && sam deploy --parameter-overrides "SlackWebhookUrl=..." "ApiKeyValue=..."` |
| Add/change a Slack route | `aws ssm put-parameter --name /mega-demo-logging/slack-webhook-routes --type String --overwrite --value '{"key":"https://hooks.slack.com/..."}'` (no redeploy) |
| Verify deployment | `curl -X POST -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d '{"source":"test","level":"info","message":"test"}' <api-endpoint>/log` |
| Teardown stack | `aws cloudformation delete-stack --stack-name mega-demo-logging --region us-west-2` |

The routes map is a JSON object mapping route key (source name or channel
name) → webhook URL, or → array of URLs, stored in SSM Parameter Store (not a
deploy parameter — see below). Example:

```bash
aws ssm put-parameter --name /mega-demo-logging/slack-webhook-routes \
  --type String --overwrite \
  --value '{"mega-demo":"https://hooks.slack.com/.../a","claude-notify":"https://hooks.slack.com/.../b"}'
```

**Adding/changing a Slack route does not require `sam deploy`.** Routing
changes are a single `aws ssm put-parameter --overwrite` call; the handler
caches the routes map in memory for 60s, so changes land without a redeploy
or even a cold start. `--overwrite` replaces the whole map — always include
every key you want to keep.

**Gotcha:** `sam deploy --parameter-overrides` splits on commas in its
shorthand parser, so a JSON parameter value containing more than one comma
silently truncates (no error) — this is exactly why Slack routing moved out
of a deploy parameter and into SSM. If a future parameter needs comma-bearing
JSON, pass it via a parameters file (`aws cloudformation deploy
--parameter-overrides file://params.json`) instead of inline shorthand.

## Architecture & Key Components

### Single Handler: `src/handler.mjs`

The entire application logic lives in one file:

1. **API Key Authentication**
   - Extracts X-Api-Key header (case-insensitive)
   - Compares against `API_KEY` environment variable
   - Returns 401 if mismatch

2. **Body Parse**
   - API Gateway has already validated the request body against `LogEvent`
     before the Lambda runs — the handler still `JSON.parse`s defensively and
     returns 400 on malformed input.
   - Defaults: `source="unknown"`, `level="error"`, `message="(no message)"`
   - `timestamp` (optional, ISO 8601): falls back to `new Date().toISOString()` when omitted or blank

3. **CloudWatch Logging**
   - Logs a JSON object to stdout with `timestamp` field (client-supplied or server-stamped)
   - Lambda captures stdout → CloudWatch Logs group

4. **Target Dispatch**
   - `getWebhookRoutes()` fetches the routes map from SSM Parameter Store
     (`SLACK_WEBHOOK_ROUTES_PARAMETER_NAME`) and caches it in module-level
     memory for 60s — most invocations reuse the cached map rather than
     hitting SSM on every request. On SSM error, falls back to the last
     known good value (or `{}` if none fetched yet) rather than failing the
     request.
   - `resolveTargets(routes, targets, source)` returns the list of webhook URLs:
     - `targets` array present → dispatch each entry by `type`. For `type: "slack"`,
       resolve `channel` against the routes map. Unknown types or
       unresolvable channels are logged and skipped — explicit targets NEVER
       silently fall back to the default (that would defeat the point of being explicit).
       An empty array is valid = CloudWatch-only.
     - `targets` absent → implicit routing: source-matched route + default `SLACK_WEBHOOK_URL`
   - Adding a new target kind = add a branch in `resolveTargets` and a matching
     dispatcher, plus extend the schema in both `template.yaml` and `openapi.yaml`.
   - All webhooks are POSTed in parallel with `Promise.all`.
   - Emoji indicator per level (green for success, bell for notify, plus the originals).

**Important:** Slack webhook failures don't cause HTTP 5xx — they're logged but
the client gets 200. This ensures the logging API remains available even if
Slack is down.

### Infrastructure: `template.yaml`

AWS SAM template defining:

- **Lambda Function Properties:**
  - Runtime: Node.js 22.x
  - Memory: 128 MB
  - Timeout: 10 seconds
  - Architecture: arm64
  - Function name: `mega-demo-logger` (kept for backwards compat with existing deployments)
  - Handler: `src/handler.handler`

- **API Gateway (REST):**
  - Name: `mega-demo-logging-api`
  - Stage: `prod`
  - CORS enabled for POST and OPTIONS with Content-Type and X-Api-Key headers
  - Route: POST /log with `RequestModel: {Model: LogEvent, Required: true, ValidateBody: true}`
  - `Models.LogEvent` — JSON Schema for the request body

- **CloudWatch Log Group:**
  - Auto-created at `/aws/lambda/mega-demo-logger`
  - 90-day retention policy

- **Parameters (must be passed at deploy time):**
  - `SlackWebhookUrl` - Default Slack incoming webhook URL
  - `SlackWebhookRoutesParameterName` - Name of the SSM parameter holding the
    routes map JSON (defaults to `/mega-demo-logging/slack-webhook-routes`).
    The routes map itself is *not* a deploy parameter — it's set separately
    via `aws ssm put-parameter`.
  - `ApiKeyValue` - Secret API key
- **IAM:** `LoggingFunction`'s execution role has an inline policy granting
  `ssm:GetParameter` scoped to exactly the one parameter ARN named by
  `SlackWebhookRoutesParameterName`.

### Deployment Config: `samconfig.toml`

SAM configuration for deploy defaults:
- Stack name: `mega-demo-logging`
- Region: `us-west-2`
- Auto-confirm changeset (confirm_changeset = false)
- IAM capability enabled

Parameters are intentionally left empty in config — pass via CLI `--parameter-overrides` flag to avoid committing secrets. See `feedback_secrets.md` in the memory index.

## Environment Variables

| Variable | Purpose | Source |
|----------|---------|--------|
| `SLACK_WEBHOOK_URL` | Default webhook (used when no route matches) | Template parameter |
| `SLACK_WEBHOOK_ROUTES_PARAMETER_NAME` | Name of the SSM parameter holding the routes map | Template parameter (default `/mega-demo-logging/slack-webhook-routes`) |
| `API_KEY` | Secret key clients must provide in X-Api-Key | Template parameter |

The routes map itself (JSON: source/channel → webhook URL or array of URLs)
lives in SSM Parameter Store at the name above, fetched by the handler at
runtime and cached in-memory for 60s — it is not an env var and updating it
does not require a redeploy.

## Claude Code Notification Hook

`hooks/claude-notify.sh` — POSIX bash script that reads a Claude Code hook
JSON payload on stdin and POSTs it to `/log`. Designed to be wired into
`~/.claude/settings.json` (global) or a project's `.claude/settings.json` under
the `Stop`, `SubagentStop`, and `Notification` events so Slack gets a ping when
Claude finishes work or needs input.

Environment contract:
- `LOGGING_API_URL` (required) — full URL to `/log`
- `LOGGING_API_KEY` (required) — X-Api-Key value
- `LOGGING_CHANNEL` (optional) — routing key sent as `channel` in the body (e.g. `claude-notify`)
- `LOGGING_SOURCE` (optional) — overrides the auto-derived source (defaults to `basename $PWD`)
- `LOGGING_LEVEL` (optional) — force a specific level; otherwise derived from the hook event name

The script is failure-silent (never blocks Claude) and prefers `jq` for safe
JSON assembly, falling back to a minimal hand-built body if `jq` is missing.

## Design Patterns & Decisions

1. **No Dependencies** — Uses only Node.js built-in `fetch` (native in Node 22). Reduces attack surface and cold start time.
2. **Fail-Soft Slack Integration** — Slack webhook errors are logged but don't break the logging API response.
3. **Schema Duplication** — Request schema is deliberately mirrored in `openapi.yaml` (docs) and `template.yaml` (enforced by API Gateway). API Gateway does the actual validation at the edge; OpenAPI is authoritative for humans and client generators.
4. **Route Fan-Out** — Slack routing is data-configured (an SSM Parameter Store JSON map) rather than code-configured, so onboarding a new consumer project is a single `aws ssm put-parameter` call, not a code change or a deploy.
5. **Discriminated Target Union** — The `targets` field is a list of `{type, ...}` entries. `type` is the discriminator; today only `slack` is defined. Adding future kinds (email, generic webhook, PagerDuty, etc.) doesn't require breaking existing clients — they just add a new arm.
6. **Client Never Sends Raw Webhook URLs** — Slack target `channel` is a key resolved server-side against the routes map in SSM. Clients can't POST to arbitrary webhooks; the service owns the whitelist. Unknown keys are logged and skipped.
7. **Explicit vs Implicit Routing** — When a client sends `targets`, that is the *authoritative* delivery list — the service won't quietly add the default webhook on top. This lets clients opt out of the default (e.g., `targets: []` for CloudWatch-only) and prevents surprise fan-out.
8. **Flexible Detail Field** — Accepts string or object; objects are JSON-stringified for Slack. Allows both stacktraces and structured error objects.
9. **API Key in Header** — Uses X-Api-Key (not URL parameter or body) to avoid logging credentials in CloudWatch Logs.
10. **ARM64 Architecture** — Better Lambda cost efficiency (Graviton).
11. **90-Day CloudWatch Retention** — Balances operational visibility with AWS log storage costs.

## Integration with Consumer Projects

### Mega-Demo App (browser client)
1. `VITE_LOGGING_API_URL` = the Lambda API endpoint
2. `VITE_LOGGING_API_KEY` = the generated API key
3. Emits `{source:"mega-demo", level:"error", ...}` on errors

### Any project via Claude Code hook
1. Add a `claude-notify` entry to the routes map in SSM (`aws ssm put-parameter ...`, no redeploy)
2. Set `LOGGING_API_URL`, `LOGGING_API_KEY`, `LOGGING_CHANNEL=claude-notify` in the project's `.claude/settings.json` `env` block
3. Register `hooks/claude-notify.sh` under `Stop` / `SubagentStop` / `Notification`

## Testing & Verification

After `sam deploy`, test with:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <your-api-key>" \
  -d '{"source":"test","level":"info","message":"deploy smoke test"}' \
  https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log
```

Expected response: `{"ok":true}` and a message in the target Slack channel within seconds.

Check CloudWatch logs:
```bash
aws logs tail /aws/lambda/mega-demo-logger --follow --region us-west-2
```
