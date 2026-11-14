import { MultiSelect } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * The `workflows` restriction of an API token (token forms of the profile and of service accounts): the token lists and
 * starts only these workflows, reads only their runs and cannot approve. This is how an AI agent is scoped.
 */
export function TokenWorkflows({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const actions = useQuery({ queryKey: ['actions', 'all'], queryFn: () => api.actions(), staleTime: 60_000 });
  return (
    <MultiSelect
      label="Restrict to workflows"
      description="For automations and AI agents: the token only lists and starts these workflows, only reads their runs and cannot approve. Empty: no restriction."
      placeholder={value.length ? undefined : 'Any workflow'}
      searchable
      clearable
      data={(actions.data ?? []).map((a) => ({ value: a.identifier, label: a.title }))}
      value={value}
      onChange={onChange}
    />
  );
}
