import { describe, expect, it } from 'vitest';
import { splitJobLog } from '../src/lib/workflow';

describe('splitJobLog', () => {
  it('splits the [job] prefix of copied CI logs', () => {
    expect(splitJobLog('[build] compiling')).toEqual({ job: 'build', text: 'compiling' });
    expect(splitJobLog('[log 12] a [b] c')).toEqual({ job: 'log 12', text: 'a [b] c' });
    expect(splitJobLog('Step succeeded')).toEqual({ job: null, text: 'Step succeeded' });
    expect(splitJobLog('[] x')).toEqual({ job: null, text: '[] x' });
  });
});
