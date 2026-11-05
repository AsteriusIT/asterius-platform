import { createTheme, ScrollArea, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

/**
 * One theme for the whole portal, LibreChat-like: Inter, white canvas on a soft gray sidebar, neutral grays for
 * hover/active instead of colored fills, a single green accent, generous radii, shadows instead of borders.
 * Pages use Mantine components and these tokens; styles.css only adds the few rules Mantine props can't express.
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
  focusRing: 'never',
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
    Tabs: { defaultProps: { color: 'dark' } },
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
    '--surface': '#f9f9f9',
    '--surface-2': '#f3f3f3',
    '--surface-3': '#ececec',
    '--hairline': 'rgba(0, 0, 0, 0.06)',
    '--border-strong': '#c9c9c9',
    '--text-3': '#8f8f8f',
    '--code-bg': '#f6f6f6',
    '--card-shadow-hover': '0 0 0 1px rgba(0,0,0,0.06), 0 10px 30px rgba(0,0,0,0.08)',
  },
  dark: {
    '--mantine-color-body': '#212121',
    '--mantine-color-text': '#ececec',
    '--mantine-color-dimmed': '#b4b4b4',
    '--mantine-color-default-border': '#3a3a3a',
    '--mantine-color-default-hover': '#2c2c2c',
    '--surface': '#181818',
    '--surface-2': '#2c2c2c',
    '--surface-3': '#383838',
    '--hairline': 'rgba(255, 255, 255, 0.08)',
    '--border-strong': '#555555',
    '--text-3': '#8a8a8a',
    '--code-bg': '#1a1a1a',
    '--card-shadow-hover': '0 0 0 1px rgba(255,255,255,0.12), 0 10px 30px rgba(0,0,0,0.45)',
  },
});
