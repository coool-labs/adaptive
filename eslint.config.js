import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier"

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.scratch/**",
      "**/node_modules/**",
      "**/guiconfig.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettier,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
  {
    files: [
      "packages/opencode/src/{core,health,state,execution}/**/*.ts",
      "packages/opencode/src/ui/flow/**/*.ts",
      "packages/opencode/src/adapters/codex-capacity/**/*.ts",
      "packages/opencode/src/rpc/status.ts",
      "packages/opencode/src/supervisor/log.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@opencode/**",
                "@opentui/**",
                "solid-js",
                "solid-js/**",
                "**/rpc/handlers.js",
                "**/adapters/opencode/**",
              ],
              message: "Shared modules must not depend on a host SDK or adapter.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
)
