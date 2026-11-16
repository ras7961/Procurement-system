import { describe, expect, it } from "vitest";
import type { RoleRepositoryInterface } from "@/interfaces/repositories/RoleRepositoryInterface";
import type { TenderRepositoryInterface } from "@/interfaces/repositories/TenderRepositoryInterface";
import type { UserRepositoryInterface } from "@/interfaces/repositories/UserRepositoryInterface";
import { InMemoryRoleRepository } from "../support/InMemoryRoleRepository";
import { InMemoryTenderRepository } from "../support/InMemoryTenderRepository";
import { InMemoryUserRepository } from "../support/InMemoryUserRepository";
import { runRoleRepositoryContract } from "../support/roleRepositoryContract";
import { runTenderRepositoryContract } from "../support/tenderRepositoryContract";
import { runUserRepositoryContract } from "../support/userRepositoryContract";

// The same suites will run against MongoUserRepository / MongoRoleRepository in a later step.
runUserRepositoryContract("in-memory test double", () => new InMemoryUserRepository());
runRoleRepositoryContract("in-memory test double", () => new InMemoryRoleRepository());
runTenderRepositoryContract("in-memory test double", () => new InMemoryTenderRepository());

describe("repository interface shape", () => {
  it("UserRepositoryInterface has exactly the ODD operations", () => {
    const operations: Array<keyof UserRepositoryInterface> = [
      "create",
      "findById",
      "findByEmail",
      "update",
      "delete",
      "findAll",
      "updateStatus",
    ];
    const repository = new InMemoryUserRepository();
    for (const operation of operations) expect(typeof repository[operation]).toBe("function");

    // Compile-time check: adding or removing an operation on the interface breaks this line.
    const complete: Record<keyof UserRepositoryInterface, true> = {
      create: true,
      findById: true,
      findByEmail: true,
      update: true,
      delete: true,
      findAll: true,
      updateStatus: true,
    };
    expect(Object.keys(complete).sort()).toEqual([...operations].sort());
  });

  it("RoleRepositoryInterface has the proposed operations", () => {
    const complete: Record<keyof RoleRepositoryInterface, true> = {
      create: true,
      findById: true,
      findByName: true,
      findAll: true,
      update: true,
    };
    const repository = new InMemoryRoleRepository();
    for (const operation of Object.keys(complete) as Array<keyof RoleRepositoryInterface>) {
      expect(typeof repository[operation]).toBe("function");
    }
  });

  it("TenderRepositoryInterface has exactly the ODD operations", () => {
    const complete: Record<keyof TenderRepositoryInterface, true> = {
      create: true,
      findById: true,
      findAll: true,
      update: true,
      delete: true,
      updateStatus: true,
      findOpenTenders: true,
    };
    const repository = new InMemoryTenderRepository();
    for (const operation of Object.keys(complete) as Array<keyof TenderRepositoryInterface>) {
      expect(typeof repository[operation]).toBe("function");
    }
  });
});
