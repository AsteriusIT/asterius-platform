import { createTheme, ScrollArea, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

/**
 * One theme for the whole portal, LibreChat-like: Inter, white canvas on a soft gray sidebar, neutral grays for
 * hover/active instead of colored fills, a single green accent, generous radii, shadows instead of borders.
 * Pages use Mantine components and these tokens; styles.css only adds the few rules Mantine props can't express.
 *
 * Elevation (same tokens in both schemes, see cssVariablesResolver):
 *   shell    --surface              sidebar, top bar, flow canvas
 *   canvas   --mantine-color-body   the page panel
 *   raised   --surface-raised       cards, papers, tables
 *   overlay  --surface-overlay      menus, popovers, modals, drawers, notifications
 * In light the steps are told apart by shadows. Black shadows do not show on a dark canvas, so in dark each step
 * is a lighter gray and the `--mantine-shadow-*` values carry a 1px light ring.
 */

// Accent #10a37f at index 6.
const brand: MantineColorsTuple = ['#e7f6f2', '#cdeee4', '#9ddcc8', '#6acaab', '#40ba93', '#22ad85', '#10a37f', '#0e906f', '#0b7a5e', '#06644c'];

// LibreChat dark grays: body #212121, sidebar #181818, hover #2c2c2c, borders #3a3a3a.
const dark: MantineColorsTuple = ['#ececec', '#b4b4b4', '#8a8a8a', '#6b6b6b', '#3a3a3a', '#2c2c2c', '#262626', '#212121', '#181818', '#0d0d0d'];

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 6 },
  colors: { brand, dark },
  white: '#ffffff',
  black: '#0d0d0d',
  fontFamily: "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  headings: { fontWeight: '600' },
  defaultRadius: 'md',
  radius: { xs: '6px', sm: '8px', md: '12px', lg: '16px', xl: '20px' },
  cursorType: 'pointer',
  // Keyboard focus only (:focus-visible): the ring is styled in styles.css with --focus-ring.
  focusRing: 'auto',
  shadows: {
    xs: '0 1px 2px rgba(0,0,0,0.04), 0 1px 6px rgba(0,0,0,0.04)',
    sm: '0 0 0 1px rgba(0,0,0,0.05), 0 2px 10px rgba(0,0,0,0.04)',
    md: '0 4px 24px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.04)',
    lg: '0 8px 32px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06)',
  },
  components: {
    Button: { defaultProps: { radius: 'md', fw: 500 } },
    ActionIcon: { defaultProps: { radius: 'md' } },
    Card: { defaultProps: { radius: 'xl', padding: 'lg', withBorder: false, shadow: 'sm' } },
    Paper: { defaultProps: { radius: 'lg', withBorder: false, shadow: 'sm' } },
    Badge: { defaultProps: { variant: 'light', radius: 'xl', tt: 'none', fw: 500, size: 'md' } },
    Table: { defaultProps: { highlightOnHover: true, verticalSpacing: 'sm', horizontalSpacing: 'md' } },
    // Overlay scrollbars inside dialogs (native ones are drawn inside the rounded panel).
    Modal: {
      defaultProps: {
        centered: true,
        radius: 'xl',
        padding: 'lg',
        overlayProps: { backgroundOpacity: 0.35, blur: 3 },
        scrollAreaComponent: ScrollArea.Autosize,
      },
    },
    ScrollArea: { defaultProps: { scrollbarSize: 8, type: 'hover' } },
    Drawer: { defaultProps: { overlayProps: { backgroundOpacity: 0.25, blur: 2 } } },
    Menu: { defaultProps: { radius: 'lg', shadow: 'lg' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 300, radius: 'md', color: 'dark' } },
    // The text colour of the scheme: `dark` is the page colour itself in dark mode, the active underline vanished.
    Tabs: { defaultProps: { color: 'var(--mantine-color-text)' } },
    Notification: { defaultProps: { radius: 'lg' } },
    ThemeIcon: { defaultProps: { radius: 'md', variant: 'light' } },
    Avatar: { defaultProps: { color: 'brand' } },
    // Help text under the input: inputs of a row stay aligned whether or not they have a description.
    InputWrapper: { defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] } },
  },
});

/** Surfaces and text shades for both schemes (also used by styles.css). */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
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
});
