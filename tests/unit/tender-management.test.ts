import { beforeEach, describe, expect, it } from "vitest";
import {
  AccountInactiveException,
  AuthenticationRequiredException,
  DatabaseOperationException,
  DeadlineExpiredException,
  InvalidTenderDataException,
  InvalidTenderStatusException,
  TenderDeadlineNotReachedException,
  TenderNotFoundException,
  UnauthorizedAccessException,
} from "@/entities/exceptions";
import type { RoleName } from "@/entities/Role";
import type { TenderStatus } from "@/entities/Tender";
import type { UserStatus } from "@/entities/User";
import { AuthorizeUseCase } from "@/usecases/authorization/AuthorizeUseCase";
import { SeedRolesUseCase } from "@/usecases/authorization/SeedRolesUseCase";
import type { CreateTenderInput } from "@/usecases/tender/dtos";
import { TENDER_OPERATION_PERMISSIONS, TenderManagementUseCase } from "@/usecases/tender/TenderManagementUseCase";
import { catchAsyncError, makeUser, TENDER_DEADLINE, TENDER_NOW } from "../support/fixtures";
import { InMemoryRoleRepository } from "../support/InMemoryRoleRepository";
import { InMemoryTenderRepository } from "../support/InMemoryTenderRepository";
import { InMemoryUserRepository } from "../support/InMemoryUserRepository";

const day = (n: number) => new Date(TENDER_NOW.getTime() + n * 24 * 60 * 60 * 1000);
const AFTER_DEADLINE = new Date(TENDER_DEADLINE.getTime() + 1000);

/** Lets a test change the stored tender after the use case has read it and before it writes (two users acting at once). */
class RacyTenderRepository extends InMemoryTenderRepository {
  beforeNextWrite: (() => Promise<void>) | null = null;
  failWith: Error | null = null;
  writes = 0;

  private async gate(): Promise<void> {
    this.writes += 1;
    const hook = this.beforeNextWrite;
    this.beforeNextWrite = null;
    await hook?.();
  }
  override async findById(tenderId: string) {
    if (this.failWith) throw this.failWith;
    return super.findById(tenderId);
  }
  override async create(...args: Parameters<InMemoryTenderRepository["create"]>) {
    await this.gate();
    return super.create(...args);
  }
  override async update(...args: Parameters<InMemoryTenderRepository["update"]>) {
    await this.gate();
    return super.update(...args);
  }
  override async updateStatus(...args: Parameters<InMemoryTenderRepository["updateStatus"]>) {
    await this.gate();
    return super.updateStatus(...args);
  }
  override async delete(...args: Parameters<InMemoryTenderRepository["delete"]>) {
    await this.gate();
    return super.delete(...args);
  }
}

async function buildWorld() {
  const roles = new InMemoryRoleRepository();
  const users = new InMemoryUserRepository();
  const tenders = new RacyTenderRepository();
  await new SeedRolesUseCase(roles).execute(); // the real seeder: roles carry the approved matrix
  const clock = { now: TENDER_NOW };
  let counter = 0;
  const useCase = new TenderManagementUseCase(
    new AuthorizeUseCase(users, roles),
    tenders,
    users,
    roles,
    () => clock.now,
    () => `tender-${(counter += 1)}`,
  );

  async function addUser(roleName: RoleName, status: UserStatus = "Active") {
    const role = (await roles.findByName(roleName))!;
    const user = await users.create(makeUser({ role, status: status === "Pending" ? "Pending" : "Active" }));
    if (status === "Inactive" || status === "Suspended") await users.updateStatus(user.userId, status);
    return user.userId;
  }

  const broker = await addUser("Procurement Broker");
  const admin = await addUser("Administrator");
  const supplier = await addUser("Supplier");
  const committee = await addUser("Evaluation Committee");

  const createInput = (actingUserId: string, overrides: Partial<CreateTenderInput> = {}): CreateTenderInput => ({
    actingUserId,
    title: "Supply of office furniture",
    description: "Desks, chairs and cabinets.",
    category: "Goods",
    estimatedBudget: 250000,
    requirements: ["Valid trade licence"],
    evaluationCriteria: ["Technical compliance", "Price"],
    submissionDeadline: TENDER_DEADLINE,
    ...overrides,
  });

  /** A tender in the given status, driven through the use case itself as the broker. */
  async function tenderIn(status: TenderStatus, overrides: Partial<CreateTenderInput> = {}) {
    const created = await useCase.createTender(createInput(broker, overrides));
    const id = created.tenderId;
    if (status === "Draft") return created;
    if (status === "Cancelled") return useCase.cancelTender({ actingUserId: broker, tenderId: id });
    await useCase.publishTender({ actingUserId: broker, tenderId: id });
    if (status === "Published") return (await useCase.getTender({ actingUserId: broker, tenderId: id }));
    clock.now = AFTER_DEADLINE;
    const closed = await useCase.closeTender({ actingUserId: broker, tenderId: id });
    clock.now = TENDER_NOW;
    return closed;
  }

  return { roles, users, tenders, clock, useCase, addUser, createInput, tenderIn, broker, admin, supplier, committee };
}

type World = Awaited<ReturnType<typeof buildWorld>>;
let w: World;
beforeEach(async () => {
  w = await buildWorld();
});

const act = (actingUserId: string, tenderId: string) => ({ actingUserId, tenderId });

