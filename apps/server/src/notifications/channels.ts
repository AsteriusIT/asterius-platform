import nodemailer, { type Transporter } from 'nodemailer';
import { http } from '../lib/http.js';
import { resolveValue } from '../secrets.js';
import { getNotificationSettings } from './settings.js';
import { config } from '../config.js';

/**
 * Delivery to Slack, Microsoft Teams and email. Shared by the notification invokers (workflow steps) and by the
 * platform's own notifications (approval requests, run outcomes). Credentials are references (`${secret:…}`)
 * resolved here, at send time; they never reach logs or step outputs.
 */

const SLACK_API = 'https://slack.com/api';

export interface SlackTarget {
  botToken?: string;
  webhookUrl?: string;
  channel?: string;
  apiUrl?: string;
}

interface SlackReply {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  user?: { id: string };
}

const slackCall = async (api: string, token: string, method: string, body: Record<string, unknown>) => {
  const res = await http<SlackReply>(`${api}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
  if (!res.data.ok) throw new Error(`Slack ${method}: ${res.data.error ?? 'failed'}`);
  return res.data;
};

/** Slack user id for an email (`users.lookupByEmail`); undefined when there is none or the bot cannot look it up. */
export async function slackUserId(t: SlackTarget, email: string): Promise<string | undefined> {
  const token = await resolveValue(t.botToken);
  if (!token) return undefined;
  const api = (t.apiUrl ?? SLACK_API).replace(/\/$/, '');
  try {
    const res = await http<SlackReply>(`${api}/users.lookupByEmail?email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${token}` } });
    return res.data.ok ? res.data.user?.id : undefined;
  } catch {
    return undefined;
  }
}

export interface SlackMessage {
  text: string;
  blocks?: unknown;
}

export async function postSlack(t: SlackTarget, m: SlackMessage): Promise<{ channel?: string; ts?: string }> {
  const defaults = (await getNotificationSettings()).slack;
  const token = await resolveValue(t.botToken ?? defaults.botToken);
  const webhook = await resolveValue(t.webhookUrl ?? (token ? undefined : defaults.webhookUrl));
  const channel = t.channel ?? defaults.defaultChannel;
  const api = (t.apiUrl ?? SLACK_API).replace(/\/$/, '');
  if (token) {
    if (!channel) throw new Error('Slack: set a channel on the step or a default channel in Admin → Notifications');
    const r = await slackCall(api, token, 'chat.postMessage', { channel, text: m.text, ...(m.blocks ? { blocks: m.blocks } : {}) });
    return { channel: r.channel, ts: r.ts };
  }
  if (webhook) {
    await http(webhook, { method: 'POST', body: { text: m.text, ...(m.blocks ? { blocks: m.blocks } : {}), ...(channel ? { channel } : {}) } });
    return { channel };
  }
  throw new Error('Slack: no bot token or incoming webhook (set one on the step or in Admin → Notifications)');
}

/** Direct message to a person identified by email. */
export async function dmSlack(email: string, m: SlackMessage, t: SlackTarget = {}) {
  const defaults = (await getNotificationSettings()).slack;
  const target = { ...t, botToken: t.botToken ?? defaults.botToken };
  const id = await slackUserId(target, email);
  if (!id) throw new Error(`No Slack user for ${email}`);
  return postSlack({ ...target, channel: id }, m);
}

export interface TeamsMessage {
  title?: string;
  text: string;
  /** A complete Adaptive Card; replaces title and text. */
  card?: Record<string, unknown>;
  mentions?: { email: string; name: string }[];
}

export async function postTeams(webhookUrl: string | undefined, m: TeamsMessage): Promise<void> {
  const url = await resolveValue(webhookUrl ?? (await getNotificationSettings()).teams.webhookUrl);
  if (!url) throw new Error('Teams: no webhook URL (set one on the step or in Admin → Notifications)');
  const mentions = m.mentions ?? [];
  const content = m.card ?? {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      ...(m.title ? [{ type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true }] : []),
      { type: 'TextBlock', text: [...mentions.map((x) => `<at>${x.name}</at>`), m.text].join(' '), wrap: true },
    ],
    ...(mentions.length
      ? { msteams: { entities: mentions.map((x) => ({ type: 'mention', text: `<at>${x.name}</at>`, mentioned: { id: x.email, name: x.name } })) } }
      : {}),
  };
  await http(url, { method: 'POST', body: { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content }] } });
}

// ---------- email ----------
export interface Mail {
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
}

export type MailTransportFactory = (smtpUrl: string) => Pick<Transporter, 'sendMail'>;
let transportFactory: MailTransportFactory = (url) => nodemailer.createTransport(url);

/** Tests (and plugins) replace how mail is sent. */
export function setMailTransportFactory(f: MailTransportFactory) {
  transportFactory = f;
}

export async function mailConfigured(): Promise<boolean> {
  return !!(config.SMTP_URL || (await getNotificationSettings()).email.smtpUrl);
}

export async function sendMail(m: Mail): Promise<{ messageId?: string }> {
  const s = (await getNotificationSettings()).email;
  const smtp = await resolveValue(s.smtpUrl ?? config.SMTP_URL);
  if (!smtp) throw new Error('Email: SMTP is not configured (SMTP_URL, or Admin → Notifications)');
  const from = m.from ?? s.from ?? config.SMTP_FROM;
  if (!from) throw new Error('Email: set a sender (from) on the step or in Admin → Notifications');
  if (!m.to.length) throw new Error('Email: no recipient');
  if (!m.text && !m.html) throw new Error('Email: write a text or html body');
  const info = (await transportFactory(smtp).sendMail({ from, to: m.to, cc: m.cc, subject: m.subject, text: m.text, html: m.html })) as { messageId?: string };
  return { messageId: info.messageId };
}
