import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["web/**", "state/**", "docs/**", ".claude/**", "**/dist/**", "eslint.config.js"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "no-duplicate-imports": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ["warn", 20],
      "max-depth": ["warn", 4],
      // Async methods often implement an interface without awaiting anything themselves.
      "@typescript-eslint/require-await": "off",
      // Sanitizers match control characters on purpose.
      "no-control-regex": "off",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Tests read untyped JSON responses and poke at internals on purpose.
    files: ["**/test/**"],
    rules: {
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": "off",
      complexity: "off",
      // bun types `expect(p).rejects.*` as void, but it must be awaited.
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      // Fake sockets take async event handlers.
      "@typescript-eslint/no-misused-promises": "off",
      // Generated CommonJS is compiled to prove it parses.
      "@typescript-eslint/no-implied-eval": "off",
    },
  },
  prettier,
);
