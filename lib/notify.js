// ====================================================================
// lib/notify.js — Slack alerts for bridge errors and dead-man's-switch
// ====================================================================

const { request } = require('./http');

async function alert(message, context = {}) {
  // Always log first, at error level, so the alert survives a missing or
  // broken Slack webhook. `vercel logs` is the floor, Slack is the bonus.
  console.error('[bridge:alert]', message, JSON.stringify(context).slice(0, 2000));
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) {
    console.error('[bridge:alert] SLACK_ALERT_WEBHOOK_URL is not set — alert logged only, nobody was paged');
    return;
  }
  try {
    await request(url, {
      method: 'POST',
      body: {
        text: `🚨 *Preppy Bridge Alert*\n${message}\n\`\`\`${JSON.stringify(context, null, 2).slice(0, 1500)}\`\`\``,
      },
    });
  } catch (err) {
    console.error('[bridge:alert] slack post failed', err.message);
  }
}

module.exports = { alert };
