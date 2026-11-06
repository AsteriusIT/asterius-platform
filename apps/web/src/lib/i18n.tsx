import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Minimal i18n foundation: message catalogs keyed by id, `{name}` interpolation, English fallback.
 * Pages migrate string by string with `const t = useT(); t('runs.empty')`; a new language is one more catalog.
 */

export type Messages = Record<string, string>;

export const en = {
  'app.skipToContent': 'Skip to content',
  'error.title': 'Something went wrong',
  'error.hint': 'The page crashed unexpectedly. Reloading usually fixes it.',
  'error.reload': 'Reload',
  'error.retry': 'Try again',
  'runs.empty': 'No runs',
  'catalog.empty': 'No {title} yet',
  'catalog.noMatch': 'No match',
  'notifications.title': 'Notifications',
  'notifications.empty': 'No notification yet',
} satisfies Messages;

export type MessageKey = keyof typeof en;

const catalogs: Record<string, Messages> = { en };

export function translate(locale: string, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const lang = locale.split('-')[0];
  const text = catalogs[locale]?.[key] ?? catalogs[lang]?.[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Register (or extend) a language catalog, e.g. `addMessages('fr', { 'runs.empty': 'Aucune exécution' })`. */
export function addMessages(locale: string, messages: Messages) {
  catalogs[locale] = { ...catalogs[locale], ...messages };
}

const LocaleContext = createContext<string>(typeof navigator !== 'undefined' ? navigator.language : 'en');

export function LocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useT() {
  const locale = useContext(LocaleContext);
  return useMemo(() => (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars), [locale]);
}
