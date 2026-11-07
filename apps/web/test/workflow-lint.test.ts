import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '@asterius/shared';
import { stepWarnings } from '../src/lib/workflow';

const agent = { id: 'ai', type: 'agent', prompt: 'x' } as WorkflowStep;
const call = { id: 'call', type: 'invoke', invoker: { type: 'webhook', body: '{{ steps.ai.output.text }}' } } as unknown as WorkflowStep;
const approval = { id: 'ok', type: 'approval' } as WorkflowStep;

describe('stepWarnings', () => {
  it('warns when an agent output feeds an invoke step without approval', () => {
    expect(stepWarnings([agent, call])).toHaveLength(1);
  });
  it('follows transforms', () => {
    const t = { id: 't', type: 'transform', output: { v: 'steps.ai.output.text' } } as WorkflowStep;
    const c2 = { id: 'call', type: 'invoke', invoker: { type: 'webhook', body: '{{ steps.t.output.v }}' } } as unknown as WorkflowStep;
    expect(stepWarnings([agent, t, c2])).toHaveLength(1);
  });
  it('is quiet when an approval sits between', () => {
    expect(stepWarnings([agent, approval, call])).toEqual([]);
  });
  it('is quiet when no agent output is used', () => {
    expect(stepWarnings([agent, { ...call, invoker: { type: 'webhook' } } as WorkflowStep])).toEqual([]);
  });
});
