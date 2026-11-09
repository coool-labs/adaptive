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
      "test-artifacts/**",
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
    files: ["packages/core/**/*.ts", "packages/testkit/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@opencode/**",
                "@earendil-works/**",
                "@coool/opencode-adaptive",
                "@coool/opencode-adaptive/**",
                "@coool/pi-adaptive",
                "@coool/pi-adaptive/**",
                "**/opencode/**",
                "**/pi/**",
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
    files: ["packages/opencode/**/*.ts", "packages/opencode/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@earendil-works/**",
            "@coool/pi-adaptive",
            "@coool/pi-adaptive/**",
            "**/packages/pi/**",
          ],
        },
      ],
    },
  },
  {
    files: ["packages/pi/**/*.ts", "packages/pi/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@opencode/**",
            "@opentui/**",
            "solid-js",
            "solid-js/**",
            "@coool/opencode-adaptive",
            "@coool/opencode-adaptive/**",
            "**/packages/opencode/**",
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
