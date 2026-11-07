import { useMemo } from 'react';
import { Input } from '@mantine/core';
import { tokenize } from '../lib/highlight';

/**
 * JSON / YAML editor with syntax highlighting: a real <textarea> (transparent text, visible caret) laid over a
 * highlighted <pre> in the same grid cell, so the pre sizes the box and both wrap identically. No editor
 * dependency, and the textarea keeps native editing, undo, selection and accessibility.
 */

type Language = 'json' | 'yaml';

function Highlighted({ code, language }: { code: string; language: Language }) {
  const tokens = useMemo(() => tokenize(code, language), [code, language]);
  return (
    <>
      {tokens.map((tk, i) =>
        tk.t === 'plain' ? (
          tk.v
        ) : (
          <span key={i} className={`tok-${tk.t}`}>
            {tk.v}
          </span>
        ),
      )}
    </>
  );
}

export function CodeEditor({
  value,
  onChange,
  language,
  label,
  description,
  required,
  error,
  readOnly,
  minRows = 18,
  maxRows,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange?: (v: string) => void;
  language: Language;
  label?: string;
  description?: string;
  required?: boolean;
  error?: string | null;
  readOnly?: boolean;
  minRows?: number;
  /** Past this height the editor scrolls (both layers together). Default: grows with the content. */
  maxRows?: number;
  'aria-label'?: string;
}) {
  return (
    <Input.Wrapper label={label} description={description} required={required} error={error}>
      <div
        className="code-editor"
        data-error={error ? true : undefined}
        style={{ minHeight: `calc(${minRows} * 1.6em + 20px)`, ...(maxRows ? { maxHeight: `calc(${maxRows} * 1.6em + 20px)`, overflowY: 'auto' } : {}) }}
      >
        <pre aria-hidden className="code-editor-layer">
          <Highlighted code={value} language={language} />
          {/* keeps the last empty line tall enough for the caret */}
          {'\n '}
        </pre>
        <textarea
          className="code-editor-layer code-editor-input"
          value={value}
          onChange={(e) => onChange?.(e.currentTarget.value)}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label={ariaLabel ?? label ?? `${language.toUpperCase()} document`}
          onKeyDown={(e) => {
            // Tab indents (two spaces) instead of leaving the editor; Shift+Tab / Esc still move focus.
            if (e.key !== 'Tab' || e.shiftKey || readOnly) return;
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: s, selectionEnd: end } = t;
            const next = `${value.slice(0, s)}  ${value.slice(end)}`;
            onChange?.(next);
            requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
          }}
        />
      </div>
    </Input.Wrapper>
  );
}

/** Read-only highlighted block (entity JSON, run payloads…). Use it for every JSON / YAML shown to people. */
export function CodeBlock({
  code,
  language = 'json',
  maxHeight,
  'aria-label': ariaLabel,
}: {
  code: string;
  language?: Language;
  /** Past this height the block scrolls. */
  maxHeight?: number;
  'aria-label'?: string;
}) {
  return (
    <pre className="code-block" aria-label={ariaLabel} style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <Highlighted code={code} language={language} />
    </pre>
  );
}

/** One-line highlighted snippet (compact JSON in tables and lists). */
export function InlineCode({ code, language = 'json' }: { code: string; language?: Language }) {
  return (
    <code className="code-inline">
      <Highlighted code={code} language={language} />
    </code>
  );
}

/** Pretty-printed JSON of a value, highlighted. */
export const JsonBlock = ({ value, maxHeight, 'aria-label': ariaLabel }: { value: unknown; maxHeight?: number; 'aria-label'?: string }) => (
  <CodeBlock code={JSON.stringify(value, null, 2) ?? 'undefined'} maxHeight={maxHeight} aria-label={ariaLabel} />
);
