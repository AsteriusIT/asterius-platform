import { Alert, Badge, Group, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import type { PlanCheckOutput, PlanSeverity } from '@asterius/shared';
import { Caption, Kicker, Mono, StatValue, SurfaceBox } from './ui';

/** Output of a `plan-check` step (cost, carbon and policy findings of a Terraform / OpenTofu plan) on the run page. */

export const isPlanCheck = (v: unknown): v is PlanCheckOutput =>
  !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'plan-check' && typeof (v as { cost?: unknown }).cost === 'object';

const SEVERITY_COLORS: Record<PlanSeverity, string> = { critical: 'red', warning: 'orange', advisory: 'blue' };
const GATE: Record<PlanCheckOutput['gate'], { color: string; label: string }> = {
  pass: { color: 'green', label: 'Checks passed' },
  override: { color: 'orange', label: 'Override required' },
  blocked: { color: 'red', label: 'Blocked' },
};
const ACTION_COLORS: Record<string, string> = { create: 'green', update: 'yellow', replace: 'orange', delete: 'red', 'no-op': 'gray', forget: 'gray' };

const money = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};
const signedMoney = (n: number, currency: string) => `${n > 0 ? '+' : ''}${money(n, currency)}`;
const kg = (n: number) => `${n.toFixed(1)} kgCO2e`;

export function PlanCheckSummary({ output }: { output: PlanCheckOutput }) {
  const { cost, carbon } = output;
  const gate = GATE[output.gate] ?? GATE.pass;
  const changed = output.resources.filter((r) => r.action !== 'no-op');
  const shown = changed.length ? changed : output.resources;
  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Badge color={gate.color}>{gate.label}</Badge>
        {(['critical', 'warning', 'advisory'] as const)
          .filter((s) => output.counts[s])
          .map((s) => (
            <Badge key={s} color={SEVERITY_COLORS[s]} variant="light">
              {output.counts[s]} {s}
            </Badge>
          ))}
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
        <SurfaceBox>
          <Kicker>Estimated monthly cost</Kicker>
          <StatValue>{money(cost.monthly, cost.currency)}</StatValue>
          <Caption>Catalog {cost.catalog}</Caption>
        </SurfaceBox>
        <SurfaceBox>
          <Kicker>Change</Kicker>
          <StatValue c={cost.delta > 0 ? 'orange' : cost.delta < 0 ? 'green' : undefined}>{signedMoney(cost.delta, cost.currency)}</StatValue>
          <Caption>per month, vs {money(cost.before, cost.currency)} today</Caption>
        </SurfaceBox>
        <SurfaceBox>
          <Kicker>Carbon (estimate)</Kicker>
          <StatValue>{kg(carbon.monthlyKg)}</StatValue>
          <Caption>
            per month, {carbon.deltaKg > 0 ? '+' : ''}
            {carbon.deltaKg.toFixed(1)} vs today
          </Caption>
        </SurfaceBox>
      </SimpleGrid>
      {!cost.complete && (
        <Alert color="orange" variant="light" p="xs" title={`${cost.unmatched.length} resource(s) without a price are not counted`}>
          <Text fz="xs" className="wrap-anywhere">
            {cost.unmatched.join(', ')}
          </Text>
        </Alert>
      )}
      {output.violations.length > 0 && (
        <div>
          <Text fz="sm" fw={500} mb="3xs">
            Policy findings
          </Text>
          <Table withRowBorders={false} verticalSpacing="3xs" highlightOnHover={false} fz="sm">
            <Table.Tbody>
              {output.violations.map((v, i) => (
                <Table.Tr key={`${v.policy}-${i}`}>
                  <Table.Td className="align-top">
                    <Badge color={SEVERITY_COLORS[v.severity]} variant="light">
                      {v.severity}
                    </Badge>
                  </Table.Td>
                  <Table.Td className="wrap-anywhere">
                    <Text fz="sm" fw={500}>
                      {v.title}
                    </Text>
                    <Text fz="sm">{v.message}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {shown.length > 0 && (
        <div>
          <Text fz="sm" fw={500} mb="3xs">
            Resources
          </Text>
          <Table verticalSpacing="3xs" highlightOnHover={false} fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Resource</Table.Th>
                <Table.Th>Change</Table.Th>
                <Table.Th ta="right">Monthly</Table.Th>
                <Table.Th ta="right">Delta</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((r) => (
                <Table.Tr key={r.address}>
                  <Table.Td className="wrap-anywhere" title={r.note}>
                    <Mono>{r.address}</Mono>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={ACTION_COLORS[r.action] ?? 'gray'}>
                      {r.action}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right">
                    {r.pricing === 'unmatched' ? 'no price' : r.pricing === 'usage-based' ? 'usage-based' : money(r.monthly, cost.currency)}
                  </Table.Td>
                  <Table.Td ta="right">{r.pricing === 'unmatched' ? '?' : signedMoney(r.delta, cost.currency)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {output.truncated > 0 && <Caption mt="3xs">{output.truncated} more resource(s) in the plan-check.json artifact</Caption>}
        </div>
      )}
      <Caption>{carbon.method}</Caption>
    </Stack>
  );
}
