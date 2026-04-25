# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Service Overview

**aws-logging-service** is a minimal AWS Lambda serverless logging API that receives error/warning/info events from the TDX '26 Mega Demo app, logs them to CloudWatch, and posts notifications to Slack.

### Request Flow
```
Browser Client
  ↓ POST /log (X-Api-Key header)
API Gateway (us-west-1)
  ↓
Lambda Function (Node.js 22, arm64)
  ├→ stdout → CloudWatch Logs (90-day retention)
  └→ fetch → Slack Incoming Webhook → #logs channel
```

### Request Format
```json
POST /log
X-Api-Key: <api-key>
Content-Type: application/json

{
  "source": "mega-demo",
  "level": "error|warn|info",
  "message": "Human-readable message",
  "detail": "optional string or object"
}
```

## Build & Deployment Commands

| Task | Command |
|------|---------|
| Build Lambda artifact | `sam build` |
| Deploy to AWS | `sam deploy --parameter-overrides "SlackWebhookUrl=..." "ApiKeyValue=..."` |
| Redeploy after code changes | `sam build && sam deploy --parameter-overrides "SlackWebhookUrl=..." "ApiKeyValue=..."` |
| Verify deployment | `curl -X POST -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d '{"source":"test","level":"info","message":"test"}' <api-endpoint>/log` |
| Teardown stack | `aws cloudformation delete-stack --stack-name mega-demo-logging --region us-west-1` |

## Setup Prerequisites

- AWS CLI configured (`aws sts get-caller-identity` to verify)
- AWS SAM CLI installed (`sam --version` to verify)
- Generate API key: `openssl rand -hex 32`
- Slack incoming webhook URL (from api.slack.com)

## Architecture & Key Components

### Single Handler: `src/handler.mjs`

The entire application logic lives in one file with four main steps:

1. **API Key Authentication** (line 12-18)
   - Extracts X-Api-Key header (case-insensitive)
   - Compares against `API_KEY` environment variable
   - Returns 401 if mismatch

2. **JSON Parsing & Validation** (line 20-25)
   - Parses request body JSON
   - Returns 400 on invalid JSON
   - Defaults: source="unknown", level="error", message="(no message)"

3. **CloudWatch Logging** (line 29-33)
   - Logs JSON object to stdout with ISO timestamp
   - Lambda automatically captures stdout → CloudWatch Logs group

4. **Slack Notification** (line 35-60)
   - Formats message with emoji indicator (red/yellow/blue circle for error/warn/info)
   - Sends POST to SLACK_WEBHOOK_URL with formatted payload
   - Handles both string and object details (pretty-printed)
   - Errors logged to CloudWatch but don't fail the response

**Important:** Slack webhook failures don't cause HTTP 5xx — they're logged but the client gets 200. This ensures logging API availability isn't dependent on Slack availability.

### Infrastructure: `template.yaml`

AWS SAM template defining:

- **Lambda Function Properties:**
  - Runtime: Node.js 22.x
  - Memory: 128 MB
  - Timeout: 10 seconds
  - Architecture: arm64
  - Function name: `mega-demo-logger`
  - Handler: `src/handler.handler`

- **API Gateway:**
  - Name: `mega-demo-logging-api`
  - Stage: `prod`
  - CORS enabled for POST and OPTIONS with Content-Type and X-Api-Key headers
  - Route: POST /log

- **CloudWatch Log Group:**
  - Auto-created at `/aws/lambda/mega-demo-logger`
  - 90-day retention policy

- **Parameters (must be passed at deploy time):**
  - `SlackWebhookUrl` - Slack incoming webhook URL
  - `ApiKeyValue` - Secret API key

### Deployment Config: `samconfig.toml`

SAM configuration for deploy defaults:
- Stack name: `mega-demo-logging`
- Region: `us-west-1`
- Auto-confirm changeset (confirm_changeset = false)
- IAM capability enabled

Parameters are intentionally left empty in config — pass via CLI `--parameter-overrides` flag to avoid committing secrets.

## Environment Variables

| Variable | Purpose | Source |
|----------|---------|--------|
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for #logs | Template parameter, set at deploy |
| `API_KEY` | Secret key clients must provide | Template parameter, set at deploy |

At runtime, these are injected into the Lambda function environment (line 30-32 of template.yaml).

## Design Patterns & Decisions

1. **No Dependencies** — Uses only Node.js built-in `fetch` API (native in Node 22) and no npm packages. Reduces attack surface and cold start time.

2. **Fail-Soft Slack Integration** — Slack webhook errors are logged but don't break the logging API response. Ensures the service remains available even if Slack is down.

3. **Flexible Detail Field** — Accepts string or object for detail, auto-formats objects as JSON. Allows both stacktraces and structured error objects.

4. **API Key in Header** — Uses X-Api-Key header (not URL parameter or body) to avoid logging credentials in CloudWatch Logs.

5. **ARM64 Architecture** — Specified for better Lambda cost efficiency (Graviton processors are cheaper).

6. **90-Day CloudWatch Retention** — Balances operational visibility with AWS log storage costs.

## Integration with Mega-Demo App

The Mega Demo app sends logs to this service by:

1. Setting `VITE_LOGGING_API_URL` = the Lambda API endpoint from SAM deploy output
2. Setting `VITE_LOGGING_API_KEY` = the generated API key
3. POSTing to the endpoint when errors occur (e.g., ElevenLabs TTS failures)

## Testing & Verification

After `sam deploy`, the output includes the API endpoint URL. Test with:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <your-api-key>" \
  -d '{"source":"test","level":"info","message":"deploy smoke test"}' \
  https://<api-id>.execute-api.us-west-1.amazonaws.com/prod/log
```

Expected response: `{"ok":true}` and a message in Slack #logs within seconds.

Check CloudWatch logs:
```bash
aws logs tail /aws/lambda/mega-demo-logger --follow --region us-west-1
```
