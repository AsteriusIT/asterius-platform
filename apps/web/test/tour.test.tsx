import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { cardPosition, Tour, type TourStep } from '../src/components/Tour';
import { renderUi } from './render';

afterEach(cleanup);

const steps: TourStep[] = [
  { title: 'Welcome', body: 'Hello' },
  { target: 'nav', title: 'Navigation', body: 'Go places' },
  { target: 'missing', title: 'Not on this page', body: 'Centered' },
  { title: 'Done!', body: 'Bye', finishLabel: 'Start' },
];

describe('cardPosition', () => {
  it('centers without a target', () => {
    expect(cardPosition(null, undefined, 200, 1000, 800)).toEqual({ top: 300, left: 330 });
  });
  it('goes right of the target, and below when there is no room on the right', () => {
    const rect = { top: 100, left: 10, width: 200, height: 40 };
    expect(cardPosition(rect, 'right', 200, 1200, 800).left).toBe(10 + 200 + 6 + 14);
    const wide = { top: 100, left: 900, width: 280, height: 40 };
    expect(cardPosition(wide, 'right', 200, 1200, 800).top).toBe(100 + 40 + 6 + 14);
  });
  it('stays inside the viewport', () => {
    const p = cardPosition({ top: 780, left: 1180, width: 10, height: 10 }, 'bottom', 200, 1200, 800);
    expect(p.top).toBeLessThanOrEqual(800 - 200 - 12);
    expect(p.left).toBeLessThanOrEqual(1200 - 340 - 12);
  });
});

describe('Tour', () => {
  it('walks through the steps, with buttons and keyboard, and completes', () => {
    const onClose = vi.fn();
    renderUi(
      <>
        <nav data-tour="nav" style={{ width: 100, height: 20 }}>
          nav
        </nav>
        <Tour steps={steps} opened onClose={onClose} />
      </>,
    );
    expect(screen.getByRole('dialog').textContent).toContain('1 of 4');
    fireEvent.click(screen.getByText('Show me around'));
    expect(screen.getByText('Navigation')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Not on this page')).toBeTruthy(); // missing target: still shown (centered)
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('Navigation')).toBeTruthy();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.queryByText('Skip tour')).toBeNull(); // last step
    fireEvent.click(screen.getByText('Start'));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('can be skipped with the button or Escape', () => {
    const onClose = vi.fn();
    renderUi(<Tour steps={steps} opened onClose={onClose} />);
    fireEvent.click(screen.getByText('Skip tour'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose.mock.calls).toEqual([[false], [false]]);
  });

  it('renders nothing when closed', () => {
    renderUi(<Tour steps={steps} opened={false} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
