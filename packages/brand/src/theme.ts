import { createTheme, rem, ScrollArea, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';
import {
  black,
  brandColors as brandTokens,
  darkColors as darkTokens,
  extraFontSizes,
  extraSpacing,
  fontFamily,
  fontFamilyMonospace,
  headingFontWeight,
  primaryShade,
  radius,
  schemeVariables,
  shadows,
  white,
} from './tokens';

/**
 * One theme for the Asterius consoles (Platform, Identity), LibreChat-like: Inter, white canvas on a soft gray sidebar, neutral grays for
 * hover/active instead of colored fills, a single green accent, generous radii, shadows instead of borders.
 * Pages use Mantine components and these tokens; base.css (this package) and each app's stylesheet only add the few rules Mantine props can't express.
 *
 * Elevation (same tokens in both schemes, see cssVariablesResolver):
 *   shell    --surface              sidebar, top bar, flow canvas
 *   canvas   --mantine-color-body   the page panel
 *   raised   --surface-raised       cards, papers, tables
 *   overlay  --surface-overlay      menus, popovers, modals, drawers, notifications
 * In light the steps are told apart by shadows. Black shadows do not show on a dark canvas, so in dark each step
 * is a lighter gray and the `--mantine-shadow-*` values carry a 1px light ring.
 *
 * Scales (the table is in asterius-platform docs/EXTENDING.md, "UI conventions"): call sites name a step, never a pixel value.
 *   type     fontSizes 3xs…xl + `dense`; the big figures are `fz="h1"` / `fz="h2"` (asterius-platform: components/ui.tsx, StatValue)
 *   spacing  4xs…xl, used by every `gap`, `p*`, `m*` prop
 *   radius   xs…xl
 */

// Accent #10a37f at index 6 (tokens.ts).
const brandColors: MantineColorsTuple = [...brandTokens];
const darkColors: MantineColorsTuple = [...darkTokens];

const remScale = <K extends string>(px: Record<K, number>) =>
  Object.fromEntries(Object.entries(px).map(([k, v]) => [k, rem(v as number)])) as Record<K, string>;

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: primaryShade, dark: primaryShade },
  colors: { brand: brandColors, dark: darkColors },
  white,
  black,
  fontFamily,
  fontFamilyMonospace,
  headings: { fontWeight: headingFontWeight },
  // Mantine's xs…xl (12 / 14 / 16 / 18 / 20) plus the steps the dense parts of the UI need.
  fontSizes: remScale(extraFontSizes),
  // Mantine's xs…xl (10 / 12 / 16 / 20 / 32) plus three tight steps for what sits inside a component.
  spacing: remScale(extraSpacing),
  defaultRadius: 'md',
  radius,
  cursorType: 'pointer',
  // Keyboard focus only (:focus-visible): the ring is styled in base.css with --focus-ring.
  focusRing: 'auto',
  shadows,
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

/** Surfaces and text shades for both schemes (also used by base.css and the apps' stylesheets). */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: { ...schemeVariables.light },
  dark: { ...schemeVariables.dark },
});
