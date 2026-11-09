import type { WorkflowTestResult } from '@asterius/shared';
import { DEFAULT_ORG, withOrg } from '../orgs/context.js';
import { findOrg } from '../orgs/orgs.js';
import { automationPrincipal } from '../auth/users.js';
import { listActions } from '../actions/actions.js';
import { runWorkflowTests } from '../actions/workflow-tests.js';

/**
 * `node dist/cli.js actions test [id] [--name <test>] [--org <slug>] [--json]`: run the workflow tests stored in the
 * database (every action declaring tests, or one) as the automation account. Prints one line per test and the
 * differences of failed ones; exit code 1 when a test failed, so CI can gate a configuration change (apply it to a
 * staging database, then run this).
 */
export async function testActions(o: { action?: string; name?: string; org?: string; json?: boolean }): Promise<number> {
  const org = await findOrg(o.org ?? DEFAULT_ORG);
  if (!org) {
    console.error(`Unknown organization "${o.org}"`);
    return 1;
  }
  return withOrg(org.id, async () => {
    const who = await automationPrincipal();
    const ids = o.action ? [o.action] : (await listActions()).filter((a) => a.tests?.length).map((a) => a.identifier);
    const reports: { action: string; results: WorkflowTestResult[] }[] = [];
    let failed = 0;
    for (const id of ids) {
      const report = await runWorkflowTests(id, who, { name: o.name });
      failed += report.failed;
      reports.push({ action: id, results: report.results });
    }
    if (o.json) {
      console.log(JSON.stringify({ failed, actions: reports }, null, 2));
      return failed ? 1 : 0;
    }
    for (const a of reports)
      for (const r of a.results) {
        console.log(`${r.passed ? 'PASS' : 'FAIL'} ${a.action} › ${r.name}`);
        for (const e of r.errors) console.log(`     error: ${e}`);
        for (const d of r.diffs) console.log(`     ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`);
      }
    const total = reports.reduce((n, a) => n + a.results.length, 0);
    console.log(`${total - failed}/${total} test(s) passed${ids.length ? '' : ' (no action declares tests)'}`);
    return failed ? 1 : 0;
  });
}
