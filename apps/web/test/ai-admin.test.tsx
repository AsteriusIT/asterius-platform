import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { AiAdmin } from '../src/pages/admin/AiAdmin';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AiAdmin prices', () => {
  it('shows prices read-only with a platform-wide hint', async () => {
    vi.spyOn(api, 'aiUsage').mockResolvedValue({
      totals: { costUsd: 0, calls: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
      byModel: [],
      byAction: [],
      byTeam: [],
    } as never);
    vi.spyOn(api, 'aiReviews').mockResolvedValue([]);
    vi.spyOn(api, 'aiBudgets').mockResolvedValue([]);
    vi.spyOn(api, 'aiPrices').mockResolvedValue([{ model: 'm1', input: 1, output: 2, cacheWrite: 3, cacheRead: 4, source: 'builtin' } as never]);
    renderUi(<AiAdmin />);
    await screen.findByText('m1');
    expect(screen.getByText(/only super admins can change them/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText(/price/i)).toBeNull());
  });
});
