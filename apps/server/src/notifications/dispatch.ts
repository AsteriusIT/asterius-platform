import type { Subjects } from '@asterius/shared';
import { all } from '../db.js';
import { config } from '../config.js';
import { errorMessage } from '../lib/errors.js';
import { onEvent } from '../events.js';
import { matchesSubjects, principalOf, type UserRow } from '../auth/users.js';
import { approverSubjects } from '../actions/steps.js';
import { dmSlack, mailConfigured, sendMail } from './channels.js';
import { getNotificationPrefs, getNotificationSettings } from './settings.js';
import { orgId } from '../orgs/context.js';
import { activeDelegates } from '../auth/delegations.js';
import { findOrg, orgRef } from '../orgs/orgs.js';
import { notify } from '../inbox.js';

/**
 * The platform's own notifications, following each person's preferences (Profile → Notifications):
 *  - approvals: someone's approval (or answer to an input step) is requested;
 *  - runs: a run you requested has finished.
 * Delivery is best effort: a failing channel is logged and never affects the run.
 */

type Channel = 'email' | 'slack';

interface Recipient {
  id: string;
  email: string;
  name: string;
}

async function deliver(to: Recipient, channels: Channel[], subject: string, body: string, link: string) {
  for (const ch of channels) {
    try {
      if (ch === 'email') {
        if (await mailConfigured()) await sendMail({ to: [to.email], subject, text: `${body}\n\n${link}` });
      } else if ((await getNotificationSettings()).slack.botToken) await dmSlack(to.email, { text: `*${subject}*\n${body}\n<${link}|Open>` });
    } catch (err) {
      console.warn(`[notifications] ${ch} to ${to.email}: ${errorMessage(err)}`);
    }
  }
}

const runLink = (id: string) => `${config.PUBLIC_URL}/runs/${id}`;
const MAX_RECIPIENTS = 50;

/**
 * Ask the people who can decide (approvers; for an input step, the assignees or the requester), and the active
 * delegates of those people. `subjects` may list several sets (an open tier plus escalation approvers). Reminders and
 * escalations use their own wording and skip the people in `exclude` (who already decided, or had a delegate decide).
 */
