import type { ModelInfo } from '@asterius/shared';

/** Models offered to agent steps, with $ per million tokens (input, output). Served by /api/meta. */
export const MODELS: ModelInfo[] = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: 'Default · best reasoning', inputPrice: 4, outputPrice: 20 },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'Fast and capable', inputPrice: 2, outputPrice: 10 },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: 'Fastest, cheapest', inputPrice: 0.1, outputPrice: 0.5 },
  { value: 'claude-fable-5-1', label: 'Claude Fable 5.1', description: 'Most capable', inputPrice: 10, outputPrice: 50 },
];

export const PRICES: Record<string, [number, number]> = Object.fromEntries(MODELS.map((m) => [m.value, [m.inputPrice, m.outputPrice]]));
