import { postSlack, postTeams, sendMail, slackUserId } from '../../notifications/channels.js';
import { getNotificationSettings } from '../../notifications/settings.js';
import { requireFields, str, type Invoker } from '../types.js';

/**
 * Notification invokers: tell people in Slack, Microsoft Teams or by email. Credentials and default channels come
 * from Admin → Notifications unless the step sets its own; every text field is a `{{ }}` template, so messages can
 * quote inputs, earlier step outputs and the run link (`{{ run.url }}`).
 */

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()) : []).filter(Boolean);
const maybeJson = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    throw new Error('blocks / card must be valid JSON');
  }
};

export const slackInvoker: Invoker = {
  info: {
    type: 'slack',
    title: 'Slack message',
    description: 'Post a message to a channel (bot token or incoming webhook), mentioning people by email.',
    fields: [
      { key: 'channel', label: 'Channel', kind: 'text', placeholder: '#platform-alerts (default: Admin → Notifications)' },
      { key: 'text', label: 'Message', kind: 'textarea', required: true, help: 'mrkdwn; templates: {{ inputs.name }}, {{ run.url }}' },
      { key: 'mentions', label: 'Mention (emails)', kind: 'list', help: 'Resolved to Slack users with users.lookupByEmail (bot token needed)' },
      { key: 'blocks', label: 'Block Kit blocks', kind: 'json', help: 'Optional; the message text is then the notification fallback', advanced: true },
      { key: 'botToken', label: 'Bot token', kind: 'secret', help: 'Default: Admin → Notifications', advanced: true },
      { key: 'webhookUrl', label: 'Incoming webhook URL', kind: 'secret', help: 'Used when there is no bot token', advanced: true },
      { key: 'apiUrl', label: 'API URL', kind: 'text', placeholder: 'https://slack.com/api', advanced: true },
    ],
    example: {
      type: 'slack',
      channel: '#platform',
      text: ':rocket: {{ inputs.name }} was provisioned by {{ trigger.user.name }} <{{ run.url }}|details>',
      mentions: ['{{ trigger.user.email }}'],
    },
  },
  validate(c) {
    requireFields(c, ['text'], 'slack');
  },
  async start({ config, log }) {
    const target = {
      channel: str(config.channel) || undefined,
      botToken: str(config.botToken) || undefined,
      webhookUrl: str(config.webhookUrl) || undefined,
      apiUrl: str(config.apiUrl) || undefined,
    };
    const defaults = (await getNotificationSettings()).slack;
    let text = str(config.text);
    const mentions: string[] = [];
    for (const email of list(config.mentions)) {
      const id = await slackUserId({ ...target, botToken: target.botToken ?? defaults.botToken }, email);
      mentions.push(id ? `<@${id}>` : email);
      if (!id) await log(`No Slack user for ${email}: mentioned as plain text`, 'warn');
    }
    if (mentions.length) text = `${mentions.join(' ')} ${text}`;
    const sent = await postSlack(target, { text, blocks: maybeJson(config.blocks) });
    await log(`Posted to Slack${sent.channel ? ` (${sent.channel})` : ''}`);
    return { status: 'SUCCESS', result: { channel: sent.channel ?? null, ts: sent.ts ?? null } };
  },
};

export const teamsInvoker: Invoker = {
  info: {
    type: 'teams',
    title: 'Microsoft Teams message',
    description: 'Post an Adaptive Card to a channel through a Workflows / incoming webhook.',
    fields: [
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'text', label: 'Message', kind: 'textarea', required: true },
      { key: 'mentions', label: 'Mention (emails)', kind: 'list', help: 'Shown as @name; the email identifies the user' },
      { key: 'card', label: 'Adaptive Card', kind: 'json', help: 'A complete card, replaces title and message', advanced: true },
      { key: 'webhookUrl', label: 'Webhook URL', kind: 'secret', help: 'Default: Admin → Notifications', advanced: true },
    ],
    example: { type: 'teams', title: 'Provisioning done', text: '{{ inputs.name }} is ready: {{ run.url }}', mentions: ['{{ trigger.user.email }}'] },
  },
  validate(c) {
    if (!c.text && !c.card) throw new Error('teams invoker: set a message or a card');
  },
  async start({ config, log }) {
    const mentions = list(config.mentions).map((email) => ({ email, name: email.split('@')[0] }));
    await postTeams(str(config.webhookUrl) || undefined, {
      title: str(config.title) || undefined,
      text: str(config.text),
      card: maybeJson(config.card) as Record<string, unknown> | undefined,
      mentions,
    });
    await log('Posted to Teams');
    return { status: 'SUCCESS', result: { delivered: true } };
  },
};

export const emailInvoker: Invoker = {
  info: {
    type: 'email',
    title: 'Email',
    description: 'Send an email through the platform SMTP server.',
    fields: [
      { key: 'to', label: 'To', kind: 'list', required: true, help: 'e.g. {{ trigger.user.email }}' },
      { key: 'cc', label: 'Cc', kind: 'list', advanced: true },
      { key: 'subject', label: 'Subject', kind: 'text', required: true },
      { key: 'text', label: 'Body (text)', kind: 'textarea' },
      { key: 'html', label: 'Body (HTML)', kind: 'textarea', advanced: true },
      { key: 'from', label: 'From', kind: 'text', help: 'Default: Admin → Notifications', advanced: true },
    ],
    example: { type: 'email', to: ['{{ trigger.user.email }}'], subject: '{{ action.title }}: done', text: 'Your request {{ run.url }} finished.' },
  },
  validate(c) {
    requireFields(c, ['to', 'subject'], 'email');
    if (!c.text && !c.html) throw new Error('email invoker: write a text or html body');
  },
  async start({ config, log }) {
    const to = list(config.to);
    const sent = await sendMail({
      to,
      cc: list(config.cc),
      subject: str(config.subject),
      text: str(config.text) || undefined,
      html: str(config.html) || undefined,
      from: str(config.from) || undefined,
    });
    await log(`Email sent to ${to.length} recipient(s)`);
    return { status: 'SUCCESS', result: { recipients: to.length, messageId: sent.messageId ?? null } };
  },
};
