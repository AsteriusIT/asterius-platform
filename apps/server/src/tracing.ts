import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BatchSpanProcessor, ConsoleSpanExporter, TracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

/**
 * OpenTelemetry tracing, off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (or OTEL_TRACES_EXPORTER=console).
 * Spans: http.server (one per inbound request), db.query, action.run, integration.sync, webhook.deliver; outgoing fetch() calls (pipelines, sources,
 * Entra) are traced automatically as children.
 */
export const tracer = trace.getTracer('asterius-platform');

export function initTracing(role: string) {
  const console = process.env.OTEL_TRACES_EXPORTER === 'console';
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !console) return false;
  register(new BatchSpanProcessor({ exporter: console ? new ConsoleSpanExporter() : new OTLPTraceExporter() }), role);
  return true;
}

/** Install a global tracer provider (+ async context propagation and fetch instrumentation). */
export function register(processor: SpanProcessor, role = 'test') {
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME ?? 'asterius-platform', 'platform.role': role }),
    spanProcessors: [processor],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  // W3C traceparent: extracted from inbound requests, injected by the undici instrumentation into every
  // outgoing fetch() (CI pipelines, webhooks, sources) so a run can be followed into the downstream system.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  registerInstrumentations({ instrumentations: [new UndiciInstrumentation()] });
  return provider;
}

/** Run `fn` in a span (child of `parent` when given, else of the active span); errors mark the span failed. */
export function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, parent?: Span): Promise<T> {
  const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
  return tracer.startActiveSpan(name, { attributes }, ctx, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message.slice(0, 200) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Fields to merge into every log line so logs and traces can be joined (pino `mixin`). */
export function traceFields(): { trace_id?: string; span_id?: string } {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && trace.isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
}

/** Wrap a database call in a client span (statement text only: parameters are never recorded). */
export function dbSpan<T>(system: string, sql: string, fn: () => Promise<T>): Promise<T> {
  const op = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? 'QUERY';
  return tracer.startActiveSpan(
    `db.${op}`,
    { kind: SpanKind.CLIENT, attributes: { 'db.system': system, 'db.operation': op, 'db.statement': sql.slice(0, 500) } },
    async (span) => {
      try {
        return await fn();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message.slice(0, 200) });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Server span for one inbound request, continuing the caller's trace when it sent a traceparent. */
export function startRequestSpan(method: string, path: string, headers: Record<string, unknown>): Span {
  const parent = propagation.extract(context.active(), headers);
  return tracer.startSpan(`${method} ${path}`, { kind: SpanKind.SERVER, attributes: { 'http.request.method': method } }, parent);
}
