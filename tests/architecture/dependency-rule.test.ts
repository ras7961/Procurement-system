import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFile, collectImports, findRepositoryClassViolations, listSourceFiles, toRelative } from "./analyzeImports";

describe("Clean Architecture dependency rule (real source tree)", () => {
  const files = listSourceFiles();

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no import that points outward or breaks a layer boundary", () => {
    const violations = files.flatMap((file) => checkFile(toRelative(file), fs.readFileSync(file, "utf8")));
    expect(violations).toEqual([]);
  });

  const repositoryFiles = files.filter((file) => toRelative(file).startsWith("repositories/"));
  it.skipIf(repositoryFiles.length === 0)("every concrete repository class implements a repository interface", () => {
    const violations = repositoryFiles.flatMap((file) =>
      findRepositoryClassViolations(toRelative(file), fs.readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("checks the real repositories: both Mongo adapters declare their interface", () => {
    const sources = Object.fromEntries(
      repositoryFiles.map((file) => [toRelative(file), fs.readFileSync(file, "utf8")] as const),
    );
    expect(sources["repositories/MongoUserRepository.ts"]).toMatch(/class MongoUserRepository implements UserRepositoryInterface/);
    expect(sources["repositories/MongoRoleRepository.ts"]).toMatch(/class MongoRoleRepository implements RoleRepositoryInterface/);
  });
});

describe("Repository-implements-interface rule (self-test)", () => {
  it("accepts a class that implements a repository interface, including multi-line headers", () => {
    expect(
      findRepositoryClassViolations("repositories/A.ts", "export class A implements UserRepositoryInterface {}"),
    ).toEqual([]);
    expect(
      findRepositoryClassViolations("repositories/A.ts", "export class A\n  implements TenderRepositoryInterface\n{\n}"),
    ).toEqual([]);
  });

  it("rejects a class that implements nothing or the wrong thing", () => {
    expect(findRepositoryClassViolations("repositories/B.ts", "export class B {}")).toHaveLength(1);
    expect(findRepositoryClassViolations("repositories/B.ts", "export class B implements Disposable {}")).toHaveLength(1);
    expect(findRepositoryClassViolations("repositories/B.ts", "export class B extends Base {}")).toHaveLength(1);
  });

  it("checks every class in a file, not just the first", () => {
    const source = "export class A implements UserRepositoryInterface {}\nexport class Helper {}";
    expect(findRepositoryClassViolations("repositories/C.ts", source)).toEqual([
      "repositories/C.ts: class Helper must implement a *RepositoryInterface",
    ]);
  });

  it("ignores the word 'class' in comments and files without classes", () => {
    const source = "/** no driver error class leaks out */\n// a class here is fine\nexport function helper() {}";
    expect(findRepositoryClassViolations("repositories/mongoErrors.ts", source)).toEqual([]);
  });
});

describe("Architecture checker detects violations (self-test)", () => {
  it("accepts a compliant use case", () => {
    const source = `import type { Tender } from "@/entities/Tender";
      import type { TenderRepositoryInterface } from "@/interfaces/repositories/TenderRepositoryInterface";`;
    expect(checkFile("usecases/tender/CreateTender.ts", source)).toEqual([]);
  });

  it("rejects an entity importing MongoDB", () => {
    expect(checkFile("entities/Tender.ts", `import { ObjectId } from "mongodb";`)).not.toEqual([]);
  });

  it("rejects an entity importing a use case", () => {
    expect(checkFile("entities/Tender.ts", `import { X } from "@/usecases/tender/X";`)).not.toEqual([]);
  });

  it("rejects an entity importing Next.js or React", () => {
    expect(checkFile("entities/User.ts", `import { cookies } from "next/headers";`)).not.toEqual([]);
    expect(checkFile("entities/User.ts", `import React from "react";`)).not.toEqual([]);
  });

  it("rejects relative imports that climb into an outer layer", () => {
    const source = `import { MongoBidRepository } from "../../repositories/MongoBidRepository";`;
    expect(checkFile("usecases/bid/SubmitBid.ts", source)).not.toEqual([]);
  });

  it("rejects a use case importing the Ollama client or the MongoDB driver", () => {
    expect(checkFile("usecases/ai/Analyze.ts", `import ollama from "ollama";`)).not.toEqual([]);
    expect(checkFile("usecases/bid/Submit.ts", `import { Db } from "mongodb";`)).not.toEqual([]);
  });

  it("rejects a controller importing a concrete repository or the database layer", () => {
    expect(checkFile("controllers/BidController.ts", `import { X } from "@/repositories/MongoBidRepository";`)).not.toEqual([]);
    expect(checkFile("controllers/BidController.ts", `import { Y } from "@/infrastructure/database/MongoDBConnection";`)).not.toEqual([]);
  });

  it("rejects React components and pages reaching the database, use cases or repositories", () => {
    expect(checkFile("presentation/components/X.tsx", `import { MongoClient } from "mongodb";`)).not.toEqual([]);
    expect(checkFile("presentation/components/X.tsx", `import { U } from "@/usecases/tender/U";`)).not.toEqual([]);
    expect(checkFile("app/page.tsx", `import { R } from "@/repositories/MongoTenderRepository";`)).not.toEqual([]);
  });

  it("rejects a route handler that bypasses the controller", () => {
    expect(checkFile("app/api/x/route.ts", `import { U } from "@/usecases/health/CheckSystemHealthUseCase";`)).not.toEqual([]);
  });

  it("allows a route handler to use the composition root", () => {
    expect(checkFile("app/api/x/route.ts", `import { getContainer } from "@/infrastructure/container";`)).toEqual([]);
  });

  it("allows only the composition root to wire every layer together", () => {
    const wiring = `import { C } from "@/controllers/C"; import { U } from "@/usecases/health/U";`;
    expect(checkFile("infrastructure/container.ts", wiring)).toEqual([]);
    expect(checkFile("infrastructure/database/MongoDBConnection.ts", wiring)).not.toEqual([]);
  });

  it("rejects the MongoDB driver outside infrastructure/database and repositories", () => {
    expect(checkFile("services/X.ts", `import { MongoClient } from "mongodb";`)).not.toEqual([]);
    expect(checkFile("infrastructure/logging/X.ts", `import { MongoClient } from "mongodb";`)).not.toEqual([]);
    expect(checkFile("infrastructure/database/X.ts", `import { MongoClient } from "mongodb";`)).toEqual([]);
    expect(checkFile("repositories/MongoX.ts", `import { Db } from "mongodb";`)).toEqual([]);
  });

  it("confines the Argon2 package to the services layer", () => {
    const hashing = `import argon2 from "argon2";`;
    expect(checkFile("services/Argon2PasswordService.ts", hashing)).toEqual([]);
    expect(checkFile("entities/User.ts", hashing)).not.toEqual([]);
    expect(checkFile("usecases/authentication/Register.ts", hashing)).not.toEqual([]);
    expect(checkFile("interfaces/services/PasswordServiceInterface.ts", hashing)).not.toEqual([]);
    expect(checkFile("repositories/MongoUserRepository.ts", hashing)).not.toEqual([]);
    expect(checkFile("infrastructure/database/X.ts", hashing)).not.toEqual([]);
    // The dynamic form used by the adapter is recognised as well.
    expect(checkFile("usecases/authentication/Register.ts", `const lib = await import("argon2");`)).not.toEqual([]);
  });

  it("confines the JWT library to the services layer", () => {
    const jwt = `import { SignJWT } from "jose";`;
    expect(checkFile("services/JwtTokenService.ts", jwt)).toEqual([]);
    expect(checkFile("entities/User.ts", jwt)).not.toEqual([]);
    expect(checkFile("usecases/authentication/LoginUseCase.ts", jwt)).not.toEqual([]);
    expect(checkFile("interfaces/services/TokenServiceInterface.ts", jwt)).not.toEqual([]);
    expect(checkFile("repositories/MongoRevokedTokenRepository.ts", jwt)).not.toEqual([]);
    expect(checkFile("controllers/AuthenticationController.ts", jwt)).not.toEqual([]);
  });

  it("rejects an overgrown route handler", () => {
    const longRoute = Array.from({ length: 60 }, () => "// filler").join("\n");
    expect(checkFile("app/api/x/route.ts", longRoute)).not.toEqual([]);
  });

  it("rejects files outside the known layers", () => {
    expect(checkFile("misc/helper.ts", "export const x = 1;")).not.toEqual([]);
  });

  it("extracts static, multi-line, side-effect, dynamic and require imports but ignores comments", () => {
    const source = `
      // import { Ignored } from "mongodb";
      /* import { AlsoIgnored } from "ollama"; */
      import {
        A,
        B,
      } from "@/entities/A";
      export { C } from "./C";
      import "./side-effect";
      const lazy = await import("zod");
      const legacy = require("node:fs");`;
    expect(collectImports(source).sort()).toEqual(
      ["./C", "./side-effect", "@/entities/A", "node:fs", "zod"].sort(),
    );
  });
});
