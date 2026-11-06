import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { addMessages, LocaleProvider, translate, useT } from '../src/lib/i18n';
import { withParam } from '../src/lib/urlState';
import { renderUi } from './render';

afterEach(cleanup);

describe('i18n', () => {
  it('interpolates, falls back to English and supports extra catalogs', () => {
    expect(translate('en', 'catalog.empty', { title: 'services' })).toBe('No services yet');
    expect(translate('de', 'runs.empty')).toBe('No runs');
    addMessages('fr', { 'runs.empty': 'Aucune exécution' });
    expect(translate('fr-CA', 'runs.empty')).toBe('Aucune exécution');
    expect(translate('fr', 'catalog.noMatch')).toBe('No match');
  });

  it('useT follows the provider locale', () => {
    addMessages('fr', { 'notifications.empty': 'Aucune notification' });
    function Probe() {
      return <span>{useT()('notifications.empty')}</span>;
    }
    renderUi(
      <LocaleProvider locale="fr">
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByText('Aucune notification')).toBeTruthy();
  });
});

describe('withParam', () => {
  it('sets, removes and resets paging', () => {
    const base = new URLSearchParams('page=3&q=a');
    expect(withParam(base, 'q', 'b').toString()).toBe('q=b');
    expect(withParam(base, 'q', null).toString()).toBe('');
    expect(withParam(base, 'page', '4').toString()).toBe('page=4&q=a');
  });
});
