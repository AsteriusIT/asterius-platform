import { Anchor, Badge, Group, Text } from '@mantine/core';
import { Link } from 'react-router';
import { IconCheck, IconX } from '@tabler/icons-react';
import type { PropertySchema } from '@asterius/shared';
import { CodeBlock, InlineCode, JsonBlock } from './CodeEditor';
import { Markdown, TimeAgo } from './ui';

/** Display a property value according to its schema (format, enum colors, types). */
export function PropertyValue({ schema, value, compact }: { schema?: PropertySchema; value: unknown; compact?: boolean }) {
  if (value === undefined || value === null || value === '')
    return (
      <Text span c="dimmed">
        —
      </Text>
    );
  const format = schema?.format;
  if (Array.isArray(value))
    return (
      <Group gap={4}>
        {value.map((v, i) => (
          <PropertyValue key={i} schema={schema?.items && { ...schema.items, enumColors: schema.items.enumColors ?? schema.enumColors }} value={v} compact />
        ))}
      </Group>
    );
  if (typeof value === 'boolean')
    return value ? <IconCheck size={16} color="var(--mantine-color-green-6)" /> : <IconX size={16} color="var(--mantine-color-gray-5)" />;
  if (typeof value === 'object') return compact ? <InlineCode code={JSON.stringify(value)} /> : <JsonBlock value={value} />;
  const s = String(value);
  if (schema?.enum || schema?.enumColors) return <Badge color={schema.enumColors?.[s] ?? 'gray'}>{s}</Badge>;
  if (format === 'url' || format === 'docs')
    return (
      <Anchor href={s} target="_blank" rel="noreferrer" fz="sm" style={{ overflowWrap: 'anywhere' }}>
        {compact ? s.replace(/^https?:\/\//, '').slice(0, 48) : s}
      </Anchor>
    );
  if (format === 'email')
    return (
      <Anchor href={`mailto:${s}`} fz="sm">
        {s}
      </Anchor>
    );
  if (format === 'date-time') return <TimeAgo at={s} />;
  if (format === 'entity' && schema?.blueprint)
    return (
      <Anchor component={Link} to={`/catalog/${schema.blueprint}/${encodeURIComponent(s)}`} fz="sm">
        {s}
      </Anchor>
    );
  if (format === 'team') return <Badge color="gray">{s}</Badge>;
  if (format === 'markdown')
    return compact ? (
      <Text fz="sm" lineClamp={1}>
        {s}
      </Text>
    ) : (
      <Markdown>{s}</Markdown>
    );
  if (format === 'yaml') return compact ? <InlineCode code={s.split('\n')[0] ?? ''} language="yaml" /> : <CodeBlock code={s} language="yaml" />;
  return (
    <Text span fz="sm" style={{ overflowWrap: 'anywhere' }}>
      {s}
    </Text>
  );
}
