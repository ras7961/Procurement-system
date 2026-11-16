import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static analysis used by the architecture tests.
 * It reads every source file under src/, extracts its imports and checks them
 * against the Clean Architecture dependency rule documented in the SDD/ODD.
 */

export const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

export type Layer =
  | "entities"
  | "usecases"
  | "interfaces"
  | "controllers"
  | "repositories"
  | "services"
  | "presentation"
  | "infrastructure"
  | "shared"
  | "app";

interface LayerRule {
  /** Other layers this layer may import from (importing from itself is always fine). */
  layers: Layer[];
  /** Third-party packages allowed here: an explicit list, or "any". */
  packages: string[] | "any";
}

export const LAYER_RULES: Record<Layer, LayerRule> = {
  // Inner rings: pure TypeScript, no third-party packages at all.
  entities: { layers: ["shared"], packages: [] },
  shared: { layers: [], packages: [] },
  interfaces: { layers: ["entities", "shared"], packages: [] },
  usecases: { layers: ["entities", "shared", "interfaces"], packages: [] },
  // Adapters.
  controllers: { layers: ["entities", "shared", "usecases"], packages: ["zod"] },
  repositories: { layers: ["entities", "shared", "interfaces", "infrastructure"], packages: ["mongodb"] },
  services: { layers: ["entities", "shared", "interfaces", "infrastructure"], packages: "any" },
  // Frameworks and drivers.
  infrastructure: { layers: ["entities", "shared", "interfaces"], packages: "any" },
  presentation: { layers: ["entities", "shared"], packages: "any" },
  app: { layers: ["shared", "presentation"], packages: "any" },
};

/** Packages that may only appear in specific folders (paths relative to src/). */
export const PACKAGE_HOMES: Record<string, string[]> = {
  mongodb: ["infrastructure/database/", "repositories/"],
  ollama: ["infrastructure/ai/", "services/"],
  // Stage 1B: the Argon2 package may only be used by the password service adapter.
  argon2: ["services/"],
  // Stage 1D: the JWT library may only be used by the token service adapter.
  jose: ["services/"],
  next: ["app/", "presentation/"],
  react: ["app/", "presentation/"],
  "react-dom": ["app/", "presentation/"],
};

/** The composition root is the one file that may wire every layer together. */
export const COMPOSITION_ROOT = "infrastructure/container.ts";
const COMPOSITION_ROOT_LAYERS: Layer[] = [
  "entities",
  "shared",
  "interfaces",
  "usecases",
  "controllers",
  "repositories",
  "services",
  "infrastructure",
];

export const MAX_ROUTE_HANDLER_LINES = 40;

const BUILTINS = new Set(builtinModules);

export function listSourceFiles(directory: string = SRC_DIR): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(fullPath));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

export function toRelative(fullPath: string): string {
  return path.relative(SRC_DIR, fullPath).split(path.sep).join("/");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Rule: concrete repository classes implement a repository interface (ODD: "repositories
 * implement the repository interfaces"). Looks at real class declarations only, with
 * comments removed, and requires EVERY class in src/repositories to declare
 * `implements <Something>RepositoryInterface`.
 */
export function findRepositoryClassViolations(relativePath: string, source: string): string[] {
  const violations: string[] = [];
  for (const match of stripComments(source).matchAll(/\bclass\s+(\w+)([^{]*)\{/g)) {
    const [, name, heritage = ""] = match;
    if (!/\bimplements\b[^{]*\b\w+RepositoryInterface\b/.test(heritage)) {
      violations.push(`${relativePath}: class ${name} must implement a *RepositoryInterface`);
    }
  }
  return violations;
}

export function collectImports(source: string): string[] {
  const code = stripComments(source);
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/g, // import x from / export {x} from
    /\bimport\s*["']([^"']+)["']/g, // import "side-effect"
    /\bimport\(\s*["']([^"']+)["']\s*\)/g, // dynamic import
    /\brequire\(\s*["']([^"']+)["']\s*\)/g, // CommonJS
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function packageName(specifier: string): string {
  const parts = specifier.replace(/^node:/, "").split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTINS.has(packageName(specifier));
}

/** Returns a list of human-readable violations for one file (empty when compliant). */
export function checkFile(relativePath: string, source: string): string[] {
  const violations: string[] = [];
  const fromLayer = relativePath.split("/")[0] as Layer;
  const rule = LAYER_RULES[fromLayer];

  if (!rule) {
    return [`${relativePath}: is not inside a known layer folder`];
  }

  const isCompositionRoot = relativePath === COMPOSITION_ROOT;
  const allowedLayers = isCompositionRoot ? COMPOSITION_ROOT_LAYERS : rule.layers;

  for (const specifier of collectImports(source)) {
    const isInternal = specifier.startsWith("@/") || specifier.startsWith(".");

    if (isInternal) {
      const target = specifier.startsWith("@/")
        ? specifier.slice(2)
        : path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));

      if (target.startsWith("..")) {
        violations.push(`${relativePath}: imports "${specifier}" which is outside src/`);
        continue;
      }

      const targetLayer = target.split("/")[0] as Layer;
      if (!LAYER_RULES[targetLayer]) {
        violations.push(`${relativePath}: imports "${specifier}" which is not in a known layer`);
        continue;
      }

      const isRouteToContainer = fromLayer === "app" && /^infrastructure\/container(\.ts)?$/.test(target);
      if (targetLayer !== fromLayer && !allowedLayers.includes(targetLayer) && !isRouteToContainer) {
        violations.push(
          `${relativePath}: layer "${fromLayer}" must not import from layer "${targetLayer}" (${specifier})`,
        );
      }
      continue;
    }

    // Third-party package or Node built-in.
    const name = packageName(specifier);
    const builtin = isNodeBuiltin(specifier);
    const key = builtin ? "node built-in" : name;

    if (rule.packages !== "any" && !rule.packages.includes(name)) {
      violations.push(`${relativePath}: layer "${fromLayer}" must not import ${key} ("${specifier}")`);
      continue;
    }

    const homes = PACKAGE_HOMES[name];
    if (homes && !homes.some((home) => relativePath.startsWith(home))) {
      violations.push(`${relativePath}: package "${name}" may only be imported from ${homes.join(", ")}`);
    }
  }

  if (/^app\/.*\/route\.ts$/.test(relativePath)) {
    const lines = source.split("\n").length;
    if (lines > MAX_ROUTE_HANDLER_LINES) {
      violations.push(`${relativePath}: route handler has ${lines} lines (max ${MAX_ROUTE_HANDLER_LINES}); keep it thin`);
    }
  }

  return violations;
}