describe("createTender", () => {
  it("a Broker creates a Draft tender that they are responsible for", async () => {
    const tender = await w.useCase.createTender(w.createInput(w.broker));

    expect(tender).toMatchObject({
      tenderId: "tender-1",
      title: "Supply of office furniture",
      status: "Draft",
      brokerId: w.broker,
      publicationDate: null,
      createdAt: TENDER_NOW.toISOString(),
      openForSubmissions: false,
    });
    expect((await w.tenders.findById("tender-1"))?.toJSON()).toMatchObject({ status: "Draft", brokerId: w.broker });
  });

  it("a Broker may name themselves, but not another broker", async () => {
    await expect(w.useCase.createTender(w.createInput(w.broker, { brokerId: w.broker }))).resolves.toMatchObject({ brokerId: w.broker });

    const otherBroker = await w.addUser("Procurement Broker");
    const error = await catchAsyncError(() => w.useCase.createTender(w.createInput(w.broker, { brokerId: otherBroker })));
    expect(error).toBeInstanceOf(InvalidTenderDataException);
    expect(await w.tenders.findAll()).toHaveLength(1);
  });

  it("an Administrator creates a tender for an active Broker", async () => {
    const tender = await w.useCase.createTender(w.createInput(w.admin, { brokerId: w.broker }));
    expect(tender.brokerId).toBe(w.broker);
  });

  it("an Administrator must name the responsible broker, and it must be an active Procurement Broker", async () => {
    const suspendedBroker = await w.addUser("Procurement Broker", "Suspended");
    const pendingBroker = await w.addUser("Procurement Broker", "Pending");
    for (const brokerId of [undefined, "", "nobody", w.supplier, w.admin, suspendedBroker, pendingBroker, 42 as never]) {
      const error = await catchAsyncError(() => w.useCase.createTender(w.createInput(w.admin, { brokerId })));
      expect(error).toBeInstanceOf(InvalidTenderDataException);
    }
    expect(await w.tenders.findAll()).toEqual([]);
  });

  it("rejects invalid tender data with every problem listed, and stores nothing", async () => {
    const error = await catchAsyncError(() =>
      w.useCase.createTender(w.createInput(w.broker, { title: " ", estimatedBudget: -1 })),
    );
    expect(error).toBeInstanceOf(InvalidTenderDataException);
    expect((error as InvalidTenderDataException).issues).toHaveLength(2);
    const late = await catchAsyncError(() => w.useCase.createTender(w.createInput(w.broker, { submissionDeadline: day(-1) })));
    expect(late).toBeInstanceOf(InvalidTenderDataException);
    expect(await w.tenders.findAll()).toEqual([]);
  });

  it("a Supplier and an Evaluation Committee member cannot create tenders", async () => {
    for (const user of [w.supplier, w.committee]) {
      const error = await catchAsyncError(() => w.useCase.createTender(w.createInput(user)));
      expect(error).toBeInstanceOf(UnauthorizedAccessException);
    }
    expect(await w.tenders.findAll()).toEqual([]);
  });

  it("the role is read from storage: demoting a Broker takes effect at once", async () => {
    await w.useCase.createTender(w.createInput(w.broker));
    const supplierRole = (await w.roles.findByName("Supplier"))!;
    await w.users.update(w.broker, { roleId: supplierRole.roleId });

    const error = await catchAsyncError(() => w.useCase.createTender(w.createInput(w.broker)));
    expect(error).toBeInstanceOf(UnauthorizedAccessException);
  });
});

