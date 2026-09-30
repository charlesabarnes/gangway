import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "web/**",
      "site/**",
      "guide/**",
      "state/**",
      "docs/**",
      ".claude/**",
      "**/dist/**",
      "eslint.config.js",
    ],
  },
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
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 20],
      "max-depth": ["error", 4],
      // Async methods often implement an interface without awaiting anything themselves.
      "@typescript-eslint/require-await": "off",
      // Sanitizers match control characters on purpose.
      "no-control-regex": "off",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/no-unnecessary-type-parameters": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAsExpression.expression > TSUnknownKeyword",
          message:
            "Don't force a type through `as unknown as`; fix the type or validate the value.",
        },
      ],
      "no-console": "error",
      "no-param-reassign": "error",
      "no-nested-ternary": "error",
      "max-params": ["error", 4],
    },
  },
  {
    // Scripts are command-line tools: the console is their output.
    files: ["scripts/**", "render/build.ts"],
    rules: { "no-console": "off" },
  },
  {
    // The logger's own output, the startup banner, and the setup link the logger would redact.
    files: ["server/src/logger.ts", "server/src/main.ts", "server/src/boot.ts"],
    rules: { "no-console": "off" },
  },
  {
    // problem() tells artifact authors what is wrong with their markup, in the browser console.
    files: ["render/src/elements.ts"],
    rules: { "no-console": ["error", { allow: ["error"] }] },
  },
  {
    // Tests read untyped JSON responses and poke at internals on purpose.
    files: ["**/test/**"],
    rules: {
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": "off",
      complexity: "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(CallExpression[callee.name=/^(test|it|describe)$/], CallExpression[callee.object.name=/^(test|it|describe)$/], CallExpression[callee.callee.object.name=/^(test|it|describe)$/]) > Literal.arguments:first-child[value.length>80]",
          message: "Keep test titles to 80 characters.",
        },
      ],
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
      // A test asserts a value exists, then reads it; fixtures are built as loose objects.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
    },
  },
  prettier,
  // After prettier, which turns curly off: "all" does not conflict with its formatting.
  { rules: { curly: ["error", "all"] } },
);
