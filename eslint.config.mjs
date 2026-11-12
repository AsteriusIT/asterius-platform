import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'backups/**', 'clients/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/server/**/*.ts', 'loadtest/*.mts', '*.mjs', 'apps/web/scripts/**/*.mjs', 'packages/brand/scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  // k6 scripts run in the k6 runtime (not Node): its globals and ES modules.
  {
    files: ['loadtest/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', open: 'readonly', console: 'readonly' } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  // Design tokens (docs/EXTENDING.md, "UI conventions"): the UI names a step of a scale, never a pixel value.
  {
    files: ['apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='fz'] > JSXExpressionContainer > Literal",
          message: 'Font sizes come from the type scale: fz="xs" | "sm" | … (packages/brand/src/theme.ts), or a text component of components/ui.tsx.',
        },
        {
          selector:
            'JSXAttribute[name.name=/^(gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|spacing|verticalSpacing)$/] > JSXExpressionContainer > Literal[value>0]',
          message: 'Spacing comes from the scale: "4xs" … "xl" (packages/brand/src/theme.ts). A geometric value is a named constant with a comment.',
        },
        {
          selector: "JSXOpeningElement[name.name=/^Icon[A-Z]/] > JSXAttribute[name.name='stroke']",
          message: 'The stroke width of icons is set once in @asterius/brand/base.css (.tabler-icon); pass a size from ICON (@asterius/brand) only.',
        },
        {
          selector:
            "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression:not(:has(SpreadElement)):not(:has(Property[value.type!='Literal']))",
          message:
            'Inline styles are for values computed from data or state. Use a Mantine style prop (flex, miw, bdrs, bg…), a shared component or a utility class of styles.css.',
        },
      ],
    },
  },
);
