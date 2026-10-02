// ★ ESLint for the React app — flat config (ESLint 9+).
//
// WHY THIS EXISTS, AND WHY IT IS NOT A STYLE TOOL.
// `tsc` verifies TYPES. It has no opinion on whether a hook was called conditionally,
// whether an effect is missing a dependency, or whether a promise was left floating —
// those are semantics, not types. This file exists for exactly one bug class that this
// codebase has already been bitten by:
//
//   `useStore()` (useContext) sat BELOW an early `return` in `CombinationPanel`, so the
//   number of hooks called changed between renders (8 -> 9) and React logged a warning.
//   `tsc` was clean. The build was clean. `react-hooks/rules-of-hooks` is the only
//   automated check that detects it, and without this config the console was the only
//   detector — which is to say, nobody's.
//
// SEVERITY POLICY (deliberate, and to be revisited):
//   - `react-hooks/rules-of-hooks` is an ERROR. It is a small rule set, it catches a real
//     defect that has already occurred here, and it should be clean on day one.
//   - Everything else is a WARN. A codebase this size with no lint history will produce a
//     large backlog, and a wall of red on the first run teaches people to ignore the tool.
//     Warnings report the backlog without blocking work; promote a rule to `error` once
//     its warning count reaches zero. Do not flip everything to `error` in one pass.
//
// NOT INCLUDED ON PURPOSE: Prettier. Formatting is a separate concern and running it now
// would produce a repo-wide diff that buries the findings this config is meant to surface.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // Never lint build output, generated extract dumps, or dependencies.
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'scripts/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // Browser globals the app genuinely uses. Declared explicitly rather than pulled
        // from a `globals` package so the surface is visible and auditable.
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        CustomEvent: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
      },
    },
    rules: {
      // ---- ERROR: the one rule that has already earned it ----
      'react-hooks/rules-of-hooks': 'error',

      // ---- WARN: the backlog, reported not enforced ----
      'react-hooks/exhaustive-deps': 'warn',

      // TypeScript already enforces unused locals/params via tsconfig (`noUnusedLocals`,
      // `noUnusedParameters`). Running both produces duplicate noise for the same finding.
      '@typescript-eslint/no-unused-vars': 'off',

      // `any` appears where a third-party payload is genuinely untyped. Reported so the
      // count is visible, not blocked.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Deliberate `console.warn`/`console.error` paths exist throughout (degraded-read
      // notices, the extract fallback). Only `console.log` is flagged as leftover debug.
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

      // The codebase leans on non-null assertions in a few narrow, evidenced places.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Empty catch blocks are used on purpose (e.g. a no-op `.catch(() => {})` attached to
      // an abandoned statement). Flagging them would be wrong here.
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // ★ DOWNGRADED FROM `error` (it arrives as an error via `js.configs.recommended`).
      //   Same reasoning as the server config: the flagged shape is a deliberate
      //   defensive default (`let x = null;` then an unconditional assignment in a
      //   try/catch that also assigns), not a defect. Reported, not blocked.
      'no-useless-assignment': 'warn',
    },
  },
);
