# aws-logging-service

A minimal serverless logging API that receives events from the TDX '26 Mega Demo app, writes them to CloudWatch Logs, and posts notifications to Slack.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 22.x (ESM) |
| Compute | AWS Lambda (arm64 / Graviton) |
| API | AWS API Gateway HTTP API |
| Logging | AWS CloudWatch Logs (90-day retention) |
| Notifications | Slack Incoming Webhook |
| IaC | AWS SAM (CloudFormation) |
| Region | us-west-2 |

No npm dependencies — uses only the Node.js 22 built-in `fetch` API.

## Architecture

```
App (browser)
  → POST /log  (X-Api-Key header)
    → API Gateway HTTP API (us-west-2)
      → Lambda Function (Node.js 22, arm64, 128 MB)
          ├─ stdout → CloudWatch Logs  (/aws/lambda/mega-demo-logger, 90-day retention)
          └─ fetch  → Slack Incoming Webhook → #logs channel
```

The Lambda function (`src/handler.mjs`) handles everything in one file:
1. Validates the `X-Api-Key` header against the `API_KEY` environment variable
2. Parses and validates the JSON request body
3. Logs a structured JSON entry to stdout (captured by CloudWatch)
4. POSTs a formatted notification to Slack (failures are logged but don't affect the HTTP response)

Infrastructure is defined in `template.yaml` (AWS SAM). Stack name: `mega-demo-logging`.

## Request Format

```json
POST /log
X-Api-Key: <your-api-key>
Content-Type: application/json

{
  "source":  "mega-demo",
  "level":   "error|warn|info",
  "message": "Human-readable description",
  "detail":  "optional string or object"
}
```

## Deployment

### Prerequisites

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured (`aws configure`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

Verify both:
```bash
aws sts get-caller-identity
sam --version
```

### 1. Generate an API key

```bash
openssl rand -hex 32
```

Save this — you'll use it as `ApiKeyValue` below and as `VITE_LOGGING_API_KEY` in the client app.

### 2. Build and deploy

```bash
sam build && sam deploy --parameter-overrides "SlackWebhookUrl=<your-slack-webhook-url> ApiKeyValue=<your-generated-key>"
```

Both overrides must be in a single quoted string, space-separated.

SAM will print the API endpoint at the end:
```
Outputs:
  ApiEndpoint  https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log
```

### 3. Smoke test

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <your-api-key>" \
  -d '{"source":"test","level":"info","message":"deploy smoke test"}' \
  https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log
```

Expected: `{"ok":true}` response and a message in Slack `#logs` within seconds.

Check CloudWatch logs:
```bash
aws logs tail /aws/lambda/mega-demo-logger --follow --region us-west-2
```

### 4. Wire up the client app

Set these environment variables in the consuming app:
```
VITE_LOGGING_API_URL=https://<api-id>.execute-api.us-west-2.amazonaws.com/prod/log
VITE_LOGGING_API_KEY=<your-generated-key>
```

## Redeployment

After any changes to `src/handler.mjs` or `template.yaml`:

```bash
sam build && sam deploy --parameter-overrides "SlackWebhookUrl=<your-slack-webhook-url> ApiKeyValue=<your-api-key>"
```

## Teardown

```bash
aws cloudformation delete-stack --stack-name mega-demo-logging --region us-west-2
```
