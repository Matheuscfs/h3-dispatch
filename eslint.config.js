import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // Non-null assertions are used where an invariant guarantees the value (e.g. a bucket always holds its driver).
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
