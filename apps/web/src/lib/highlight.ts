/**
 * Tiny JSON / YAML tokenizers for the code views: no parser, just enough to color keys, strings, numbers,
 * literals, comments and punctuation. Templates (`{{ … }}`) and secret references (`${secret:…}`) inside
 * values are marked too. Concatenating the token values always gives back the input.
 */

export type TokenType = 'key' | 'string' | 'number' | 'literal' | 'comment' | 'punct' | 'template' | 'plain';
export interface Token {
  t: TokenType;
  v: string;
}

const TEMPLATE = /(\{\{[^}]*\}\}|\$\{(?:secret|env):[^}]*\})/g;

/** Split a string value so templates and secret references stand out. */
function withTemplates(v: string, t: TokenType, out: Token[]) {
  let last = 0;
  for (const m of v.matchAll(TEMPLATE)) {
    if (m.index > last) out.push({ t, v: v.slice(last, m.index) });
    out.push({ t: 'template', v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < v.length) out.push({ t, v: v.slice(last) });
}

const JSON_TOKEN = /("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

export function tokenizeJson(src: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of src.matchAll(JSON_TOKEN)) {
    if (m.index > last) out.push({ t: 'plain', v: src.slice(last, m.index) });
    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        out.push({ t: 'key', v: m[1] });
        out.push({ t: 'punct', v: m[2] });
      } else withTemplates(m[1], 'string', out);
    } else if (m[3] !== undefined) out.push({ t: 'number', v: m[3] });
    else if (m[4] !== undefined) out.push({ t: 'literal', v: m[4] });
    else out.push({ t: 'punct', v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'plain', v: src.slice(last) });
  return out;
}

const YAML_LITERAL = /^(true|false|null|~|yes|no|on|off)$/i;
const YAML_NUMBER = /^[-+]?(\d[\d_]*(\.\d+)?([eE][+-]?\d+)?|0x[0-9a-fA-F]+|\.inf|\.nan)$/;

/** A scalar after `key:` or `- `: comment split off, then typed. */
function yamlValue(v: string, out: Token[]) {
  // Comment: ` #` outside quotes (good enough for configuration files).
  let comment = '';
  if (!/^\s*["']/.test(v)) {
    const i = v.search(/(^|\s)#/);
    if (i >= 0) {
      comment = v.slice(i);
      v = v.slice(0, i);
    }
  }
  const lead = v.match(/^\s*/)![0];
  const trail = v.match(/\s*$/)![0];
  const core = v.slice(lead.length, v.length - trail.length);
  if (lead) out.push({ t: 'plain', v: lead });
  if (core) {
    if (/^[|>][-+]?\d*$/.test(core) || /^[[\]{},]+$/.test(core) || /^[&*!]\S*$/.test(core)) out.push({ t: 'punct', v: core });
    else if (YAML_LITERAL.test(core)) out.push({ t: 'literal', v: core });
    else if (YAML_NUMBER.test(core)) out.push({ t: 'number', v: core });
    else withTemplates(core, 'string', out);
  }
  if (trail) out.push({ t: 'plain', v: trail });
  if (comment) out.push({ t: 'comment', v: comment });
}

const YAML_KEY = /^(\s*)(-\s+)?((?:"[^"]*"|'[^']*'|[^\s#'"{[][^:#]*?))(\s*:)(?=\s|$)(.*)$/;
const YAML_ITEM = /^(\s*)(-)(\s.*|)$/;

export function tokenizeYaml(src: string): Token[] {
  const out: Token[] = [];
  const lines = src.split('\n');
  let block: number | null = null; // indentation of a `|` / `>` block scalar being read
  lines.forEach((line, i) => {
    if (i > 0) out.push({ t: 'plain', v: '\n' });
    const indent = line.match(/^\s*/)![0].length;
    if (block !== null) {
      if (!line.trim() || indent > block) {
        if (line) out.push({ t: 'string', v: line });
        return;
      }
      block = null;
    }
    if (/^\s*#/.test(line)) return out.push({ t: 'comment', v: line });
    if (/^(---|\.\.\.)\s*$/.test(line)) return out.push({ t: 'punct', v: line });
    const k = line.match(YAML_KEY);
    if (k) {
      if (k[1]) out.push({ t: 'plain', v: k[1] });
      if (k[2]) out.push({ t: 'punct', v: k[2] });
      out.push({ t: 'key', v: k[3] });
      out.push({ t: 'punct', v: k[4] });
      if (/^\s*[|>][-+]?\d*\s*$/.test(k[5])) block = indent + (k[2]?.length ?? 0);
      yamlValue(k[5], out);
      return;
    }
    const item = line.match(YAML_ITEM);
    if (item) {
      if (item[1]) out.push({ t: 'plain', v: item[1] });
      out.push({ t: 'punct', v: item[2] });
      yamlValue(item[3], out);
      return;
    }
    yamlValue(line, out);
  });
  return out;
}

export const tokenize = (src: string, language: 'json' | 'yaml') => (language === 'json' ? tokenizeJson(src) : tokenizeYaml(src));
