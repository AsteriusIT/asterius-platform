import { Group, Text, type MantineFontSize } from '@mantine/core';

/**
 * Logo and wordmark, presentational only: each app resolves the name and the logo (its own config, a server
 * endpoint…) and passes them in. Needs base.css (`.icon-img`).
 */

/** The family name, emphasised in front of the product word. */
export const BRAND_FAMILY = 'Asterius';

export interface BrandLogoProps {
  /** Image URL: the app's copy of `@asterius/brand/mark.svg`, or a custom logo (https://, /…, data:image/…). */
  src: string;
  size?: number;
}

export function BrandLogo({ src, size = 28 }: BrandLogoProps) {
  return <img src={src} width={size} height={size} alt="" className="icon-img" />;
}

export interface BrandMarkProps {
  /** Logo URL (see BrandLogo). */
  logo: string;
  /** Product word after the family name: "Platform", "Identity". */
  product?: string;
  /** Full name instead of `Asterius <product>` (a rebranded deployment): its first word is emphasised. */
  name?: string;
  size?: number;
  fz?: MantineFontSize;
}

/** Logo + wordmark: the first word of the name is emphasised ("Asterius" Platform). */
export function BrandMark({ logo, product, name, size = 28, fz = 'md' }: BrandMarkProps) {
  const [first, ...rest] = (name || [BRAND_FAMILY, product].filter(Boolean).join(' ')).split(' ');
  return (
    <Group gap="xs" wrap="nowrap" miw={0}>
      <BrandLogo src={logo} size={size} />
      <Text fz={fz} truncate lts="-0.02em" lh={1.1}>
        <Text span inherit fw={700}>
          {first}
        </Text>
        {rest.length > 0 && (
          <Text span inherit fw={450} c="dimmed">
            {' '}
            {rest.join(' ')}
          </Text>
        )}
      </Text>
    </Group>
  );
}
