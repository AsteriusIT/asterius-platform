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
import { findOrg, orgRef } from '../orgs/orgs.js';

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

/** Ask the people who can decide (approvers; for an input step, the assignees or the requester). */
export async function notifyPendingDecision(o: {
  run: { id: string; action_title: string; team: string | null; triggered_by: string; user_name?: string };
  kind: 'approval' | 'input';
  subjects: Subjects | undefined;
  allowSelf?: boolean;
  stepName?: string;
  message?: string | null;
}) {
  const named = o.subjects && (o.subjects.roles?.length || o.subjects.teams?.length || o.subjects.users?.length || o.subjects.ownerTeam);
  const subjects: Subjects = o.kind === 'approval' ? approverSubjects(o.subjects) : named ? (o.subjects as Subjects) : { users: [] };
  // Members of the run's organization (the context of the run).
  const ref = orgRef((await findOrg(orgId()))!);
  const users = await all<UserRow>(
    "SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? AND u.active = 1 AND u.provider != 'service' ORDER BY u.name LIMIT 1000",
    ref.id,
  );
  const subject = o.kind === 'approval' ? `Approval needed: ${o.run.action_title}` : `Input needed: ${o.run.action_title}`;
  const body = [`${o.run.user_name ?? 'Someone'} started ${o.run.action_title}.`, o.stepName ? `Step: ${o.stepName}` : '', o.message ?? '']
    .filter(Boolean)
    .join('\n');
  let sent = 0;
  for (const u of users) {
    if (sent >= MAX_RECIPIENTS) break;
    const isRequester = u.id === o.run.triggered_by;
    // An input step nobody is assigned to is for the requester; otherwise whoever matches (never one's own approval).
    const eligible =
      o.kind === 'input' && !named
        ? isRequester
        : matchesSubjects(await principalOf(u, ref), subjects, o.run.team) && (o.kind !== 'approval' || o.allowSelf || !isRequester);
    if (!eligible) continue;
    const prefs = await getNotificationPrefs(u.id);
    if (!prefs.approvals.length) continue;
    sent++;
    await deliver(u, prefs.approvals, subject, body, runLink(o.run.id));
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