describe("authorization of every operation", () => {
  const operations: Array<[string, (w: World, user: string, id: string) => Promise<unknown>]> = [
    ["createTender", (w, user) => w.useCase.createTender(w.createInput(user, { brokerId: w.broker }))],
    ["updateTender", (w, user, id) => w.useCase.updateTender({ actingUserId: user, tenderId: id, changes: { title: "New" } })],
    ["publishTender", (w, user, id) => w.useCase.publishTender(act(user, id))],
    ["closeTender", (w, user, id) => w.useCase.closeTender(act(user, id))],
    ["cancelTender", (w, user, id) => w.useCase.cancelTender(act(user, id))],
    ["deleteDraftTender", (w, user, id) => w.useCase.deleteDraftTender(act(user, id))],
    ["getTender", (w, user, id) => w.useCase.getTender(act(user, id))],
    ["listTenders", (w, user) => w.useCase.listTenders({ actingUserId: user })],
  ];

  it.each(operations)("%s refuses an unknown user, and a missing or non-text user id (401)", async (_name, run) => {
    const draft = await w.tenderIn("Draft");
    for (const user of ["nobody", "", undefined as never, 7 as never, { $ne: null } as never]) {
      expect(await catchAsyncError(() => run(w, user, draft.tenderId))).toBeInstanceOf(AuthenticationRequiredException);
    }
  });

  it.each(operations)("%s refuses Pending, Inactive and Suspended accounts, even Administrators (403)", async (_name, run) => {
    const draft = await w.tenderIn("Draft");
    for (const status of ["Pending", "Inactive", "Suspended"] as const) {
      const user = await w.addUser("Administrator", status);
      expect(await catchAsyncError(() => run(w, user, draft.tenderId))).toBeInstanceOf(AccountInactiveException);
    }
  });

  it.each(operations.slice(0, 6))("%s is refused for Suppliers and Committee members, before the tender is even looked up", async (_name, run) => {
    for (const user of [w.supplier, w.committee]) {
      // An id that does not exist: a caller without permission must still get "not allowed", never "not found".
      expect(await catchAsyncError(() => run(w, user, "no-such-tender"))).toBeInstanceOf(UnauthorizedAccessException);
    }
  });

  it("works for an Administrator as well as a Broker", async () => {
    const draft = await w.tenderIn("Draft");
    await expect(w.useCase.updateTender({ actingUserId: w.admin, tenderId: draft.tenderId, changes: { title: "By admin" } })).resolves.toMatchObject({
      title: "By admin",
    });
    await expect(w.useCase.publishTender(act(w.admin, draft.tenderId))).resolves.toMatchObject({ status: "Published" });
  });

  it("fails closed when the user or permission data cannot be read: the request errors and nothing changes", async () => {
    const draft = await w.tenderIn("Draft");
    const original = w.users.findById.bind(w.users);
    w.users.findById = async () => {
      throw new DatabaseOperationException();
    };
    for (const [, run] of operations) {
      expect(await catchAsyncError(() => run(w, w.broker, draft.tenderId))).toBeInstanceOf(DatabaseOperationException);
    }
    w.users.findById = original;
    expect((await w.tenders.findById(draft.tenderId))?.status).toBe("Draft");
    expect(await w.tenders.findAll()).toHaveLength(1);
  });

  describe("each operation needs the permission it is mapped to (stored role, not the matrix)", () => {
    async function withoutPermission(permission: string) {
      const role = (await w.roles.findByName("Procurement Broker"))!;
      role.removePermission(permission);
      await w.roles.update(role.roleId, { permissions: role.getPermissions() });
    }
    const allowed = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return true;
      } catch (error) {
        return !(error instanceof UnauthorizedAccessException);
      }
    };

    it("the mapping uses only existing permissions", () => {
      expect(TENDER_OPERATION_PERMISSIONS).toEqual({
        create: "tender:create",
        update: "tender:update",
        publish: "tender:publish",
        close: "tender:publish",
        cancel: "tender:publish",
        delete: "tender:update",
        get: "tender:read",
        list: "tender:read",
      });
    });

    it("without tender:publish a broker can still edit, delete and read but cannot publish, close or cancel", async () => {
      const [a, b, c, d] = [await w.tenderIn("Draft"), await w.tenderIn("Draft"), await w.tenderIn("Published"), await w.tenderIn("Draft")];
      await withoutPermission("tender:publish");
      const id = w.broker;

      expect(await allowed(() => w.useCase.publishTender(act(id, a.tenderId)))).toBe(false);
      expect(await allowed(() => w.useCase.closeTender(act(id, c.tenderId)))).toBe(false);
      expect(await allowed(() => w.useCase.cancelTender(act(id, b.tenderId)))).toBe(false);
      expect(await allowed(() => w.useCase.updateTender({ actingUserId: id, tenderId: a.tenderId, changes: { title: "Ok" } }))).toBe(true);
      expect(await allowed(() => w.useCase.deleteDraftTender(act(id, d.tenderId)))).toBe(true);
      expect(await allowed(() => w.useCase.getTender(act(id, a.tenderId)))).toBe(true);
    });

    it("without tender:update a broker cannot edit or delete but can still publish and cancel", async () => {
      const [a, b, c] = [await w.tenderIn("Draft"), await w.tenderIn("Draft"), await w.tenderIn("Draft")];
      await withoutPermission("tender:update");
      const id = w.broker;

      expect(await allowed(() => w.useCase.updateTender({ actingUserId: id, tenderId: a.tenderId, changes: { title: "No" } }))).toBe(false);
      expect(await allowed(() => w.useCase.deleteDraftTender(act(id, a.tenderId)))).toBe(false);
      expect(await allowed(() => w.useCase.publishTender(act(id, b.tenderId)))).toBe(true);
      expect(await allowed(() => w.useCase.cancelTender(act(id, c.tenderId)))).toBe(true);
    });

    it("without tender:read a broker cannot get or list", async () => {
      const draft = await w.tenderIn("Draft");
      await withoutPermission("tender:read");
      expect(await allowed(() => w.useCase.getTender(act(w.broker, draft.tenderId)))).toBe(false);
      expect(await allowed(() => w.useCase.listTenders({ actingUserId: w.broker }))).toBe(false);
    });
  });
});

