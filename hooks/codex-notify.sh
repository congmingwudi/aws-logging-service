#!/usr/bin/env bash
# Codex hook -> aws-logging-service bridge.
#
# Reads a Codex lifecycle-hook JSON event from stdin and posts the same log
# shape as ~/.claude/hooks/claude-notify.sh. Logging settings come from Codex's
# shell_environment_policy. Logging failures never block Codex.

set -u

api_url="${LOGGING_API_URL:-}"
api_key="${LOGGING_API_KEY:-}"
channel="${LOGGING_CHANNEL:-}"

if [[ -z "$api_url" || -z "$api_key" ]]; then
  echo "codex-notify: LOGGING_API_URL and LOGGING_API_KEY must be set" >&2
  exit 0
fi

payload="$(cat)"
if [[ -z "$payload" ]]; then
  payload='{}'
fi

repo_dir="$(pwd)"
hook_event=""
summary=""
tool_name=""
if command -v jq >/dev/null 2>&1; then
  payload_cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
  if [[ -n "$payload_cwd" ]]; then
    repo_dir="$payload_cwd"
  fi
  hook_event="$(printf '%s' "$payload" | jq -r '.hook_event_name // .hookEventName // empty' 2>/dev/null || true)"
  summary="$(printf '%s' "$payload" | jq -r '
    .message
    // .stop_reason
    // .stopReason
    // .notification.message
    // .tool_response.summary
    // empty
  ' 2>/dev/null || true)"
  tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null || true)"
fi

repo_name="$(basename "$repo_dir")"
source_name="${LOGGING_SOURCE:-$repo_name}"

case "$hook_event" in
  Stop|SubagentStop) default_level="success" ;;
  PermissionRequest) default_level="notify" ;;
  "") default_level="notify" ;;
  *) default_level="info" ;;
esac
level="${LOGGING_LEVEL:-$default_level}"

if [[ -z "$summary" ]]; then
  case "$hook_event" in
    Stop) summary="Codex finished in $repo_name" ;;
    SubagentStop) summary="Codex subagent finished in $repo_name" ;;
    PermissionRequest) summary="Codex needs approval for ${tool_name:-a tool} in $repo_name" ;;
    *) summary="${hook_event:-Codex event} in $repo_name" ;;
  esac
fi

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if command -v jq >/dev/null 2>&1; then
  if printf '%s' "$payload" | jq -e 'type == "object"' >/dev/null 2>&1; then
    detail="$payload"
  else
    detail="$(jq -cn --arg raw "$payload" '{raw: $raw}')"
  fi
  body="$(jq -cn \
    --arg source "$source_name" \
    --arg level "$level" \
    --arg message "$summary" \
    --arg timestamp "$timestamp" \
    --arg channel "$channel" \
    --arg cwd "$repo_dir" \
    --arg hook "$hook_event" \
    --argjson detail "$detail" \
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
  >/dev/null 2>&1 || echo "codex-notify: curl failed" >&2

exit 0
