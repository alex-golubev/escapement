// Flat config for ESLint 10.
//
// Three programs live in this package, and they do not share an environment:
// the app runs in a browser, the worklet runs on the audio thread with globals
// of its own, and the configs and tests run in Node. The blocks below follow
// that split.
//
// Type-aware rules are on. That is the only reason a linter earns its place
// next to `svelte-check` here — the rules at the bottom of this file are ones
// the compiler cannot express, and both of them guard a failure mode this
// project has already written down.
//
// `recommendedTypeChecked` and not `strictTypeChecked`, deliberately. The rule
// that decides it is `no-unnecessary-condition`, which lives in the stricter
// preset: it reads a guard against input the type system was never told about
// as dead code. It has exactly one target here today — the check on the host's
// output array in `renderQuantum` — and that check is right, for a reason no
// type in this codebase expresses: what crosses a thread boundary is input, not
// a promise. Taking the preset would mean deleting it, or annotating around it
// at every such boundary from here to M9. Revisit if the stricter preset ever
// earns its way in on other rules; this one would still have to be turned off.

import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import ts from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import prettier from 'eslint-config-prettier/flat'
import svelteConfig from './svelte.config.js'

// `defineConfig` comes from ESLint itself rather than `tseslint.config`, which
// is deprecated in favor of it — core absorbed the `extends` handling the
// helper existed to provide.
export default defineConfig(
  // Generated, never authored: `dist/` is Vite output and `public/worklet/` is
  // the esbuild bundle of src/worklet/processor.ts.
  globalIgnores(['dist/', 'public/worklet/']),

  js.configs.recommended,
  ts.configs.recommendedTypeChecked,
  svelte.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        // Resolves every file through the nearest tsconfig, following the
        // project references in tsconfig.json. Without a program the
        // type-aware rules have nothing to ask, and they fail loudly rather
        // than degrading quietly — which is what we want from them.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
      },
    },
    rules: {
      // `process(_inputs, outputs)` cannot drop its first parameter: the
      // signature is Web Audio's, not ours.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The codebase already writes `import type` throughout; this keeps it
      // that way. It matters more than style here — `verbatimModuleSyntax` is
      // on, so a value import of a type-only module survives into the emitted
      // worklet bundle.
      '@typescript-eslint/consistent-type-imports': 'error',
      // Both failure unions are switched over without a `default`, so that a
      // new case has to be described before it compiles. The explicit return
      // type on each `describe*` already catches that, and this catches the
      // switches that do not return a value — the same guard, one step earlier
      // and with a message that names the union.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  {
    files: ['src/**/*.svelte', 'src/**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: ts.parser, svelteConfig },
    },
  },

  {
    files: ['src/**'],
    languageOptions: { globals: globals.browser },
  },

  {
    // What ships is what sits under `src/`, minus the specs beside it — and
    // that is meant to be readable from the path rather than worked out. Half
    // of it already is: a support file that reaches for `node:` fails
    // `pnpm check`, because the specs pull it into the app project and that
    // project is told about no Node types at all. This is the other half, which
    // nothing checked. An import of `tests/` from a module that ships compiles,
    // lints, and bundles the fake into the page.
    files: ['src/**'],
    ignores: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tests/**'],
              message:
                'tests/ holds fakes and helpers. Only a spec may import them; nothing that ships may.',
            },
          ],
        },
      ],
    },
  },

  {
    // The audio thread. The rules here are the two from CLAUDE.md that a
    // linter can actually check. Specs sit in this directory too but do not
    // run there, and both rules are justified by where the code executes.
    files: ['src/worklet/**'],
    ignores: ['**/*.spec.ts'],
    rules: {
      // No logging on the audio thread. A `console.log` left in `process`
      // runs 375 times a second and allocates every time; the symptom is a
      // dropout, not a slow frame.
      'no-console': 'error',
      // The worklet is bundled standalone into an IIFE with no module loader
      // behind it. A dynamic import resolves to nothing at runtime and the
      // processor fails to construct, with `processorerror` carrying no
      // reason — the exact failure the ready/failed messages exist to avoid.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message:
            'The worklet bundle has no module loader — a dynamic import cannot resolve there.',
        },
      ],
    },
  },

  {
    files: ['tests/**', 'plugins/**', '*.config.ts', '*.config.js'],
    languageOptions: { globals: globals.node },
  },

  // Last, so it wins: turns off every rule that would argue with Prettier.
  prettier,
)
