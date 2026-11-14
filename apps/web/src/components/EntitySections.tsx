import { Anchor, Badge, Group, SimpleGrid, Stack, Table, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { IconCheck, IconChevronDown, IconX } from '@tabler/icons-react';
import type { Blueprint, Entity, ScorecardResult } from '@asterius/shared';
import { api } from '../lib/api';
import { PropertyValue } from './PropertyValue';
import { orderedFields } from './SchemaForm';
import { Empty, LevelBadge, QueryView } from './ui';

/**
 * Sections of an entity page, rendered bare (the page or the dashboard widget gives the card and the title): its
 * properties, scorecards, relations and links. The built-in overview and the `entity` widget of entity-page dashboards
 * both compose them.
 */

export const entityLink = (e: Pick<Entity, 'blueprint' | 'identifier'>) => `/catalog/${e.blueprint}/${encodeURIComponent(e.identifier)}`;

/** `url` properties holding an http(s) link. */
export const entityLinks = (bp: Blueprint, e: Entity) =>
  Object.entries(bp.schema.properties)
    .filter(([k, p]) => p.format === 'url' && typeof e.properties[k] === 'string' && /^https?:\/\//.test(e.properties[k] as string))
    .map(([k, p]) => ({ label: p.title ?? k, href: e.properties[k] as string }));

/** Properties (the schema's order), computed values and properties outside the schema; `only`: these, in this order. */
export function EntityProperties({ bp, e, only }: { bp: Blueprint; e: Entity; only?: string[] }) {
  const fields = only ?? orderedFields(bp.schema);
  return (
    <Table withRowBorders={false} verticalSpacing="2xs" highlightOnHover={false}>
      <Table.Tbody>
        {fields.map((k) => (
          <Table.Tr key={k}>
            <Table.Td w="35%" c="dimmed" fz="sm" className="align-top">
              {bp.schema.properties[k]?.title ?? bp.computed?.[k]?.title ?? k}
            </Table.Td>
            <Table.Td>
              <PropertyValue schema={bp.schema.properties[k]} value={e.properties[k] ?? e.computed?.[k]} />
            </Table.Td>
          </Table.Tr>
        ))}
        {!only &&
          Object.entries(bp.computed ?? {}).map(([k, c]) => (
            <Table.Tr key={`computed-${k}`}>
              <Table.Td w="35%" c="dimmed" fz="sm" className="align-top">
                <Tooltip label={`Computed (${c.kind})`}>
                  <span>{c.title ?? k}</span>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <PropertyValue value={e.computed?.[k]} />
              </Table.Td>
            </Table.Tr>
          ))}
        {!only &&
          Object.keys(e.properties)
            .filter((k) => !bp.schema.properties[k])
            .map((k) => (
              <Table.Tr key={k}>
                <Table.Td c="dimmed" fz="sm">
                  {k}
                </Table.Td>
                <Table.Td>
                  <PropertyValue value={e.properties[k]} />
                </Table.Td>
              </Table.Tr>
            ))}
      </Table.Tbody>
    </Table>
  );
}

/** One scorecard result: level, then each rule passed or failed. */
export function ScorecardRules({ result }: { result: ScorecardResult }) {
  return (
    <>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>{result.scorecardTitle}</Text>
        <Group gap="xs">
          <Text fz="xs" c="dimmed">
            {result.passed}/{result.total} rules
          </Text>
          <LevelBadge level={result.level} color={result.levelColor} />
        </Group>
      </Group>
      <Stack gap="3xs">
        {result.rules.map((r) => (
          <Group key={r.rule} gap="xs" wrap="nowrap" align="flex-start">
            {r.passed ? <IconCheck size={16} color="var(--mantine-color-green-6)" /> : <IconX size={16} color="var(--mantine-color-red-6)" />}
            <Text fz="sm" flex={1}>
              {r.title}
              {r.error && (
                <Text span fz="xs" c="red">
                  {' '}
                  ({r.error})
                </Text>
              )}
            </Text>
            <Badge size="xs" color="gray" variant="outline">
              {r.level}
            </Badge>
          </Group>
        ))}
      </Stack>
    </>
  );
}

/** Every scorecard of the entity, one after the other. */
export function EntityScorecards({ e }: { e: Entity }) {
  const q = useQuery({ queryKey: ['entity-scorecards', e.blueprint, e.identifier], queryFn: () => api.entityScorecards(e.blueprint, e.identifier) });
  return (
    <QueryView q={q}>
      {(list) =>
        list.length ? (
          <Stack gap="lg">
            {list.map((sc) => (
              <div key={sc.scorecard}>
                <ScorecardRules result={sc} />
              </div>
            ))}
          </Stack>
        ) : (
          <Empty title="No scorecard for this blueprint" />
        )
      }
    </QueryView>
  );
}

/** Groups of related entities as badges linking to them. */
export function RelationGroups({ groups }: { groups: [string, Entity[]][] }) {
  const nonEmpty = groups.filter(([, l]) => l.length);
  if (!nonEmpty.length) return <Empty title="None" />;
  return (
    <SimpleGrid cols={1} spacing="sm">
      {nonEmpty.map(([label, list]) => (
        <div key={label}>
          <Group gap="3xs" mb="3xs">
            <IconChevronDown size={14} />
            <Text fz="xs" c="dimmed" fw={500}>
              {label}
            </Text>
          </Group>
          <Group gap="2xs">
            {list.map((x) =>
              x.source === 'missing' ? (
                <Tooltip key={x.identifier} label="Not in the catalog (yet)">
                  <Badge color="gray" variant="outline" td="line-through">
                    {x.identifier}
                  </Badge>
                </Tooltip>
              ) : (
                <Anchor key={`${x.blueprint}/${x.identifier}`} component={Link} to={entityLink(x)}>
                  <Badge variant="light" className="clickable">
                    {x.title}
                  </Badge>
                </Anchor>
              ),
            )}
          </Group>
        </div>
      ))}
    </SimpleGrid>
  );
}

/** Outgoing relations then the entities pointing to this one. */
export function EntityRelations({ bp, e }: { bp: Blueprint; e: Entity }) {
  const related = useQuery({ queryKey: ['related', bp.identifier, e.identifier], queryFn: () => api.related(bp.identifier, e.identifier) });
  return (
    <QueryView q={related}>
      {(rel) => (
        <RelationGroups
          groups={[
            ...Object.entries(bp.relations).map(([name, r]): [string, Entity[]] => [r.title ?? name, rel.outgoing[name] ?? []]),
            ...Object.entries(rel.incoming).map(([k, list]): [string, Entity[]] => [rel.incomingTitles?.[k] ?? k.replace('.', ' · '), list]),
          ]}
        />
      )}
    </QueryView>
  );
}

export function LinkList({ links }: { links: { label: string; href: string }[] }) {
  if (!links.length) return <Empty title="No link" />;
  return (
    <Stack gap="3xs">
      {links.map((l) => (
        <Anchor key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" fz="sm">
          {l.label}
        </Anchor>
      ))}
    </Stack>
  );
}
