const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const EXPECTED_API_KEY = process.env.API_KEY;

const LEVEL_EMOJI = {
  error: ':red_circle:',
  warn:  ':large_yellow_circle:',
  info:  ':large_blue_circle:',
};

export async function handler(event) {
  // API key check
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

  const { source = 'unknown', level = 'error', message = '(no message)', detail } = body;
  const emoji = LEVEL_EMOJI[level] ?? ':white_circle:';
  const ts = new Date().toISOString();

  // CloudWatch — Lambda stdout is automatically captured
  const logLine = { ts, source, level, message, ...(detail !== undefined && { detail }) };
  console.log(JSON.stringify(logLine));

  // Slack
  if (!SLACK_WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL not set — skipping Slack notification');
  } else {
    const detailBlock = detail
      ? `\n\`\`\`${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}\`\`\``
      : '';

    const slackPayload = {
      text: `${emoji} *[${source}]* ${message}${detailBlock}`,
      unfurl_links: false,
    };

    try {
      const resp = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackPayload),
      });
      if (!resp.ok) {
        console.error('Slack webhook failed:', resp.status, await resp.text());
      }
    } catch (err) {
      console.error('Slack webhook threw:', err.message);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
}
