import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ObjectSchema } from '@asterius/shared';
import { initialValues, orderedFields, SchemaForm, validateValues, type FormValues } from '../src/components/SchemaForm';
import { PropertyValue } from '../src/components/PropertyValue';
import { renderUi } from './render';

afterEach(cleanup);
vi.stubGlobal(
  'fetch',
  vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } })),
);

const schema: ObjectSchema = {
  properties: {
    name: { type: 'string', title: 'Name', pattern: '^[a-z-]+$', description: 'lowercase' },
    replicas: { type: 'integer', title: 'Replicas', default: 2 },
    public: { type: 'boolean', title: 'Public' },
    env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'] },
    tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
  },
  required: ['name', 'env'],
  order: ['env', 'name'],
};

describe('schema helpers', () => {
  it('orders fields, applies defaults and validates required + patterns', () => {
    expect(orderedFields(schema)).toEqual(['env', 'name', 'replicas', 'public', 'tags']);
    expect(initialValues(schema)).toEqual({ name: undefined, replicas: 2, public: false, env: undefined, tags: undefined });
    expect(validateValues(schema, { name: 'Bad Name' })).toEqual({ name: 'lowercase', env: 'Required' });
    expect(validateValues(schema, { name: 'ok', env: 'dev' })).toEqual({});
  });
});

describe('SchemaForm', () => {
  it('renders one input per property and reports changes', () => {
    const seen: FormValues[] = [];
    function Harness() {
      const [v, setV] = useState<FormValues>(initialValues(schema));
      return (
        <SchemaForm
          schema={schema}
          values={v}
          onChange={(n) => {
            seen.push(n);
            setV(n);
          }}
          errors={{ name: 'lowercase' }}
        />
      );
    }
    renderUi(<Harness />);
    expect(screen.getByText('lowercase', { selector: '.mantine-InputWrapper-error' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'billing' } });
    fireEvent.click(screen.getByLabelText('Public'));
    expect(seen.at(-1)).toMatchObject({ name: 'billing', public: true, replicas: 2 });
  });
});

describe('PropertyValue', () => {
  it('renders formats', () => {
    renderUi(
      <>
        <PropertyValue schema={{ type: 'string', format: 'url' }} value="https://example.com/x" />
        <PropertyValue schema={{ type: 'string', enum: ['prod'], enumColors: { prod: 'red' } }} value="prod" />
        <PropertyValue schema={{ type: 'string', format: 'entity', blueprint: 'service' }} value="api" />
        <PropertyValue value={null} />
      </>,
    );
    expect(screen.getByText('https://example.com/x').getAttribute('href')).toBe('https://example.com/x');
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.getByText('api').closest('a')?.getAttribute('href')).toBe('/catalog/service/api');
    expect(screen.getByText('—')).toBeTruthy();
  });
});
