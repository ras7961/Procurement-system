import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Clean Architecture import boundaries (editor-time feedback).
 * The authoritative, complete check is tests/architecture/dependency-rule.test.ts,
 * which also covers relative imports.
 */
const outer = (layers) =>
  layers.map((layer) => ({
    group: [`@/${layer}`, `@/${layer}/**`],
    message: `Dependency rule: this layer must not import from "${layer}".`,
  }));

const frameworkPackages = (names) =>
  names.map((name) => ({
    name,
    message: `Dependency rule: "${name}" must not be imported in this layer.`,
  }));

const restrict = (files, layers, packages) => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
      { paths: frameworkPackages(packages), patterns: outer(layers) },
    ],
  },
});

const FRAMEWORKS = ["mongodb", "ollama", "argon2", "jose", "next", "react", "react-dom"];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  restrict(
    ["src/entities/**/*.{ts,tsx}"],
    ["usecases", "interfaces", "controllers", "repositories", "services", "presentation", "infrastructure", "app"],
    [...FRAMEWORKS, "zod"],
  ),
  restrict(
    ["src/usecases/**/*.{ts,tsx}", "src/interfaces/**/*.{ts,tsx}"],
    ["controllers", "repositories", "services", "presentation", "infrastructure", "app"],
    [...FRAMEWORKS, "zod"],
  ),
  restrict(
    ["src/controllers/**/*.{ts,tsx}"],
    ["repositories", "services", "presentation", "infrastructure", "app"],
    FRAMEWORKS,
  ),
  restrict(
    ["src/presentation/**/*.{ts,tsx}"],
    ["usecases", "interfaces", "controllers", "repositories", "services", "infrastructure"],
    ["mongodb", "ollama"],
  ),
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts", "node_modules/**"]),
]);
