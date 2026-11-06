import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { client, fakeServer, register as signUp, testApp, waitFor } from './helpers.js';
import { register, traceFields, withSpan } from '../src/tracing.js';
import { http } from '../src/lib/http.js';

const exporter = new InMemorySpanExporter();
let app: FastifyInstance;
let api: Awaited<ReturnType<typeof fakeServer>>;
const TRACE = '0af7651916cd43dd8448eb211c80319c';

beforeAll(async () => {
  register(new SimpleSpanProcessor({ exporter }));
  app = await testApp();
  api = await fakeServer();
});
afterAll(async () => {
  await api.close();
  await app.close();
});

describe('tracing', () => {
  it('creates a server span continuing the inbound traceparent, with db child spans', async () => {
    exporter.reset();
    const { token } = await signUp(app, 'trace@example.com');
    exporter.reset();
    await client(app, token).get('/api/v1/blueprints', { traceparent: `00-${TRACE}-b7ad6b7169203331-01` });
    await waitFor(async () => exporter.getFinishedSpans().some((s) => s.attributes['http.route']));
    const spans = exporter.getFinishedSpans();
    const server = spans.find((s) => s.attributes['http.route'] === '/api/v1/blueprints');
    expect(server?.spanContext().traceId).toBe(TRACE);
    expect(server?.name).toBe('GET /api/v1/blueprints');
    expect(spans.some((s) => s.name.startsWith('db.') && s.spanContext().traceId === TRACE)).toBe(true);
  });

  it('adds trace_id and span_id to log fields only inside a span', async () => {
    expect(traceFields()).toEqual({});
    await withSpan('t', {}, async (span) => {
      expect(traceFields()).toEqual({ trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId });
    });
  });

  it('sends traceparent on outgoing calls', async () => {
    await withSpan('t', {}, async (span) => {
      await http(`${api.url}/x`);
      const header = api.received.at(-1)?.headers.traceparent;
      expect(String(header)).toContain(span.spanContext().traceId);
    });
  });
});
