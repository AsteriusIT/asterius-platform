import { Stack, Textarea, TextInput } from '@mantine/core';
import { IconSettings } from '@tabler/icons-react';
import { MONO_INPUT } from './blocks';
import { FormBuilder, identityProblems, IdentityFields, type EditorProps } from './FormBuilder';

/** Form editor of teams (webhooks use WebhookForm). */

// ---------- teams ----------

export interface TeamDoc {
  identifier: string;
  title: string;
  description: string;
  entraGroupId: string | null;
  [k: string]: unknown;
}

export const toTeamDoc = (v: Record<string, unknown>): TeamDoc => ({
  ...v,
  identifier: String(v.identifier ?? ''),
  title: String(v.title ?? ''),
  description: String(v.description ?? ''),
  entraGroupId: (v.entraGroupId as string) || null,
});

export function TeamBuilder(props: EditorProps) {
  return (
    <FormBuilder<TeamDoc>
      {...props}
      size="xl"
      noun="team"
      toDoc={toTeamDoc}
      problems={identityProblems}
      tabs={[
        {
          value: 'general',
          label: 'Team',
          icon: <IconSettings size={16} />,
          render: (ctx) => (
            <Stack gap="md">
              <IdentityFields {...ctx} placeholder="Platform team" />
              <Textarea
                label="Description"
                autosize
                minRows={2}
                value={ctx.doc.description}
                onChange={(e) => ctx.set({ description: e.currentTarget.value })}
              />
              <TextInput
                label="Entra ID group"
                description="Object id of an Entra ID group: membership is then managed there and synchronised at sign-in"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={ctx.doc.entraGroupId ?? ''}
                onChange={(e) => ctx.set({ entraGroupId: e.currentTarget.value.trim() || null })}
                styles={MONO_INPUT}
              />
            </Stack>
          ),
        },
      ]}
    />
  );
}
