/**
 * Icon size scale (px). Stroke width, `display: block` and `flex-shrink: 0` are set once for every Tabler icon in
 * base.css (`.tabler-icon`): call sites pass a size only, never `stroke`.
 *
 * - `sm`: inline with small text — badges, xs / compact buttons, table sort arrows, trailing chevrons.
 * - `md`: the default — buttons, menu items, inputs, tabs, action icons.
 * - `lg`: navigation (sidebar, header), alerts, icons in a ThemeIcon tile.
 */
export const ICON = { sm: 14, md: 16, lg: 18 } as const;

/** Display sizes: icons that are the subject of a block (empty states, error pages), not a companion of text. */
export const ICON_DISPLAY = { md: 32, lg: 40 } as const;
