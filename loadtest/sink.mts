/**
 * Webhook sink for the fan-out scenario: accepts deliveries on POST /hook/<n> and reports, on GET /stats,
 * how many arrived and the delay between the event time (payload.at) and arrival.
 *
 *   SINK_PORT=9099 npx tsx loadtest/sink.mts
 */
import http from 'node:http';

const latencies: number[] = [];
let received = 0;

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/stats') {
      const sorted = [...latencies].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received, p50: q(0.5), p95: q(0.95), max: sorted.at(-1) ?? 0, latencies: sorted.length }));
      return;
    }
    if (req.method === 'POST' && req.url === '/reset') {
      latencies.length = 0;
      received = 0;
      res.writeHead(204).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received++;
      try {
        const at = Date.parse((JSON.parse(body) as { at: string }).at);
        if (Number.isFinite(at)) latencies.push(Date.now() - at);
      } catch {
        /* not a platform event */
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  })
  .listen(Number(process.env.SINK_PORT ?? 9099), '0.0.0.0', () => console.error('sink listening'));
