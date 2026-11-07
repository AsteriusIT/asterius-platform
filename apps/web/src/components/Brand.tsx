import { useEffect } from 'react';
import { Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Product name and logo: BRAND_NAME / BRAND_LOGO on the server (exposed by /api/meta), else the built-in ones.
 * Also keeps the browser tab title and favicon in sync.
 */

export const DEFAULT_NAME = 'Asterius Platform';
export const DEFAULT_LOGO = '/favicon.svg';

export function useBrand() {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  return { name: meta.data?.name || DEFAULT_NAME, logo: meta.data?.logo || DEFAULT_LOGO };
}

export function BrandLogo({ size = 28 }: { size?: number }) {
  const { logo } = useBrand();
  return <img src={logo} width={size} height={size} alt="" style={{ objectFit: 'contain', flexShrink: 0, display: 'block' }} />;
}

/** Logo + wordmark: the first word of the name is emphasised ("Asterius" Platform). */
export function BrandMark({ size = 28, fz = 16 }: { size?: number; fz?: number }) {
  const { name } = useBrand();
  const [first, ...rest] = name.split(' ');
  return (
    <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
      <BrandLogo size={size} />
      <Text fz={fz} truncate style={{ letterSpacing: '-0.02em', lineHeight: 1.1 }}>
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

/** Browser tab title and favicon follow the brand. */
export function useDocumentBrand() {
  const { name, logo } = useBrand();
  useEffect(() => {
    document.title = name;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link && link.getAttribute('href') !== logo) {
      link.href = logo;
      link.removeAttribute('type'); // a custom logo may be PNG
    }
  }, [name, logo]);
}
