/**
 * The Asterius design tokens, defined once. `theme.ts` builds the Mantine theme from them and `scripts/build-css.mjs`
 * writes them to `brand.css` as plain CSS custom properties (for pages without Mantine: the hosted sign-in pages of
 * Asterius Identity). Plain data only, no imports: the build script loads this file with Node's type stripping.
 *
 * One green accent: #10a37f (`brand[6]`) is the primary of both products' consoles (filled buttons, selection).
 * Pages that set white text on the accent without Mantine's contrast handling use `brand[8]` (#0b7a5e, AA on white
 * and under white text), exposed as `--brand-accent-strong`.
 */

/** Ten shades of the accent, Mantine order (0 lightest). */
export const brandColors = ['#e7f6f2', '#cdeee4', '#9ddcc8', '#6acaab', '#40ba93', '#22ad85', '#10a37f', '#0e906f', '#0b7a5e', '#06644c'] as const;

/** LibreChat dark grays: body #212121, sidebar #181818, hover #2c2c2c, borders #3a3a3a. */
export const darkColors = ['#ececec', '#b4b4b4', '#8a8a8a', '#6b6b6b', '#3a3a3a', '#2c2c2c', '#262626', '#212121', '#181818', '#0d0d0d'] as const;

/** Index of the primary shade in `brandColors` (both schemes). */
export const primaryShade = 6;
/** Index of the strong accent (hosted pages' default filled buttons and links). */
export const accentStrongShade = 8;

export const white = '#ffffff';
export const black = '#0d0d0d';

/** Inter Variable is bundled by each app (@fontsource-variable/inter); the rest is the fallback stack. */
export const fontFamily = "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const fontFamilyMonospace = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
export const headingFontWeight = '600';
/** Text that names no size: one step between sm and md. */
export const bodyFontSize = '15px';

/** Mantine's own font sizes (px), unchanged by the theme; listed for brand.css. */
export const baseFontSizes = { xs: 12, sm: 14, md: 16, lg: 18, xl: 20 } as const;
/** Steps the theme adds to the type scale (px). */
export const extraFontSizes = {
  '3xs': 10, // kickers of graph nodes, initials in a 20px avatar
  '2xs': 11, // captions: third line of a graph node, group titles in a picker
  dense: 12.5, // between xs and sm: monospace blocks (code, logs) and table headers
} as const;

/** Mantine's own spacing (px), unchanged by the theme; listed for brand.css. */
export const baseSpacing = { xs: 10, sm: 12, md: 16, lg: 20, xl: 32 } as const;
/** Steps the theme adds to the spacing scale (px). */
export const extraSpacing = {
  '4xs': 2, // a title and its subtitle
  '3xs': 4, // an icon and its label, badges of a row
  '2xs': 6, // controls of a toolbar, a kicker and its content
} as const;

export const radius = { xs: '6px', sm: '8px', md: '12px', lg: '16px', xl: '20px' } as const;

/** Light-scheme shadows (the dark scheme overrides them in `schemeVariables.dark`). */
export const shadows = {
  xs: '0 1px 2px rgba(0,0,0,0.04), 0 1px 6px rgba(0,0,0,0.04)',
  sm: '0 0 0 1px rgba(0,0,0,0.05), 0 2px 10px rgba(0,0,0,0.04)',
  md: '0 4px 24px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.04)',
  lg: '0 8px 32px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06)',
} as const;

