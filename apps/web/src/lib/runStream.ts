import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Run, RunLog } from '@asterius/shared';
import { COOKIE_SESSION, tabOrg, tokenStore } from './api';

export interface SseMessage {
  event: string;
  id?: string;
  data: string;
}

/**
 * Incremental parser for a text/event-stream. Feed it chunks; it returns complete messages and keeps the
 * unfinished remainder in `rest` (pass it back with the next chunk).
 */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  for (const block of parts) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment / keep-alive
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) messages.push({ event, id, data: data.join('\n') });
  }
  return { messages, rest };
}

/** Apply one stream message to the cached run (logs are appended, snapshots keep the logs read so far). */
export function applyRunMessage(current: Run | undefined, msg: SseMessage): Run | undefined {
  if (msg.event === 'run') {
    const snap = JSON.parse(msg.data) as Run;
    return { ...snap, logs: current?.logs ?? snap.logs ?? [] };
  }
  if (msg.event === 'log' && current) {
    const lines = JSON.parse(msg.data) as RunLog[];
    return { ...current, logs: [...(current.logs ?? []), ...lines] };
  }
  return current;
}

/**
 * Keeps ['run', id] live over Server-Sent Events (fetch-based so the bearer token can be sent).
 * Returns whether the stream is connected: callers poll only while it is not. Reconnects with Last-Event-ID.
 */
export function useRunStream(id: string, enabled: boolean): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled || typeof fetch === 'undefined' || typeof TextDecoder === 'undefined') return;
    const abort = new AbortController();
    let lastId = '';
    let finished = false;
    const loop = async () => {
      for (let attempt = 0; !abort.signal.aborted && !finished; attempt++) {
        try {
          const token = tokenStore.get();
          const org = tabOrg();
          const res = await fetch(`/api/v1/runs/${encodeURIComponent(id)}/events`, {
            headers: {
              accept: 'text/event-stream',
              ...(token && token !== COOKIE_SESSION ? { authorization: `Bearer ${token}` } : {}),
              ...(org ? { 'x-asterius-org': org } : {}),
              ...(lastId ? { 'last-event-id': lastId } : {}),
            },
            signal: abort.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          setConnected(true);
          attempt = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let rest = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const parsed = parseSse(rest + decoder.decode(value, { stream: true }));
            rest = parsed.rest;
            for (const m of parsed.messages) {
              if (m.id) lastId = m.id;
              if (m.event === 'done') finished = true;
              qc.setQueryData<Run>(['run', id], (cur) => applyRunMessage(cur, m));
            }
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        setConnected(false);
        if (finished || abort.signal.aborted) break;
        await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** attempt)));
      }
      if (finished) void qc.invalidateQueries({ queryKey: ['run', id] });
    };
    void loop();
    return () => {
      abort.abort();
      setConnected(false);
    };
  }, [id, enabled, qc]);
  return connected;
}
