#!/usr/bin/env bash
# Claude Code hook → aws-logging-service bridge.
#
# Reads a Claude Code hook JSON event from stdin and POSTs a log event to the
# logging service. Route the resulting Slack notification with LOGGING_CHANNEL
# (a key in the service's SLACK_WEBHOOK_ROUTES map — sent as
# targets:[{type:"slack", channel:"..."}]).
#
# Required environment:
#   LOGGING_API_URL   — full URL to the /log endpoint
#   LOGGING_API_KEY   — X-Api-Key value
#
# Optional environment:
#   LOGGING_SOURCE    — event source name (default: derived from repo dir name)
#   LOGGING_CHANNEL   — Slack channel key from SLACK_WEBHOOK_ROUTES
#   LOGGING_LEVEL     — override the level (default: derived from hook event)
#
# Failure policy: any error is written to stderr but exits 0 — Claude Code
# should never be blocked by a logging outage.

set -u

api_url="${LOGGING_API_URL:-}"
api_key="${LOGGING_API_KEY:-}"
if [[ -z "$api_url" || -z "$api_key" ]]; then
  echo "claude-notify: LOGGING_API_URL and LOGGING_API_KEY must be set" >&2
  exit 0
fi

payload="$(cat)"
if [[ -z "$payload" ]]; then
  payload='{}'
fi

repo_dir="$(pwd)"
repo_name="$(basename "$repo_dir")"
source_name="${LOGGING_SOURCE:-$repo_name}"
channel="${LOGGING_CHANNEL:-}"

hook_event=""
summary=""
if command -v jq >/dev/null 2>&1; then
  hook_event="$(printf '%s' "$payload" | jq -r '.hook_event_name // .hookEventName // empty' 2>/dev/null || true)"
  summary="$(printf '%s' "$payload" | jq -r '
    .message
    // .stop_reason
    // .notification.message
    // .tool_response.summary
    // empty
  ' 2>/dev/null || true)"
fi

case "$hook_event" in
  Stop|SubagentStop) default_level="success" ;;
  Notification)      default_level="notify"  ;;
  PreToolUse|PostToolUse) default_level="info" ;;
  "")                default_level="notify"  ;;
  *)                 default_level="info"    ;;
esac
level="${LOGGING_LEVEL:-$default_level}"

if [[ -z "$summary" ]]; then
  summary="${hook_event:-Claude Code event} in $repo_name"
fi

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if command -v jq >/dev/null 2>&1; then
  body="$(jq -cn \
    --arg source "$source_name" \
    --arg level "$level" \
    --arg message "$summary" \
    --arg timestamp "$timestamp" \
    --arg channel "$channel" \
    --arg cwd "$repo_dir" \
    --arg hook "$hook_event" \
    --argjson detail "$payload" \
    '{
      source: $source,
      level: $level,
      message: $message,
      timestamp: $timestamp,
      detail: ($detail + {cwd: $cwd, hook_event: $hook})
    }
    + (if $channel == "" then {} else {targets: [{type: "slack", channel: $channel}]} end)')"
else
  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  body="{\"source\":\"$(esc "$source_name")\",\"level\":\"$(esc "$level")\",\"message\":\"$(esc "$summary")\",\"timestamp\":\"$timestamp\""
  if [[ -n "$channel" ]]; then
    body="$body,\"targets\":[{\"type\":\"slack\",\"channel\":\"$(esc "$channel")\"}]"
  fi
  body="$body,\"detail\":\"$(esc "$payload")\"}"
fi

curl --silent --show-error --max-time 5 \
  --output /dev/null \
  -X POST "$api_url" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $api_key" \
  --data "$body" \
  >/dev/null 2>&1 || echo "claude-notify: curl failed" >&2

exit 0
