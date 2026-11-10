import { describe, expect, it } from 'vitest';
import type { Run } from '@asterius/shared';
import { applyRunMessage, parseSse } from '../src/lib/runStream';

describe('parseSse', () => {
  it('parses complete messages and keeps the remainder', () => {
    const { messages, rest } = parseSse('id: 4\nevent: log\ndata: [1]\n\n: keep-alive\n\nevent: run\ndata: {"a"');
    expect(messages).toEqual([{ event: 'log', id: '4', data: '[1]' }]);
    expect(rest).toBe('event: run\ndata: {"a"');
    expect(parseSse(`${rest}:1}\n\n`).messages).toEqual([{ event: 'run', id: undefined, data: '{"a":1}' }]);
  });
});

describe('applyRunMessage', () => {
  const run = (patch: Partial<Run>) => ({ id: 'r', status: 'IN_PROGRESS', logs: [], ...patch }) as unknown as Run;
  const line = (message: string) => ({ at: '', level: 'info', message });
  it('appends log lines', () => {
    const next = applyRunMessage(run({ logs: [line('a')] as Run['logs'] }), { event: 'log', data: JSON.stringify([line('b')]) });
    expect(next?.logs?.map((l) => l.message)).toEqual(['a', 'b']);
  });
  it('skips lines it already holds (the stream replays from the first line)', () => {
    const seq = (n: number) => ({ ...line(`l${n}`), seq: n });
    const held = run({ logs: [seq(1), seq(2)] as Run['logs'] });
    const next = applyRunMessage(held, { event: 'log', data: JSON.stringify([seq(1), seq(2), seq(3)]) });
    expect(next?.logs?.map((l) => l.message)).toEqual(['l1', 'l2', 'l3']);
    expect(applyRunMessage(held, { event: 'log', data: JSON.stringify([seq(1), seq(2)]) })).toBe(held);
  });
  it('keeps the logs when a snapshot arrives', () => {
    const next = applyRunMessage(run({ logs: [line('a')] as Run['logs'] }), { event: 'run', data: JSON.stringify(run({ status: 'SUCCESS', logs: [] })) });
    expect(next?.status).toBe('SUCCESS');
    expect(next?.logs).toHaveLength(1);
  });
});