describe("broker ownership (update, publish, close, cancel, delete)", () => {
  type Op = (user: string, id: string) => Promise<unknown>;
  const ops: Array<[string, TenderStatus, Op]> = [
    ["updateTender", "Draft", (user, id) => w.useCase.updateTender({ actingUserId: user, tenderId: id, changes: { title: "Hijacked" } })],
    ["publishTender", "Draft", (user, id) => w.useCase.publishTender(act(user, id))],
    ["closeTender", "Published", (user, id) => w.useCase.closeTender(act(user, id))],
    ["cancelTender", "Draft", (user, id) => w.useCase.cancelTender(act(user, id))],
    ["deleteDraftTender", "Draft", (user, id) => w.useCase.deleteDraftTender(act(user, id))],
  ];

  it.each(ops)("%s: another broker is refused and the tender is untouched", async (_name, status, run) => {
    const tender = await w.tenderIn(status);
    const otherBroker = await w.addUser("Procurement Broker");
    w.clock.now = AFTER_DEADLINE; // so that close would otherwise be allowed
    const before = (await w.tenders.findById(tender.tenderId))!.toJSON();
    const writesBefore = w.tenders.writes;

    expect(await catchAsyncError(() => run(otherBroker, tender.tenderId))).toBeInstanceOf(UnauthorizedAccessException);
    expect((await w.tenders.findById(tender.tenderId))!.toJSON()).toEqual(before);
    expect(w.tenders.writes).toBe(writesBefore);
  });

  it.each(ops)("%s: the owning broker is allowed", async (_name, status, run) => {
    const tender = await w.tenderIn(status);
    w.clock.now = AFTER_DEADLINE;
    // publish needs a future deadline, so the owner publishes before the deadline passes
    if (_name === "publishTender") w.clock.now = TENDER_NOW;
    await expect(run(w.broker, tender.tenderId)).resolves.not.toThrow();
  });

  it.each(ops)("%s: an Administrator may act on a tender owned by a broker", async (_name, status, run) => {
    const tender = await w.tenderIn(status);
    w.clock.now = _name === "publishTender" ? TENDER_NOW : AFTER_DEADLINE;
    await expect(run(w.admin, tender.tenderId)).resolves.not.toThrow();
  });

  it("ownership is decided by the stored brokerId and stored role, not by anything the caller supplies", async () => {
    const tender = await w.tenderIn("Draft");
    const otherBroker = await w.addUser("Procurement Broker");
    // a forged brokerId inside the changes is an unknown field and is refused; the ownership failure comes first
    const error = await catchAsyncError(() =>
      w.useCase.updateTender({ actingUserId: otherBroker, tenderId: tender.tenderId, changes: { brokerId: otherBroker } as never }),
    );
    expect(error).toBeInstanceOf(UnauthorizedAccessException);
    expect((await w.tenders.findById(tender.tenderId))?.brokerId).toBe(w.broker);
  });

  it("a broker demoted to a non-manager role loses access to their own tender", async () => {
    const tender = await w.tenderIn("Draft");
    const supplierRole = (await w.roles.findByName("Supplier"))!;
    await w.users.update(w.broker, { roleId: supplierRole.roleId });
    expect(await catchAsyncError(() => w.useCase.cancelTender(act(w.broker, tender.tenderId)))).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("a custom role holding the permissions is still not an owner or Administrator (fail closed)", async () => {
    const tender = await w.tenderIn("Draft");
    const committeeRole = (await w.roles.findByName("Evaluation Committee"))!;
    committeeRole.assignPermission("tender:update");
    await w.roles.update(committeeRole.roleId, { permissions: committeeRole.getPermissions() });
    const error = await catchAsyncError(() =>
      w.useCase.updateTender({ actingUserId: w.committee, tenderId: tender.tenderId, changes: { title: "x" } }),
    );
    expect(error).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("a broker without the permission is refused before ownership or existence is revealed", async () => {
    const otherBroker = await w.addUser("Procurement Broker");
    const role = (await w.roles.findByName("Procurement Broker"))!;
    role.removePermission("tender:publish");
    await w.roles.update(role.roleId, { permissions: role.getPermissions() });
    expect(await catchAsyncError(() => w.useCase.publishTender(act(otherBroker, "no-such-tender")))).toBeInstanceOf(UnauthorizedAccessException);
  });
});

describe("read access scope (get and list)", () => {
  it("a broker cannot read another broker's tender, in any status: it looks like 'not found'", async () => {
    const otherBroker = await w.addUser("Procurement Broker");
    for (const status of ["Draft", "Published", "Closed", "Cancelled"] as const) {
      const tender = await w.tenderIn(status);
      expect(await catchAsyncError(() => w.useCase.getTender(act(otherBroker, tender.tenderId)))).toBeInstanceOf(TenderNotFoundException);
      await expect(w.useCase.getTender(act(w.broker, tender.tenderId))).resolves.toMatchObject({ tenderId: tender.tenderId, status });
    }
  });

  it("an out-of-scope tender and a missing tender give the same error (no existence leak)", async () => {
    const tender = await w.tenderIn("Draft");
    const otherBroker = await w.addUser("Procurement Broker");
    const hidden = await catchAsyncError(() => w.useCase.getTender(act(otherBroker, tender.tenderId)));
    const missing = await catchAsyncError(() => w.useCase.getTender(act(otherBroker, "no-such-tender")));
    expect(hidden.constructor).toBe(missing.constructor);
    expect(hidden.message).toBe(missing.message);
  });

  it("an Administrator reads every broker's tenders in every status", async () => {
    const otherBroker = await w.addUser("Procurement Broker");
    const mine = await w.tenderIn("Draft");
    const theirs = await w.useCase.createTender(w.createInput(otherBroker));
    for (const t of [mine, theirs]) {
      await expect(w.useCase.getTender(act(w.admin, t.tenderId))).resolves.toMatchObject({ tenderId: t.tenderId });
    }
    const ids = (await w.useCase.listTenders({ actingUserId: w.admin })).tenders.map((t) => t.tenderId);
    expect(ids.sort()).toEqual([mine.tenderId, theirs.tenderId].sort());
  });

  it("a broker's list contains only their own tenders, with or without filters", async () => {
    const otherBroker = await w.addUser("Procurement Broker");
    w.clock.now = day(0);
    const mineDraft = await w.tenderIn("Draft");
    w.clock.now = day(1);
    const minePublished = await w.tenderIn("Published");
    w.clock.now = day(2);
    const theirs = await w.useCase.createTender(w.createInput(otherBroker, { category: "Goods" }));
    const ids = async (user: string, input: object = {}) => (await w.useCase.listTenders({ actingUserId: user, ...input })).tenders.map((t) => t.tenderId);

    expect(await ids(w.broker)).toEqual([minePublished.tenderId, mineDraft.tenderId]);
    expect(await ids(otherBroker)).toEqual([theirs.tenderId]);
    expect(await ids(w.broker, { category: "Goods" })).toEqual([minePublished.tenderId, mineDraft.tenderId]);
    expect(await ids(w.broker, { status: "Draft" })).toEqual([mineDraft.tenderId]);
    expect(await ids(w.broker, { brokerId: w.broker })).toEqual([minePublished.tenderId, mineDraft.tenderId]);
    expect(await ids(w.broker, { limit: 1, skip: 1 })).toEqual([mineDraft.tenderId]);
  });

  it("a broker asking for another broker's tenders gets an empty page, not an error and not those tenders", async () => {
    const otherBroker = await w.addUser("Procurement Broker");
    await w.useCase.createTender(w.createInput(otherBroker));
    const result = await w.useCase.listTenders({ actingUserId: w.broker, brokerId: otherBroker });
    expect(result.tenders).toEqual([]);
    expect(result).toMatchObject({ limit: 100, skip: 0 });
  });

  it("a malformed list filter is still rejected for a broker", async () => {
    const error = await catchAsyncError(() => w.useCase.listTenders({ actingUserId: w.broker, brokerId: { $ne: "x" } } as never));
    expect(error).toBeInstanceOf(InvalidTenderDataException);
  });

  it("a Supplier sees other brokers' Published tenders but nothing else, in get and in list", async () => {
    const otherBroker = await w.addUser("Procurement Broker");
    const a = await w.tenderIn("Published");
    const b = await w.useCase.createTender(w.createInput(otherBroker));
    await w.useCase.publishTender(act(otherBroker, b.tenderId));
    const draft = await w.tenderIn("Draft");

    for (const t of [a, b]) await expect(w.useCase.getTender(act(w.supplier, t.tenderId))).resolves.toMatchObject({ status: "Published" });
    expect(await catchAsyncError(() => w.useCase.getTender(act(w.supplier, draft.tenderId)))).toBeInstanceOf(TenderNotFoundException);
    const ids = (await w.useCase.listTenders({ actingUserId: w.supplier })).tenders.map((t) => t.tenderId);
    expect(ids.sort()).toEqual([a.tenderId, b.tenderId].sort());
  });

  it("Evaluation Committee stays denied for get and list", async () => {
    const tender = await w.tenderIn("Published");
    expect(await catchAsyncError(() => w.useCase.getTender(act(w.committee, tender.tenderId)))).toBeInstanceOf(UnauthorizedAccessException);
    expect(await catchAsyncError(() => w.useCase.listTenders({ actingUserId: w.committee }))).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("scope follows the stored role: a demoted broker loses their own drafts, a promoted one gains all", async () => {
    const tender = await w.tenderIn("Draft");
    const adminRole = (await w.roles.findByName("Administrator"))!;
    const supplierRole = (await w.roles.findByName("Supplier"))!;
    const otherBroker = await w.addUser("Procurement Broker");

    await w.users.update(w.broker, { roleId: supplierRole.roleId });
    expect(await catchAsyncError(() => w.useCase.getTender(act(w.broker, tender.tenderId)))).toBeInstanceOf(TenderNotFoundException);

    await w.users.update(otherBroker, { roleId: adminRole.roleId });
    await expect(w.useCase.getTender(act(otherBroker, tender.tenderId))).resolves.toMatchObject({ tenderId: tender.tenderId });
  });

  it("a custom role holding tender:read is refused unless it is Administrator, Broker or Supplier (fail closed)", async () => {
    const tender = await w.tenderIn("Published");
    const role = (await w.roles.findByName("Evaluation Committee"))!;
    role.assignPermission("tender:read");
    await w.roles.update(role.roleId, { permissions: role.getPermissions() });
    expect(await catchAsyncError(() => w.useCase.getTender(act(w.committee, tender.tenderId)))).toBeInstanceOf(UnauthorizedAccessException);
    expect(await catchAsyncError(() => w.useCase.listTenders({ actingUserId: w.committee }))).toBeInstanceOf(UnauthorizedAccessException);
  });
});

describe("updateTender", () => {
  it("changes only the given fields of a Draft and returns the stored tender", async () => {
    const draft = await w.tenderIn("Draft");
    const updated = await w.useCase.updateTender({
      actingUserId: w.broker,
      tenderId: draft.tenderId,
      changes: { title: "  New title ", estimatedBudget: 99, requirements: ["One", "Two"], submissionDeadline: day(60) },
    });

    expect(updated).toMatchObject({ title: "New title", estimatedBudget: 99, requirements: ["One", "Two"], status: "Draft", brokerId: w.broker });
    expect(updated.submissionDeadline).toBe(day(60).toISOString());
    expect(updated.category).toBe("Goods");
    expect((await w.tenders.findById(draft.tenderId))?.toJSON()).toMatchObject({ title: "New title", estimatedBudget: 99 });
  });

  it("allows an edit of a Published tender before its deadline", async () => {
    const published = await w.tenderIn("Published");
    w.clock.now = day(5);
    const updated = await w.useCase.updateTender({ actingUserId: w.broker, tenderId: published.tenderId, changes: { estimatedBudget: 300000 } });
    expect(updated).toMatchObject({ estimatedBudget: 300000, status: "Published", publicationDate: TENDER_NOW.toISOString() });
  });

  it("refuses an edit of a Published tender after its deadline", async () => {
    const published = await w.tenderIn("Published");
    w.clock.now = AFTER_DEADLINE;
    const error = await catchAsyncError(() => w.useCase.updateTender({ actingUserId: w.broker, tenderId: published.tenderId, changes: { title: "Late" } }));
    expect(error).toBeInstanceOf(DeadlineExpiredException);
    expect((await w.tenders.findById(published.tenderId))?.title).toBe("Supply of office furniture");
  });

  it.each(["Closed", "Cancelled"] as const)("refuses an edit of a %s tender with InvalidTenderStatusException", async (status) => {
    const tender = await w.tenderIn(status);
    const error = await catchAsyncError(() => w.useCase.updateTender({ actingUserId: w.broker, tenderId: tender.tenderId, changes: { title: "x" } }));
    expect(error).toBeInstanceOf(InvalidTenderStatusException);
  });

  it("rejects invalid values, unknown fields and an empty change, and writes nothing", async () => {
    const draft = await w.tenderIn("Draft");
    const before = (await w.tenders.findById(draft.tenderId))!.toJSON();
    for (const changes of [{ estimatedBudget: 0 }, { title: "" }, { requirements: ["a", "A"] }, { status: "Published" }, { brokerId: "x" }, {}]) {
      const error = await catchAsyncError(() => w.useCase.updateTender({ actingUserId: w.broker, tenderId: draft.tenderId, changes: changes as never }));
      expect(error).toBeInstanceOf(InvalidTenderDataException);
    }
    expect(w.tenders.writes).toBe(1); // only the creation
    expect((await w.tenders.findById(draft.tenderId))!.toJSON()).toEqual(before);
  });

  it("a published tender cannot be emptied of requirements or criteria", async () => {
    const published = await w.tenderIn("Published");
    const error = await catchAsyncError(() => w.useCase.updateTender({ actingUserId: w.broker, tenderId: published.tenderId, changes: { requirements: [] } }));
    expect(error).toBeInstanceOf(InvalidTenderDataException);
  });

  it("reports an unknown or malformed tender id as not found", async () => {
    for (const tenderId of ["missing", "", undefined as never, { $ne: "x" } as never]) {
      const error = await catchAsyncError(() => w.useCase.updateTender({ actingUserId: w.broker, tenderId, changes: { title: "x" } }));
      expect(error).toBeInstanceOf(TenderNotFoundException);
    }
  });

  it("a tender cancelled by someone else between the read and the write is not overwritten", async () => {
    const draft = await w.tenderIn("Draft");
    w.tenders.beforeNextWrite = async () => {
      await w.tenders.updateStatus(draft.tenderId, "Cancelled");
    };
    const error = await catchAsyncError(() => w.useCase.updateTender({ actingUserId: w.broker, tenderId: draft.tenderId, changes: { title: "Too late" } }));
    expect(error).toBeInstanceOf(InvalidTenderStatusException);
    expect((await w.tenders.findById(draft.tenderId))).toMatchObject({ status: "Cancelled", title: "Supply of office furniture" });
  });
});

describe("publishTender", () => {
  it("publishes a complete Draft and records the publication date from the clock", async () => {
    const draft = await w.tenderIn("Draft");
    w.clock.now = day(2);
    const published = await w.useCase.publishTender(act(w.broker, draft.tenderId));

    expect(published).toMatchObject({ status: "Published", publicationDate: day(2).toISOString(), openForSubmissions: true });
    expect((await w.tenders.findById(draft.tenderId))?.status).toBe("Published");
  });

  it("refuses an incomplete Draft and leaves it a Draft", async () => {
    const draft = await w.tenderIn("Draft", { requirements: [], evaluationCriteria: [] });
    const error = await catchAsyncError(() => w.useCase.publishTender(act(w.broker, draft.tenderId)));
    expect(error).toBeInstanceOf(InvalidTenderDataException);
    expect((error as InvalidTenderDataException).issues).toHaveLength(2);
    expect((await w.tenders.findById(draft.tenderId))?.status).toBe("Draft");
  });

  it("refuses to publish after the deadline", async () => {
    const draft = await w.tenderIn("Draft");
    w.clock.now = AFTER_DEADLINE;
    expect(await catchAsyncError(() => w.useCase.publishTender(act(w.broker, draft.tenderId)))).toBeInstanceOf(DeadlineExpiredException);
  });

  it.each(["Published", "Closed", "Cancelled"] as const)("refuses a %s tender", async (status) => {
    const tender = await w.tenderIn(status);
    expect(await catchAsyncError(() => w.useCase.publishTender(act(w.broker, tender.tenderId)))).toBeInstanceOf(InvalidTenderStatusException);
  });

  it("two users publishing and cancelling at once: the loser gets a status conflict and the winner's result stays", async () => {
    const draft = await w.tenderIn("Draft");
    w.tenders.beforeNextWrite = async () => {
      await w.tenders.updateStatus(draft.tenderId, "Cancelled");
    };
    const error = await catchAsyncError(() => w.useCase.publishTender(act(w.broker, draft.tenderId)));
    expect(error).toBeInstanceOf(InvalidTenderStatusException);
    expect((await w.tenders.findById(draft.tenderId))).toMatchObject({ status: "Cancelled", publicationDate: null });
  });

  it("reports an unknown tender", async () => {
    expect(await catchAsyncError(() => w.useCase.publishTender(act(w.broker, "missing")))).toBeInstanceOf(TenderNotFoundException);
  });
});

describe("closeTender", () => {
  it("closes a Published tender once the deadline is reached", async () => {
    const published = await w.tenderIn("Published");
    w.clock.now = TENDER_DEADLINE;
    const closed = await w.useCase.closeTender(act(w.broker, published.tenderId));
    expect(closed).toMatchObject({ status: "Closed", openForSubmissions: false });
    expect((await w.tenders.findById(published.tenderId))?.status).toBe("Closed");
  });

  it("refuses to close before the deadline: early closure is not offered, because nothing says who may authorize it", async () => {
    const published = await w.tenderIn("Published");
    w.clock.now = day(1);
    const error = await catchAsyncError(() => w.useCase.closeTender({ ...act(w.broker, published.tenderId), early: true } as never));
    expect(error).toBeInstanceOf(TenderDeadlineNotReachedException);
    expect((await w.tenders.findById(published.tenderId))?.status).toBe("Published");
  });

  it.each(["Draft", "Closed", "Cancelled"] as const)("refuses a %s tender", async (status) => {
    const tender = await w.tenderIn(status);
    w.clock.now = AFTER_DEADLINE;
    expect(await catchAsyncError(() => w.useCase.closeTender(act(w.broker, tender.tenderId)))).toBeInstanceOf(InvalidTenderStatusException);
  });

  it("a tender cancelled in between is not closed", async () => {
    const published = await w.tenderIn("Published");
    w.clock.now = AFTER_DEADLINE;
    w.tenders.beforeNextWrite = async () => {
      await w.tenders.updateStatus(published.tenderId, "Cancelled");
    };
    expect(await catchAsyncError(() => w.useCase.closeTender(act(w.broker, published.tenderId)))).toBeInstanceOf(InvalidTenderStatusException);
    expect((await w.tenders.findById(published.tenderId))?.status).toBe("Cancelled");
  });
});

describe("cancelTender", () => {
  it.each(["Draft", "Published"] as const)("cancels a %s tender", async (status) => {
    const tender = await w.tenderIn(status);
    const cancelled = await w.useCase.cancelTender(act(w.broker, tender.tenderId));
    expect(cancelled.status).toBe("Cancelled");
    expect(cancelled.publicationDate).toBe(tender.publicationDate);
    expect((await w.tenders.findById(tender.tenderId))?.status).toBe("Cancelled");
  });

  it.each(["Closed", "Cancelled"] as const)("refuses a %s tender", async (status) => {
    const tender = await w.tenderIn(status);
    expect(await catchAsyncError(() => w.useCase.cancelTender(act(w.broker, tender.tenderId)))).toBeInstanceOf(InvalidTenderStatusException);
    expect((await w.tenders.findById(tender.tenderId))?.status).toBe(status);
  });

  it("a tender published in between is cancelled only if the use case saw it Published", async () => {
    const draft = await w.tenderIn("Draft");
    w.tenders.beforeNextWrite = async () => {
      await w.tenders.updateStatus(draft.tenderId, "Published", { publicationDate: TENDER_NOW });
    };
    expect(await catchAsyncError(() => w.useCase.cancelTender(act(w.broker, draft.tenderId)))).toBeInstanceOf(InvalidTenderStatusException);
    expect((await w.tenders.findById(draft.tenderId))?.status).toBe("Published");
  });
});

describe("deleteDraftTender", () => {
  it("deletes a Draft", async () => {
    const draft = await w.tenderIn("Draft");
    await expect(w.useCase.deleteDraftTender(act(w.broker, draft.tenderId))).resolves.toBeUndefined();
    expect(await w.tenders.findById(draft.tenderId)).toBeNull();
  });

  it.each(["Published", "Closed", "Cancelled"] as const)("keeps a %s tender", async (status) => {
    const tender = await w.tenderIn(status);
    expect(await catchAsyncError(() => w.useCase.deleteDraftTender(act(w.broker, tender.tenderId)))).toBeInstanceOf(InvalidTenderStatusException);
    expect(await w.tenders.findById(tender.tenderId)).not.toBeNull();
  });

  it("reports an unknown tender", async () => {
    expect(await catchAsyncError(() => w.useCase.deleteDraftTender(act(w.broker, "missing")))).toBeInstanceOf(TenderNotFoundException);
  });

  it("a Draft published in between is not deleted", async () => {
    const draft = await w.tenderIn("Draft");
    w.tenders.beforeNextWrite = async () => {
      await w.tenders.updateStatus(draft.tenderId, "Published", { publicationDate: TENDER_NOW });
    };
    // The in-memory double re-checks the stored status like the real repository does.
    expect(await catchAsyncError(() => w.useCase.deleteDraftTender(act(w.broker, draft.tenderId)))).toBeInstanceOf(InvalidTenderStatusException);
    expect(await w.tenders.findById(draft.tenderId)).not.toBeNull();
  });
});

describe("getTender", () => {
  it("Brokers and Administrators can read a tender in any status, including Drafts", async () => {
    const draft = await w.tenderIn("Draft");
    for (const user of [w.broker, w.admin]) {
      await expect(w.useCase.getTender(act(user, draft.tenderId))).resolves.toMatchObject({ tenderId: draft.tenderId, status: "Draft" });
    }
  });

  it("reports whether the tender is open for submissions at the current time", async () => {
    const published = await w.tenderIn("Published");
    expect((await w.useCase.getTender(act(w.broker, published.tenderId))).openForSubmissions).toBe(true);
    w.clock.now = AFTER_DEADLINE;
    expect((await w.useCase.getTender(act(w.broker, published.tenderId))).openForSubmissions).toBe(false);
  });

  it("a Supplier sees Published tenders only; every other status looks like 'not found'", async () => {
    const published = await w.tenderIn("Published");
    await expect(w.useCase.getTender(act(w.supplier, published.tenderId))).resolves.toMatchObject({ status: "Published" });

    for (const status of ["Draft", "Closed", "Cancelled"] as const) {
      const tender = await w.tenderIn(status);
      expect(await catchAsyncError(() => w.useCase.getTender(act(w.supplier, tender.tenderId)))).toBeInstanceOf(TenderNotFoundException);
    }
  });

  it("an Evaluation Committee member is refused until tender assignment exists", async () => {
    const published = await w.tenderIn("Published");
    expect(await catchAsyncError(() => w.useCase.getTender(act(w.committee, published.tenderId)))).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("reports an unknown or malformed id as not found", async () => {
    for (const tenderId of ["missing", "", undefined as never, { $ne: "x" } as never]) {
      expect(await catchAsyncError(() => w.useCase.getTender(act(w.broker, tenderId)))).toBeInstanceOf(TenderNotFoundException);
    }
  });
});

describe("listTenders", () => {
  it("lists every status for Brokers and Administrators, newest first, with paging details", async () => {
    w.clock.now = day(0);
    const draft = await w.tenderIn("Draft");
    w.clock.now = day(1);
    const published = await w.tenderIn("Published");
    w.clock.now = day(2);
    const cancelled = await w.tenderIn("Cancelled");

    for (const user of [w.broker, w.admin]) {
      const result = await w.useCase.listTenders({ actingUserId: user });
      expect(result.tenders.map((t) => t.tenderId)).toEqual([cancelled.tenderId, published.tenderId, draft.tenderId]);
      expect(result).toMatchObject({ limit: 100, skip: 0 });
    }
  });

  it("filters by status, broker and category, and pages", async () => {
    const otherBroker = await w.addUser("Procurement Broker");
    w.clock.now = day(0);
    const a = await w.tenderIn("Draft", { category: "Goods" });
    w.clock.now = day(1);
    const b = await w.useCase.createTender(w.createInput(otherBroker, { category: "Works" }));
    w.clock.now = day(2);
    const c = await w.tenderIn("Published", { category: "Works" });
    const ids = async (input: object) => (await w.useCase.listTenders({ actingUserId: w.admin, ...input })).tenders.map((t) => t.tenderId);

    expect(await ids({ status: "Draft" })).toEqual([b.tenderId, a.tenderId]);
    expect(await ids({ status: ["Draft", "Published"], category: "Works" })).toEqual([c.tenderId, b.tenderId]);
    expect(await ids({ brokerId: otherBroker })).toEqual([b.tenderId]);
    expect(await ids({ limit: 1, skip: 1 })).toEqual([b.tenderId]);
    expect(await ids({ brokerId: "nobody" })).toEqual([]);
  });

  it("a Supplier sees only Published tenders, however they filter", async () => {
    const draft = await w.tenderIn("Draft");
    const published = await w.tenderIn("Published");
    await w.tenderIn("Cancelled");
    const ids = async (input: object) => (await w.useCase.listTenders({ actingUserId: w.supplier, ...input })).tenders.map((t) => t.tenderId);

    expect(await ids({})).toEqual([published.tenderId]);
    expect(await ids({ status: ["Draft", "Published", "Cancelled"] })).toEqual([published.tenderId]);
    expect(await ids({ status: "Draft" })).toEqual([]);
    expect(await ids({ status: "Cancelled" })).toEqual([]);
    expect(await ids({})).not.toContain(draft.tenderId);
  });

  it("an Evaluation Committee member is refused until tender assignment exists", async () => {
    expect(await catchAsyncError(() => w.useCase.listTenders({ actingUserId: w.committee }))).toBeInstanceOf(UnauthorizedAccessException);
  });

  it("rejects bad filters with InvalidTenderDataException, also for Suppliers", async () => {
    for (const user of [w.broker, w.supplier]) {
      for (const bad of [{ status: "Archived" }, { limit: 0 }, { limit: 501 }, { skip: -1 }, { brokerId: "" }, { category: { $ne: "x" } }]) {
        const error = await catchAsyncError(() => w.useCase.listTenders({ actingUserId: user, ...bad } as never));
        expect(error).toBeInstanceOf(InvalidTenderDataException);
      }
    }
  });
});
