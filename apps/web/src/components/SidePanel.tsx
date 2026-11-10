import type { ReactNode } from 'react';
import { Box, Drawer, Group, Text } from '@mantine/core';

/** The three widths a panel can have: a list, a form or details (default), a table. */
const WIDTHS = { narrow: 440, default: 620, wide: 780 } as const;

/**
 * The one side panel of the portal (right drawer). It owns the chrome: title, subtitle, header actions, close
 * button and scrolling (the header stays, the body scrolls). What goes inside renders bare: no card, no title of
 * its own; split it with `Section`.
 */
export function SidePanel(props: {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One dimmed line under the title (status, what the panel is about). */
  subtitle?: ReactNode;
  /** Right of the title: badges, filters, small buttons. */
  actions?: ReactNode;
  width?: keyof typeof WIDTHS;
  /** No padding: the content (log, table) goes edge to edge and may fill the height. */
  flush?: boolean;
  /** Stays at the bottom while the body scrolls. Content that owns the buttons renders a `SidePanelFooter` itself. */
  footer?: ReactNode;
  /** `false`: no backdrop, the page behind stays visible and usable (run graph). */
  overlay?: boolean;
  children?: ReactNode;
}) {
  const overlay = props.overlay ?? true;
  return (
    <Drawer.Root
      opened={props.opened}
      onClose={props.onClose}
      position="right"
      size={WIDTHS[props.width ?? 'default']}
      shadow="xl"
      scrollAreaComponent={Frame}
      classNames={{ content: 'side-panel' }}
    >
      {overlay && <Drawer.Overlay backgroundOpacity={0.25} blur={2} />}
      <Drawer.Content>
        <Drawer.Header className="side-panel-header">
          <Box flex={1} miw={0}>
            <Drawer.Title className="side-panel-title">{props.title}</Drawer.Title>
            {props.subtitle && (
              <Text className="side-panel-subtitle" fz="xs" c="dimmed" truncate>
                {props.subtitle}
              </Text>
            )}
          </Box>
          {props.actions && (
            <Group className="side-panel-actions" gap="xs" wrap="nowrap">
              {props.actions}
            </Group>
          )}
          <Drawer.CloseButton aria-label="Close panel" />
        </Drawer.Header>
        <Drawer.Body className="side-panel-body" data-flush={props.flush || undefined}>
          {props.children}
          {props.footer && <SidePanelFooter>{props.footer}</SidePanelFooter>}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}

/** Replaces the drawer's own scroll area: a column whose header stays while the body scrolls. */
function Frame({ children }: { children?: ReactNode }) {
  return <div className="side-panel-frame">{children}</div>;
}

/** Buttons pinned at the bottom of a side panel; last child of the panel body. */
export function SidePanelFooter({ children }: { children: ReactNode }) {
  return (
    <Group className="side-panel-footer" justify="flex-end" gap="sm">
      {children}
    </Group>
  );
}
