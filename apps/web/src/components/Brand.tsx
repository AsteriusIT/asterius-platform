import { useEffect } from 'react';
import { type MantineFontSize } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { BrandLogo as BrandLogoView, BrandMark as BrandMarkView } from '@asterius/brand';
import { api } from '../lib/api';

/**
 * Product name and logo: BRAND_NAME / BRAND_LOGO on the server (exposed by /api/meta), else the built-in ones.
 * Also keeps the browser tab title and favicon in sync. The look itself is @asterius/brand's.
 */

export const DEFAULT_NAME = 'Asterius Platform';
/** public/favicon.svg: a copy of @asterius/brand/mark.svg. */
export const DEFAULT_LOGO = '/favicon.svg';

export function useBrand() {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  return { name: meta.data?.name || DEFAULT_NAME, logo: meta.data?.logo || DEFAULT_LOGO };
}

export function BrandLogo({ size = 28 }: { size?: number }) {
  const { logo } = useBrand();
  return <BrandLogoView src={logo} size={size} />;
}

/** Logo + wordmark: the first word of the name is emphasised ("Asterius" Platform). */
export function BrandMark({ size = 28, fz = 'md' }: { size?: number; fz?: MantineFontSize }) {
  const { name, logo } = useBrand();
  return <BrandMarkView logo={logo} name={name} size={size} fz={fz} />;
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
