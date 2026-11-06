import { XMLParser } from 'fast-xml-parser';
import { parse as parseYaml } from 'yaml';

/** Payload formats the http source can ingest. */
export const FORMATS = ['json', 'csv', 'tsv', 'yaml', 'xml'] as const;
export type Format = (typeof FORMATS)[number] | 'auto';

/** RFC 4180 CSV (quoted fields, escaped quotes, newlines inside quotes) → array of objects keyed by the header row. */
export function parseCsv(text: string, delimiter = ','): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, processEntities: true });

export function detectFormat(contentType: string, text: string): (typeof FORMATS)[number] {
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('csv')) return 'csv';
  if (ct.includes('tab-separated')) return 'tsv';
  if (ct.includes('yaml') || ct.includes('yml')) return 'yaml';
  if (ct.includes('xml')) return 'xml';
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (t.startsWith('<')) return 'xml';
  return 'json';
}

/** Parse a response body into plain data (objects/arrays) for JSONata. Throws a readable error on malformed input. */
export function parsePayload(text: string, format: Format, contentType = ''): unknown {
  const f = format === 'auto' ? detectFormat(contentType, text) : format;
  try {
    switch (f) {
      case 'json':
        return text ? JSON.parse(text) : null;
      case 'csv':
        return parseCsv(text, ',');
      case 'tsv':
        return parseCsv(text, '\t');
      case 'yaml':
        return parseYaml(text);
      case 'xml':
        return xml.parse(text);
    }
  } catch (err) {
    throw new Error(`cannot parse the response as ${f}: ${(err as Error).message}`, { cause: err });
  }
}
