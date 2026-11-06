import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { RunLog } from '@asterius/shared';
import { filterLogs, LogViewer, logsToText } from '../src/components/LogViewer';
import { renderUi } from './render';

afterEach(cleanup);

const lines: RunLog[] = [
  { at: '2026-01-01T10:00:00Z', stepId: 'build', level: 'info', message: 'compiling' },
  { at: '2026-01-01T10:00:01Z', stepId: 'deploy', level: 'error', message: 'Timeout reached' },
];

describe('LogViewer', () => {
  it('filters lines by text and step', () => {
    expect(filterLogs(lines, 'timeout')).toHaveLength(1);
    expect(filterLogs(lines, 'build')).toHaveLength(1);
    expect(filterLogs(lines, '  ')).toHaveLength(2);
  });

  it('formats the download', () => {
    expect(logsToText(lines)).toBe('2026-01-01T10:00:00Z INFO [build] compiling\n2026-01-01T10:00:01Z ERROR [deploy] Timeout reached\n');
  });

  it('searches in the rendered log', () => {
    renderUi(<LogViewer lines={lines} showStep />);
    expect(screen.getByText(/compiling/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'timeout' } });
    expect(screen.queryByText(/compiling/)).toBeNull();
    expect(screen.getByText(/Timeout reached/)).toBeTruthy();
  });
});
