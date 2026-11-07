import { useState, type ReactNode } from 'react';
import { Alert, Button, Card, Group, Modal, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { IconSparkles } from '@tabler/icons-react';
import { api, errorText } from '../lib/api';
import { JsonBlock } from './CodeEditor';
import { Markdown } from './ui';

/** The AI helpers of the portal. They only render when the platform has a model configured. */

export function useAiEnabled() {
  const q = useQuery({ queryKey: ['ai-status'], queryFn: api.aiStatus, staleTime: 5 * 60_000, retry: false });
  return q.data?.enabled === true;
}

const cost = (usd: number | null | undefined) => (usd ? ` · AI cost $${usd.toFixed(4)}` : '');

/** Ask a question about the catalog in natural language. */
export function AskCatalog() {
  const enabled = useAiEnabled();
  const [question, setQuestion] = useState('');
  const ask = useMutation({ mutationFn: () => api.aiAsk(question.trim()) });
  if (!enabled) return null;
  return (
    <Stack gap="xs">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim().length >= 3) ask.mutate();
        }}
      >
        <Group gap="xs" wrap="nowrap">
          <TextInput
            flex={1}
            aria-label="Ask the catalog"
            placeholder="Ask the catalog: which services owned by payments have no on-call?"
            leftSection={<IconSparkles size={16} />}
            value={question}
            onChange={(e) => setQuestion(e.currentTarget.value)}
            maxLength={2000}
          />
          <Button type="submit" loading={ask.isPending} disabled={question.trim().length < 3}>
            Ask
          </Button>
        </Group>
      </form>
      {ask.error && (
        <Alert color="red" variant="light">
          {errorText(ask.error)}
        </Alert>
      )}
      {ask.data && (
        <Card>
          <Markdown>{ask.data.answer}</Markdown>
          <Text fz="xs" c="dimmed" mt="xs">
            AI answer, check the entities it names{cost(ask.data.costUsd)}
          </Text>
        </Card>
      )}
    </Stack>
  );
}

/** Explain a run (why it failed, or what it did) or summarise its logs. */
export function ExplainRun({ runId, failed }: { runId: string; failed: boolean }) {
  const enabled = useAiEnabled();
  const explain = useMutation({ mutationFn: (mode: 'explain' | 'summarise') => api.aiExplainRun(runId, mode) });
  if (!enabled) return null;
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Button
          size="xs"
          variant={failed ? 'filled' : 'default'}
          leftSection={<IconSparkles size={14} />}
          loading={explain.isPending && explain.variables === 'explain'}
          onClick={() => explain.mutate('explain')}
        >
          {failed ? 'Why did it fail?' : 'Explain this run'}
        </Button>
        <Button size="xs" variant="default" loading={explain.isPending && explain.variables === 'summarise'} onClick={() => explain.mutate('summarise')}>
          Summarise logs
        </Button>
      </Group>
      {explain.error && (
        <Alert color="red" variant="light">
          {errorText(explain.error)}
        </Alert>
      )}
      {explain.data && (
        <Card>
          <Markdown>{explain.data.answer}</Markdown>
          <Text fz="xs" c="dimmed" mt="xs">
            AI generated from the run steps and logs, verify before acting{cost(explain.data.costUsd)}
          </Text>
        </Card>
      )}
    </Stack>
  );
}

/**
 * "Draft with AI" for authoring forms: describe what you want (or paste a sample), review the draft, apply it to the form.
 * Nothing is saved by the assistant.
 */
export function AiDraft<T>(props: {
  label: string;
  title: string;
  help: string;
  placeholder: string;
  /** Extra controls above the text area (e.g. the target blueprint). */
  extra?: ReactNode;
  run: (text: string) => Promise<T>;
  /** Render the draft for review; without it the draft is applied at once. */
  preview?: (draft: T) => ReactNode;
  onDraft: (draft: T) => void;
  disabled?: boolean;
}) {
  const enabled = useAiEnabled();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const draft = useMutation({
    mutationFn: () => props.run(text),
    onSuccess: (d) => {
      if (!props.preview) {
        props.onDraft(d);
        setOpen(false);
      }
    },
  });
  if (!enabled) return null;
  const close = () => {
    setOpen(false);
    draft.reset();
  };
  return (
    <>
      <Button variant="light" size="xs" leftSection={<IconSparkles size={14} />} disabled={props.disabled} onClick={() => setOpen(true)}>
        {props.label}
      </Button>
      <Modal opened={open} onClose={close} title={props.title} size="lg">
        <Stack>
          <Text fz="sm" c="dimmed">
            {props.help}
          </Text>
          {props.extra}
          <Textarea autosize minRows={5} maxRows={14} placeholder={props.placeholder} value={text} onChange={(e) => setText(e.currentTarget.value)} />
          {draft.error && (
            <Alert color="red" variant="light">
              {errorText(draft.error)}
            </Alert>
          )}
          {draft.data !== undefined && props.preview && props.preview(draft.data)}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button
              variant={draft.data !== undefined && props.preview ? 'default' : 'filled'}
              loading={draft.isPending}
              disabled={!text.trim()}
              onClick={() => draft.mutate()}
            >
              {draft.data !== undefined && props.preview ? 'Draft again' : 'Draft'}
            </Button>
            {draft.data !== undefined && props.preview && (
              <Button
                onClick={() => {
                  props.onDraft(draft.data as T);
                  close();
                }}
              >
                Use this draft
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/** Pretty JSON, for draft previews. */
export const JsonPreview = ({ value }: { value: unknown }) => <JsonBlock value={value} maxHeight={280} />;

/** Parse text as JSON when it looks like JSON, otherwise treat it as a description. */
export function parseSample(text: string): { sample?: unknown; description?: string } {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return { sample: JSON.parse(t) as unknown };
    } catch {
      /* not JSON: a description */
    }
  }
  return { description: t };
}
