import { useId, type ReactNode } from 'react';
import { Box, Group, Text } from '@mantine/core';

/**
 * A titled part of a page, a side panel or a modal: title, actions on the right, then the content. Flat: it brings
 * no card. Consecutive sections are separated by a hairline; a page that wants a card wraps the section itself.
 */
export function Section(props: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <Box component="section" className="ui-section" aria-labelledby={props.title ? id : undefined}>
      {(props.title || props.actions) && (
        <Group className="ui-section-header" justify="space-between" gap="xs" wrap="nowrap" mb="xs" mih={26}>
          <Text id={id} component="h3" fw={600} fz="sm" m={0}>
            {props.title}
          </Text>
          {props.actions && (
            <Group gap="xs" wrap="nowrap">
              {props.actions}
            </Group>
          )}
        </Group>
      )}
      {props.children}
    </Box>
  );
}
