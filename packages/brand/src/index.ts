/**
 * @asterius/brand: the look shared by Asterius Platform and Asterius Identity.
 *
 *   theme, cssVariablesResolver   Mantine theme (MantineProvider theme / cssVariablesResolver)
 *   BrandMark, BrandLogo          logo + wordmark, presentational (the app passes name and logo)
 *   ICON, ICON_DISPLAY            icon size scale
 *   tokens                        the raw values, also written to brand.css
 *
 * Stylesheets and assets (package.json "exports"): `@asterius/brand/base.css` (after @mantine/core/styles.css),
 * `@asterius/brand/brand.css` (plain custom properties, generated: `npm run build:css -w packages/brand`),
 * `@asterius/brand/mark.svg`.
 */
export { theme, cssVariablesResolver } from './theme';
export { BrandMark, BrandLogo, BRAND_FAMILY, type BrandMarkProps, type BrandLogoProps } from './BrandMark';
export { ICON, ICON_DISPLAY } from './iconScale';
export * as tokens from './tokens';
