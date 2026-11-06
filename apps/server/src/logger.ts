import { createRequire } from 'node:module';
import { pino, type LoggerOptions } from 'pino';
import { config } from './config.js';
import { traceFields } from './tracing.js';

/**
 * One logger configuration for the whole process (Fastify's request logger and background components).
 * JSON lines by default; trace_id / span_id are added when a span is active so logs join with traces.
 * Use `logger.child({ component: '…' })` in modules without a request logger.
 */
const hasPretty = () => {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
};

export const loggerOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers["x-asterius-token"]', 'req.headers.cookie'],
  mixin: traceFields,
  ...(config.LOG_FORMAT === 'pretty' && hasPretty()
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
    : {}),
};

export const logger = pino(loggerOptions);
export const componentLogger = (component: string) => logger.child({ component });
