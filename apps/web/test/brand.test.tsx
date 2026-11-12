import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { BrandMark } from '@asterius/brand';
import mark from '@asterius/brand/mark.svg?raw';
import favicon from '../public/favicon.svg?raw';
import { renderUi } from './render';

afterEach(cleanup);

// brand.css is checked against the tokens by `npm run lint` (check:css -w packages/brand): vitest empties CSS imports.
describe('@asterius/brand', () => {
  it('the favicon is the brand mark', () => {
    expect(favicon).toBe(mark);
  });

  it('BrandMark emphasises the family name before the product word', () => {
    renderUi(<BrandMark logo="/mark.svg" product="Identity" />);
    expect(screen.getByText('Asterius').tagName).toBe('SPAN');
    expect(screen.getByText('Identity')).toBeTruthy();
  });

  it('BrandMark takes a full custom name instead', () => {
    renderUi(<BrandMark logo="/logo.png" name="Acme Developer Portal" />);
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('Developer Portal')).toBeTruthy();
  });
});
