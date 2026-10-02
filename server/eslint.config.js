// ★ ESLint for the API — flat config (ESLint 9+).
//
// Same reasoning as `app/eslint.config.js`, minus the React half: the server has no
// components and no hooks, so `eslint-plugin-react-hooks` is deliberately NOT installed
// here. What is left is the TypeScript ruleset plus Node globals.
//
// SEVERITY POLICY (identical to the app's, and deliberate):
//   - Errors are the rules that catch a defect class this codebase has actually hit.
//   - Everything else is a warning, so the first run reports a backlog instead of failing.
//     Promote to `error` once a rule's warning count is zero. Do not flip in one pass.
//
// NOTE ON `no-floating-promises`: it is one of the highest-value rules for this server
// (routes are heavily async, and repo memory records a sync-throw-vs-async-rejection bug
// in a driver method). It requires TYPE-AWARE linting, which is slower and needs a
// `project` reference. It is left OFF for now so the first run stays fast and clean; turn
// it on deliberately with `parserOptions.project` when the backlog is triaged.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Never lint compiled output, the DDL copy that ships with the package, or deps.
    ignores: ['dist/**', 'node_modules/**', 'ddl/**', 'public/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Node globals, shared by the TypeScript source and the `.mjs` build scripts.
    // Declared once here rather than per-file-set so the two cannot drift.
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },

  {
    files: ['**/*.ts'],
    rules: {
      // ---- WARN: the backlog, reported not enforced ----

      // TypeScript already enforces unused locals/params via tsconfig.
      '@typescript-eslint/no-unused-vars': 'off',

      // `any` appears where a driver or third-party payload is genuinely untyped.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Deliberate console output exists (startup banner, degraded-read warnings).
      // Only `console.log` is flagged as leftover debug.
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

      // The codebase uses non-null assertions narrowly and with evidence.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Empty catch blocks are used on purpose (no-op `.catch(() => {})` on abandoned
      // statements is a documented pattern here). Flagging them would be wrong.
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // ★ DOWNGRADED FROM `error` (it arrives as an error via `js.configs.recommended`).
      //   The pattern it flags here is `let x = <default>;` followed by an unconditional
      //   assignment inside a try whose catch also assigns — a DELIBERATE defensive
      //   default, not a mistake. Examples: `readings`/`primary`/`fallbackReason`/
      //   `geometry`/`row`/`code`. Rewriting seven working sites to satisfy a style rule
      //   is churn with no correctness benefit, so the rule reports rather than blocks.
      'no-useless-assignment': 'warn',

      // `require()` appears in a few `.mjs` build scripts; those are ignored above.
      '@typescript-eslint/no-require-imports': 'warn',
    },
  },

  {
    // ★ BUILD SCRIPTS AND DEV TOOLS PRINT ON PURPOSE — `console.log` IS THEIR OUTPUT.
    //   `scripts/` holds the extract pullers, the DDL/web copiers and the one-off
    //   maintenance tools; `src/scripts/` holds `smoke.ts`, `ledger-scale.ts`,
    //   `store-scale.ts`, `geocode-vendor-sites.ts` and friends. None of them is
    //   application code, and a human reads their stdout. Applying the app's
    //   `no-console` policy here would flag ~56 lines whose entire job is to print.
    files: ['scripts/**/*.{ts,mjs}', 'src/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',

      // ★ TWO RULES ARE OFF FOR THE PULL SCRIPTS, AND BOTH ARE FALSE POSITIVES THERE.
      //   `no-control-regex`: `\u0001` is a REAL separator character that arrives in
      //   Oracle text and is replaced for display — the control character is the
      //   subject, not an accident. `no-unused-vars`: `({ _key, ...rest }) => rest`
      //   destructures a build-time merge key SPECIFICALLY to exclude it from the
      //   written row; the variable is unused by design, and the leading underscore
      //   is the conventional signal.
      'no-control-regex': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
);