export async function notifyPendingDecision(o: {
  run: { id: string; action_title: string; team: string | null; triggered_by: string; user_name?: string };
  kind: 'approval' | 'input';
  subjects: Subjects | Subjects[] | undefined;
  allowSelf?: boolean;
  stepName?: string;
  message?: string | null;
  /** n-th reminder of at most `of`. */
  reminder?: { n: number; of: number };
  /** The approval was escalated after this delay: the people asked are the escalation approvers. */
  escalation?: { after: string };
  exclude?: string[];
}) {
  const isNamed = (s: Subjects | undefined) => !!s && !!(s.roles?.length || s.teams?.length || s.users?.length || s.ownerTeam);
  const list = Array.isArray(o.subjects) ? o.subjects : [o.subjects];
  const named = list.some(isNamed);
  const sets: Subjects[] = o.kind === 'approval' ? list.map((s) => approverSubjects(s)) : named ? (list.filter(isNamed) as Subjects[]) : [{ users: [] }];
  const exclude = new Set(o.exclude ?? []);
  // Members of the run's organization (the context of the run).
  const ref = orgRef((await findOrg(orgId()))!);
  const users = await all<UserRow>(
    "SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? AND u.active = 1 AND u.provider != 'service' ORDER BY u.name LIMIT 1000",
    ref.id,
  );
  const base = o.kind === 'approval' ? `Approval needed: ${o.run.action_title}` : `Input needed: ${o.run.action_title}`;
  const subject = o.reminder ? `Reminder: ${base}` : o.escalation ? `Escalated: ${base}` : base;
  const body = [
    `${o.run.user_name ?? 'Someone'} started ${o.run.action_title}.`,
    o.stepName ? `Step: ${o.stepName}` : '',
    o.reminder ? `Still waiting for your decision (reminder ${o.reminder.n} of ${o.reminder.of}).` : '',
    o.escalation ? `Nobody decided within ${o.escalation.after}: the request was escalated to you.` : '',
    o.message ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  const mayDecide = (id: string) => o.kind !== 'approval' || o.allowSelf || id !== o.run.triggered_by;
  // Who is asked: the eligible people (an input step nobody is assigned to is for the requester), never for their own
  // request unless self-approval is allowed.
  const eligible: UserRow[] = [];
  for (const u of users) {
    if (exclude.has(u.id)) continue;
    const ok =
      o.kind === 'input' && !named
        ? u.id === o.run.triggered_by
        : mayDecide(u.id) && (await principalOf(u, ref).then((pr) => sets.some((s) => matchesSubjects(pr, s, o.run.team))));
    if (ok) eligible.push(u);
  }
  // …and the active delegates of those people (out of office), on the same conditions.
  const byId = new Map(users.map((u) => [u.id, u]));
  const recipients = new Map<string, { u: UserRow; for?: string }>(eligible.map((u) => [u.id, { u }]));
  for (const [from, to] of await activeDelegates(eligible.map((u) => u.id))) {
    const d = byId.get(to);
    if (d && !recipients.has(to) && !exclude.has(to) && mayDecide(to)) recipients.set(to, { u: d, for: byId.get(from)?.name });
  }
  let sent = 0;
  for (const { u, for: delegator } of recipients.values()) {
    if (sent >= MAX_RECIPIENTS) break;
    const prefs = await getNotificationPrefs(u.id);
    if (!prefs.approvals.length) continue;
    sent++;
    await deliver(u, prefs.approvals, subject, delegator ? `${body}\nYou are asked as the delegate of ${delegator}.` : body, runLink(o.run.id));
  }
}

const OUTCOME: Record<string, string> = { SUCCESS: 'succeeded', FAILURE: 'failed', REJECTED: 'was rejected', CANCELLED: 'was cancelled' };

interface FinishedRun {
  id: string;
  actionTitle: string;
  status: string;
  statusLabel: string | null;
  triggeredBy: { id: string; name: string; email: string };
  parent?: unknown;
}

async function notifyRunFinished(r: FinishedRun) {
  if (r.parent || !OUTCOME[r.status]) return; // child runs report through their parent
  const prefs = await getNotificationPrefs(r.triggeredBy.id);
  if (!prefs.runs.length) return;
  await deliver(r.triggeredBy, prefs.runs, `${r.actionTitle} ${OUTCOME[r.status]}`, r.statusLabel ?? '', runLink(r.id));
}

let registered = false;
export function registerNotificationListeners() {
  if (registered) return;
  registered = true;
  onEvent(async (e) => {
    if (e.type === 'run.finished') await notifyRunFinished((e.data as { run: FinishedRun }).run);
  });
}

/**
 * SLA breach of a run or a step: the requester and the organization's admins (who own the workflows) get an in-app
 * notification (once, deduplicated) and a message on the channels of their `runs` preference.
 */
export async function notifySlaBreach(o: { runId: string; requester: string; title: string; body: string; dedupe: string }) {
  const users = await all<UserRow>(
    `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE m.org_id = ? AND u.active = 1 AND u.provider != 'service' AND (m.role = 'admin' OR u.id = ?) ORDER BY u.name LIMIT ?`,
    orgId(),
    o.requester,
    MAX_RECIPIENTS,
  );
  for (const u of users) {
    const fresh = await notify(u.id, { kind: 'sla.breached', title: o.title, body: o.body, link: `/runs/${o.runId}`, dedupe: `sla:${o.dedupe}` });
    if (!fresh) continue;
    const prefs = await getNotificationPrefs(u.id);
    if (prefs.runs.length) await deliver(u, prefs.runs, o.title, o.body, runLink(o.runId));
  }
}
