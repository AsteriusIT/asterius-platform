import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { IconChecklist } from '@tabler/icons-react';
import { NavItem } from '../src/components/NavItem';
import { ICON, ICON_DISPLAY } from '../src/components/iconScale';
import { renderUi } from './render';

afterEach(cleanup);

const icon = <IconChecklist size={ICON.lg} data-testid="icon" />;

describe('NavItem', () => {
  it('is a link with its label, a tour target and the active state', () => {
    renderUi(<NavItem to="/todo" label="To do" icon={icon} tour="todo" active />);
    const link = screen.getByRole('link', { name: 'To do' });
    expect(link.getAttribute('href')).toBe('/todo');
    expect(link.classList.contains('nav-link')).toBe(true);
    expect(link.getAttribute('data-tour')).toBe('todo');
    expect(link.hasAttribute('data-active')).toBe(true);
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.textContent).toBe('To do');
    expect(link.hasAttribute('data-end')).toBe(false);
  });

  it('keeps the icon a direct child of its slot, with or without a count', () => {
    renderUi(<NavItem to="/todo" label="To do" icon={icon} />);
    const slotOf = () => screen.getByTestId('icon').parentElement!;
    expect(slotOf().className).toBe('nav-item-icon');
    expect(slotOf().children).toHaveLength(1);
    cleanup();
    renderUi(<NavItem to="/todo" label="To do" icon={icon} count={3} ariaLabel="To do (3 waiting for you)" />);
    expect(slotOf().className).toBe('nav-item-icon');
    expect(slotOf().children).toHaveLength(1); // the badge lives at the end of the row, not around the icon
    const link = screen.getByRole('link', { name: 'To do (3 waiting for you)' });
    expect(link.querySelector('.nav-item-end')?.textContent).toBe('3');
    expect(link.querySelector('.nav-item-end')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByTestId('nav-item-dot')).toBeNull();
  });

  it('caps the count, hides it at 0 and shows other trailing content', () => {
    renderUi(<NavItem to="/todo" label="To do" icon={icon} count={120} />);
    expect(screen.getByRole('link').querySelector('.nav-item-end')?.textContent).toBe('99+');
    cleanup();
    renderUi(<NavItem to="/todo" label="To do" icon={icon} count={0} />);
    expect(screen.getByRole('link').querySelector('.nav-item-end')).toBeNull();
    cleanup();
    renderUi(<NavItem to="/catalog" label="Catalog" icon={icon} end={42} />);
    expect(screen.getByRole('link', { name: 'Catalog' }).querySelector('.nav-item-end')?.textContent).toBe('42');
  });

  it('folds to the icon: no label or badge, a dot for the count, the name kept for assistive tech', () => {
    renderUi(<NavItem to="/todo" label="To do" icon={icon} count={2} mini ariaLabel="To do (2 waiting for you)" />);
    const link = screen.getByRole('link', { name: 'To do (2 waiting for you)' });
    expect(link.textContent).toBe('');
    expect(link.hasAttribute('data-mini')).toBe(true);
    expect(link.querySelector('.nav-item-end')).toBeNull();
    expect(screen.getByTestId('nav-item-dot').parentElement).toBe(screen.getByTestId('icon').parentElement);
  });

  it('has no dot when folded without a count', () => {
    renderUi(<NavItem to="/todo" label="To do" icon={icon} mini />);
    expect(screen.queryByTestId('nav-item-dot')).toBeNull();
  });

  it('is a button without a route, with a second line, and forwards props and clicks', () => {
    const onClick = vi.fn();
    renderUi(<NavItem label="Ada Admin" description="ada@example.com" ariaLabel="Account" icon={icon} onClick={onClick} aria-expanded="false" />);
    const button = screen.getByRole('button', { name: 'Account' });
    expect(button.textContent).toBe('Ada Adminada@example.com');
    expect(button.hasAttribute('data-two-line')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('icon scale', () => {
  it('has three functional sizes and larger display sizes', () => {
    expect(ICON).toEqual({ sm: 14, md: 16, lg: 18 });
    expect(Math.min(...Object.values(ICON_DISPLAY))).toBeGreaterThan(ICON.lg);
  });
});
