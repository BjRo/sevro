import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { testCallbackLines } from "./scripts/eslint-test-callbacks.mjs";

export default defineConfig(
  { ignores: ["node_modules/**", ".quality/**"] },
  {
    files: ["src/generated/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    // Byte-locked AJV output: parse syntax here, schemas:check verifies exact
    // generation, .d.cts types its boundary, Bun integration exercises it, and
    // Istanbul includes all executable counters. Authored rules do not apply.
  },
  {
    files: [
      "**/*.ts",
      "**/*.cts",
      "**/*.mts",
      "scripts/**/*.js",
      "scripts/**/*.mjs",
      "scripts/**/*.cjs",
      "eslint.config.mjs",
    ],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    plugins: { sevro: { rules: { "test-callback-lines": testCallbackLines } } },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        Bun: "readonly",
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        setInterval: "readonly",
        globalThis: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      "sevro/test-callback-lines": "error",
      complexity: ["error", { max: 5, variant: "modified" }],
      "max-depth": ["error", 3],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["scripts/coverage/capture.cjs"],
    languageOptions: { globals: { require: "readonly", module: "readonly" } },
    rules: {
      // Capture must load synchronously through normal CJS validators; Bun's
      // ESM/onLoad path changes their default-export interop (issue #1 evidence).
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
