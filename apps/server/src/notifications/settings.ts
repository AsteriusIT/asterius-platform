import { json, now, one, run } from '../db.js';
import { notificationPrefs, notificationSettings, type NotificationPrefs, type NotificationSettings } from '../schemas.js';

/** Platform-wide notification defaults (admin) and per-user preferences. */

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const row = await one<{ config: string }>('SELECT config FROM notification_settings WHERE id = 1');
  return notificationSettings.parse(json(row?.config, {}));
}

export async function setNotificationSettings(input: unknown): Promise<NotificationSettings> {
  const parsed = notificationSettings.parse(input);
  const doc = JSON.stringify(parsed);
  const { changes } = await run('UPDATE notification_settings SET config = ?, updated_at = ? WHERE id = 1', doc, now());
  if (!changes) await run('INSERT INTO notification_settings (id, config, updated_at) VALUES (1, ?, ?)', doc, now());
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
