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
  error,
  readOnly,
  minRows = 18,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange?: (v: string) => void;
  language: Language;
  label?: string;
  error?: string | null;
  readOnly?: boolean;
  minRows?: number;
  'aria-label'?: string;
}) {
  return (
    <Input.Wrapper label={label} error={error}>
      <div className="code-editor" data-error={error ? true : undefined} style={{ minHeight: `calc(${minRows} * 1.6em + 20px)` }}>
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

/** Read-only highlighted block (entity JSON, run payloads…). */
export function CodeBlock({ code, language = 'json' }: { code: string; language?: Language }) {
  return (
    <pre className="code-block">
      <Highlighted code={code} language={language} />
    </pre>
  );
}