/** Surfaces and text shades for both schemes (Mantine's cssVariablesResolver, also used by the stylesheets). */
export const schemeVariables = {
  light: {
    '--mantine-color-body': '#ffffff',
    '--mantine-color-text': '#0d0d0d',
    '--mantine-color-dimmed': '#5d5d5d',
    '--mantine-color-default-border': '#e3e3e3',
    '--mantine-color-default-hover': '#f3f3f3',
    // AA on white: placeholders, field errors and links
    '--mantine-color-placeholder': '#767676',
    '--mantine-color-error': '#e03131',
    '--mantine-color-anchor': '#0b7a5e',
    '--surface': '#f9f9f9',
    '--surface-2': '#f3f3f3',
    '--surface-3': '#ececec',
    '--surface-raised': '#ffffff',
    '--surface-overlay': '#ffffff',
    '--hairline': 'rgba(0, 0, 0, 0.06)',
    '--border-strong': '#c9c9c9',
    // 4.5:1 on white and on --surface
    '--text-3': '#6f6f6f',
    '--code-bg': '#f6f6f6',
    '--focus-ring': '#0e906f',
    '--focus-border': '#8f8f8f',
    '--focus-halo': 'rgba(0, 0, 0, 0.07)',
    // tables: translucent so they sit on any surface
    '--table-head-bg': 'rgba(0, 0, 0, 0.022)',
    '--table-row-hover': 'rgba(0, 0, 0, 0.028)',
    '--table-row-selected': 'rgba(16, 163, 127, 0.1)',
    '--table-row-selected-hover': 'rgba(16, 163, 127, 0.15)',
    '--card-shadow-hover': '0 0 0 1px rgba(0,0,0,0.06), 0 10px 30px rgba(0,0,0,0.08)',
    // syntax highlighting (JSON / YAML views)
    '--tok-key': '#0e7490',
    '--tok-string': '#15803d',
    '--tok-number': '#b45309',
    '--tok-literal': '#7c3aed',
    '--tok-comment': '#6f6f6f',
    '--tok-punct': '#6b7280',
    '--tok-template': '#c026d3',
  },
  dark: {
    '--mantine-color-body': '#212121',
    '--mantine-color-text': '#ececec',
    '--mantine-color-dimmed': '#b4b4b4',
    '--mantine-color-default-border': '#454545',
    '--mantine-color-default-hover': '#363636',
    '--mantine-color-placeholder': '#8f8f8f',
    '--mantine-color-error': '#ff8787',
    // Neutral `light` fills (gray badges, buttons): Mantine's are near black, a hole in a raised surface.
    '--mantine-color-gray-light': 'rgba(255, 255, 255, 0.08)',
    '--mantine-color-gray-light-hover': 'rgba(255, 255, 255, 0.13)',
    '--mantine-color-gray-light-color': '#dcdcdc',
    '--surface': '#181818',
    '--surface-2': '#2c2c2c',
    '--surface-3': '#383838',
    '--surface-raised': '#2a2a2a',
    '--surface-overlay': '#303030',
    '--hairline': 'rgba(255, 255, 255, 0.09)',
    '--border-strong': '#5e5e5e',
    // 4.5:1 on every surface up to --surface-overlay
    '--text-3': '#9c9c9c',
    '--code-bg': '#1a1a1a',
    '--focus-ring': '#40ba93',
    '--focus-border': '#8a8a8a',
    '--focus-halo': 'rgba(255, 255, 255, 0.12)',
    '--table-head-bg': 'rgba(255, 255, 255, 0.035)',
    '--table-row-hover': 'rgba(255, 255, 255, 0.05)',
    '--table-row-selected': 'rgba(16, 163, 127, 0.16)',
    '--table-row-selected-hover': 'rgba(16, 163, 127, 0.22)',
    // Shadows cannot separate surfaces on a dark canvas: each level also draws a 1px light ring.
    '--mantine-shadow-xs': '0 0 0 1px rgba(255,255,255,0.07), 0 1px 2px rgba(0,0,0,0.24)',
    '--mantine-shadow-sm': '0 0 0 1px rgba(255,255,255,0.08), 0 2px 8px rgba(0,0,0,0.24)',
    '--mantine-shadow-md': '0 0 0 1px rgba(255,255,255,0.1), 0 6px 24px rgba(0,0,0,0.4)',
    '--mantine-shadow-lg': '0 0 0 1px rgba(255,255,255,0.11), 0 12px 36px rgba(0,0,0,0.5)',
    '--mantine-shadow-xl': '0 0 0 1px rgba(255,255,255,0.11), 0 20px 56px rgba(0,0,0,0.6)',
    '--card-shadow-hover': '0 0 0 1px rgba(255,255,255,0.18), 0 10px 30px rgba(0,0,0,0.45)',
    '--tok-key': '#67e8f9',
    '--tok-string': '#86efac',
    '--tok-number': '#fcd34d',
    '--tok-literal': '#c4b5fd',
    '--tok-comment': '#8e8e8e',
    '--tok-punct': '#9ca3af',
    '--tok-template': '#f0abfc',
  },
} as const;
