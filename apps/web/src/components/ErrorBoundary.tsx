import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Center, Code, Group, Stack, Text, Title } from '@mantine/core';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { IconAlertTriangle } from '@tabler/icons-react';
import { errorText } from '../lib/api';
import { useT } from '../lib/i18n';
import { ICON_DISPLAY } from '@asterius/brand';

/** Full-page fallback with a reload action. */
export function ErrorFallback({ error, onReset }: { error: unknown; onReset?: () => void }) {
  const t = useT();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : errorText(error);
  return (
    <Center mih="50vh" p="lg" role="alert">
      <Stack align="center" gap="sm" maw={520}>
        <IconAlertTriangle size={ICON_DISPLAY.lg} />
        <Title order={3}>{t('error.title')}</Title>
        <Text c="dimmed" fz="sm" ta="center">
          {t('error.hint')}
        </Text>
        <Code block>{message}</Code>
        <Group>
          {onReset && (
            <Button variant="default" onClick={onReset}>
              {t('error.retry')}
            </Button>
          )}
          <Button onClick={() => window.location.reload()}>{t('error.reload')}</Button>
        </Group>
      </Stack>
    </Center>
  );
}

/** Router `errorElement`: render and loader errors of a route. */
export function RouteError() {
  return <ErrorFallback error={useRouteError()} />;
}

/** Catches render exceptions below it so one broken component does not blank the app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error('Unknown error') };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info.componentStack);
  }
  render() {
    if (this.state.error) return <ErrorFallback error={this.state.error} onReset={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
