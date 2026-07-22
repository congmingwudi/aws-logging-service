import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const DEFAULT_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const EXPECTED_API_KEY = process.env.API_KEY;
const ROUTES_PARAMETER_NAME = process.env.SLACK_WEBHOOK_ROUTES_PARAMETER_NAME;
const ROUTES_CACHE_TTL_MS = 60_000;

const ssm = new SSMClient();
let routesCache = { value: {}, fetchedAt: 0 };

async function getWebhookRoutes() {
  if (!ROUTES_PARAMETER_NAME) return {};
  if (Date.now() - routesCache.fetchedAt < ROUTES_CACHE_TTL_MS) return routesCache.value;

  try {
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: ROUTES_PARAMETER_NAME }));
    routesCache = { value: parseRoutes(Parameter?.Value), fetchedAt: Date.now() };
  } catch (err) {
    console.error('Failed to fetch SLACK_WEBHOOK_ROUTES_PARAMETER_NAME from SSM — using last known routes:', err.message);
    routesCache = { ...routesCache, fetchedAt: Date.now() };
  }
  return routesCache.value;
}

const LEVEL_EMOJI = {
  error: ':red_circle:',
  warn:  ':large_yellow_circle:',
  info:  ':large_blue_circle:',
  success: ':large_green_circle:',
  notify:  ':bell:',
};

function parseRoutes(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn('SLACK_WEBHOOK_ROUTES must be a JSON object — ignoring');
  } catch (err) {
    console.warn('SLACK_WEBHOOK_ROUTES is not valid JSON — ignoring:', err.message);
  }
  return {};
}

// Resolve one Slack channel key against the routes map.
// Returns an array of webhook URLs (a channel may map to multiple).
function resolveSlackChannel(routes, channelKey) {
  const routed = routes[channelKey];
  if (!routed) return [];
  return Array.isArray(routed) ? routed : [routed];
}

// Default (implicit) routing when the request omits `targets`.
// Match today's behavior: source-based route + default webhook.
function defaultSlackWebhooks(routes, source) {
  const urls = new Set();
  for (const url of resolveSlackChannel(routes, source)) urls.add(url);
  if (DEFAULT_WEBHOOK_URL) urls.add(DEFAULT_WEBHOOK_URL);
  return [...urls];
}

async function postToSlack(url, payloadJson) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadJson,
    });
    if (!resp.ok) {
      console.error('Slack webhook failed:', resp.status, await resp.text());
    }
  } catch (err) {
    console.error('Slack webhook threw:', err.message);
  }
}

function buildSlackPayload({ source, message, detail, emoji }) {
  const detailBlock = detail
    ? `\n\`\`\`${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}\`\`\``
    : '';
  return JSON.stringify({
    text: `${emoji} *[${source}]* ${message}${detailBlock}`,
    unfurl_links: false,
  });
}

// Given the request's targets (or undefined for implicit routing), return the
// list of Slack webhook URLs to deliver to. Unknown target types are logged
// and skipped — explicit targets never silently fall back to the default.
function resolveTargets(routes, targets, source) {
  if (targets === undefined) {
    return defaultSlackWebhooks(routes, source);
  }
  if (!Array.isArray(targets)) return [];

  const urls = new Set();
  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    const type = target.type;

    if (type === 'slack') {
      const channelKey = target.channel;
      if (!channelKey || typeof channelKey !== 'string') {
        console.warn('slack target missing channel — skipping');
        continue;
      }
      const routed = resolveSlackChannel(routes, channelKey);
      if (routed.length === 0) {
        console.warn('slack target channel=%s not in webhook routes — skipping', channelKey);
        continue;
      }
      for (const url of routed) urls.add(url);
    } else {
      console.warn('Unknown target type=%s — skipping', type);
    }
  }
  return [...urls];
}

export async function handler(event) {
  const providedKey =
    event.headers?.['x-api-key'] ??
    event.headers?.['X-Api-Key'] ??
    '';
  if (providedKey !== EXPECTED_API_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const {
    source = 'unknown',
    level = 'error',
    message = '(no message)',
    detail,
    timestamp,
    targets,
  } = body;

  const emoji = LEVEL_EMOJI[level] ?? ':white_circle:';
  const eventTimestamp = typeof timestamp === 'string' && timestamp ? timestamp : new Date().toISOString();

  const logLine = {
    timestamp: eventTimestamp,
    source,
    level,
    message,
    ...(detail !== undefined && { detail }),
    ...(targets !== undefined && { targets }),
  };
  console.log(JSON.stringify(logLine));

  const routes = await getWebhookRoutes();
  const webhooks = resolveTargets(routes, targets, source);
  if (webhooks.length === 0) {
    if (targets === undefined) {
      console.warn('No Slack webhook configured for source=%s — skipping notification', source);
    }
    // else: explicit empty/unresolvable targets — CloudWatch-only is intentional
  } else {
    const payloadJson = buildSlackPayload({ source, message, detail, emoji });
    await Promise.all(webhooks.map((url) => postToSlack(url, payloadJson)));
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
}
