import { json, now, one, run } from '../db.js';
import { notificationPrefs, notificationSettings, type NotificationPrefs, type NotificationSettings } from '../schemas.js';
import { orgId } from '../orgs/context.js';

/** Notification channels of the current organization (its admins) and per-user preferences. */

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const row = await one<{ config: string }>('SELECT config FROM notification_settings WHERE org_id = ?', orgId());
  return notificationSettings.parse(json(row?.config, {}));
}

export async function setNotificationSettings(input: unknown): Promise<NotificationSettings> {
  const parsed = notificationSettings.parse(input);
  const doc = JSON.stringify(parsed);
  const org = orgId();
  const { changes } = await run('UPDATE notification_settings SET config = ?, updated_at = ? WHERE org_id = ?', doc, now(), org);
  if (!changes) await run('INSERT INTO notification_settings (org_id, config, updated_at) VALUES (?, ?, ?)', org, doc, now());
  return parsed;
}

export async function getNotificationPrefs(userId: string): Promise<NotificationPrefs> {
  const row = await one<{ notification_prefs: string | null }>('SELECT notification_prefs FROM users WHERE id = ?', userId);
  return notificationPrefs.parse(json(row?.notification_prefs, {}));
}

export async function setNotificationPrefs(userId: string, input: unknown): Promise<NotificationPrefs> {
  const parsed = notificationPrefs.parse(input);
  await run('UPDATE users SET notification_prefs = ? WHERE id = ?', JSON.stringify(parsed), userId);
  return parsed;
}
