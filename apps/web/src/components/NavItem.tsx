import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Badge, Tooltip, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router';

export interface NavItemProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** Route: the item is a link. Without it, a button (e.g. the target of a menu). */
  to?: string;
  label: string;
  /** Second line under the label (organization role, account e-mail). */
  description?: ReactNode;
  /** An icon or an avatar: centered in a fixed slot, so every label starts on the same line whatever its size. */
  icon: ReactNode;
  active?: boolean;
  /** Folded sidebar: icon only, the label moves to a tooltip (and stays the accessible name). */
  mini?: boolean;
  /** Things waiting: a badge at the end of the row, a dot on the icon when folded. Hidden when 0. */
  count?: number;
  /** Quiet content at the end of the row (a total, a chevron). Hidden when folded. */
  end?: ReactNode;
  /** Accessible name and tooltip when they say more than the label ("To do (2 waiting for you)"). */
  ariaLabel?: string;
  /** Target of the onboarding tour (`data-tour`). */
  tour?: string;
}

/**
 * One row of the sidebar. The count badge, the dot and the trailing content are positioned absolutely: they never
 * move the icon or the label, which are the only two things in the flow.
 */
export const NavItem = forwardRef<HTMLElement, NavItemProps>(function NavItem(
  { to, label, description, icon, active, mini, count, end, ariaLabel, tour, className, ...rest },
  ref,
) {
  const hasCount = !!count && count > 0;
  const hasEnd = !mini && (hasCount || end != null);
  const body = (
    <>
      <span className="nav-item-icon">
        {icon}
        {mini && hasCount && <span className="nav-item-dot" data-testid="nav-item-dot" />}
      </span>
      {!mini && (
        <span className="nav-item-body">
          <span className="nav-item-label">{label}</span>
          {description != null && <span className="nav-item-description">{description}</span>}
        </span>
      )}
      {hasEnd && (
        <span className="nav-item-end" aria-hidden>
          {hasCount ? (
            <Badge size="sm" color="yellow" variant="filled">
              {count > 99 ? '99+' : count}
            </Badge>
          ) : (
            end
          )}
        </span>
      )}
    </>
  );
  const shared = {
    ...rest,
    className: className ? `nav-link ${className}` : 'nav-link',
    'aria-label': ariaLabel ?? label,
    'data-tour': tour,
    'data-active': active || undefined,
    'data-mini': mini || undefined,
    'data-end': hasEnd || undefined,
    'data-two-line': (!mini && description != null) || undefined,
  };
  return (
    <Tooltip label={ariaLabel ?? label} position="right" disabled={!mini} openDelay={0}>
      {to !== undefined ? (
        <UnstyledButton {...shared} ref={ref as React.Ref<HTMLAnchorElement>} component={Link} to={to} aria-current={active ? 'page' : undefined}>
          {body}
        </UnstyledButton>
      ) : (
        <UnstyledButton {...shared} ref={ref as React.Ref<HTMLButtonElement>}>
          {body}
        </UnstyledButton>
      )}
    </Tooltip>
  );
});
