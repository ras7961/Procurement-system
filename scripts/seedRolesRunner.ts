import type { SeedRolesResult } from "@/usecases/authorization/dtos";

export interface SeedRolesRunnerDependencies {
  /** Makes sure the unique role-name index exists before anything is written. */
  prepareStorage: () => Promise<void>;
  seedRoles: { execute: () => Promise<SeedRolesResult> };
  closeStorage: () => Promise<void>;
  print: (line: string) => void;
  printError: (line: string) => void;
}

/**
 * Runs the role seeder and reports what happened. Returns the process exit code:
 *   0  all four roles exist (created, unchanged or customized-and-preserved)
 *   1  a conflict was reported, or the database could not be used (nothing is assumed)
 * It creates no users. Error output is a fixed message plus the error name, never connection
 * strings or driver messages.
 */
export async function runRoleSeeding(deps: SeedRolesRunnerDependencies): Promise<number> {
  let exitCode = 0;
  try {
    await deps.prepareStorage();
    const result = await deps.seedRoles.execute();
    for (const line of formatSeedReport(result)) deps.print(line);
    if (result.conflicts.length > 0) exitCode = 1;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    deps.printError(`Role seeding failed (${name}). No further roles were processed. Check the database settings and try again.`);
    exitCode = 1;
  }

  try {
    await deps.closeStorage();
  } catch {
    // Closing is best effort; the result above already decides the exit code.
  }
  return exitCode;
}

export function formatSeedReport(result: SeedRolesResult): string[] {
  const lines = [
    `Created:   ${list(result.created)}`,
    `Unchanged: ${list(result.unchanged)}`,
  ];
  for (const role of result.customized) {
    lines.push(
      `Customized (kept as stored): ${role.roleName}` +
        ` | missing from approved matrix: ${list(role.missingPermissions)}` +
        ` | extra beyond approved matrix: ${list(role.extraPermissions)}`,
    );
  }
  for (const conflict of result.conflicts) {
    lines.push(`CONFLICT: ${conflict.roleName}: ${conflict.reason}`);
  }
  return lines;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}
