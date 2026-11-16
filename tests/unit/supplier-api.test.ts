import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as getOneRoute, PATCH as patchRoute } from "@/app/api/suppliers/[id]/route";
import { POST as verifyRoute } from "@/app/api/suppliers/[id]/verification/route";
import { GET as meRoute } from "@/app/api/suppliers/me/route";
import { GET as listRoute, POST as registerRoute } from "@/app/api/suppliers/route";
import { User, type UserStatus } from "@/entities/User";
import { generateId } from "@/shared/utilities/uuid";
import { APP_ORIGIN, createInMemorySupplierApiWorld } from "../support/inMemorySupplierApiWorld";

type World = Awaited<ReturnType<typeof createInMemorySupplierApiWorld>>;
type RoleName = "Administrator" | "Procurement Broker" | "Supplier" | "Evaluation Committee";

const PASSWORD = "correct horse battery";
const BASE_URL = `${APP_ORIGIN}/api/suppliers`;
const PROFILE = {
  companyName: "Abyssinia Office Supplies PLC",
  registrationNumber: "ET-AA-0001",
  email: "contact@abyssinia.example",
  phoneNumber: "+251 11 123 4567",
  address: "Bole Road, Addis Ababa",
};

let world: World;
let counter = 0;

beforeAll(async () => {
  world = await createInMemorySupplierApiWorld();
});
afterAll(() => world.dispose());

// ─── utilities ───────────────────────────────────────────────────────────────

interface Sent {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

function mkReq(method: string, url: string, opts: { body?: unknown; cookie?: string; origin?: string | null } = {}): Request {
  const headers = new Headers();
  const origin = opts.origin === undefined ? APP_ORIGIN : opts.origin;
  if (origin !== null) headers.set("Origin", origin);
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

async function call(response: Response): Promise<Sent> {
  return { status: response.status, body: JSON.parse(await response.text()), headers: response.headers };
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const errorOf = (sent: Sent) => sent.body.error as { code: string; message: string };
const supplierOf = (sent: Sent) => (sent.body.data as { supplier: Record<string, unknown> }).supplier;

/** Creates a user with the role, and (when Active) logs in through the real login route to get a session cookie. */
async function loginAs(roleName: RoleName, status: UserStatus = "Active"): Promise<{ cookie: string; userId: string }> {
  const email = `${roleName.replace(/\s+/g, "").toLowerCase()}${(counter += 1)}@example.com`;
  const role = (await world.roles.findByName(roleName))!;
  const user = await world.users.create(
    User.restore({
      userId: generateId(),
      fullName: "Test User",
      email,
      passwordHash: await world.passwords.hash(PASSWORD),
      roleId: role.roleId,
      status,
      createdAt: new Date(),
    }),
  );
  if (status !== "Active") {
    await world.users.updateStatus(user.userId, status);
    return { cookie: "", userId: user.userId }; // an inactive account cannot log in
  }
  const response = await (await import("@/app/api/auth/login/route")).POST(mkReq("POST", `${APP_ORIGIN}/api/auth/login`, { body: { email, password: PASSWORD } }));
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "", userId: user.userId };
}

/** A unique registration number per call, so tests never clash. */
const profile = (overrides: Record<string, unknown> = {}) => ({ ...PROFILE, registrationNumber: `REG-${(counter += 1)}`, ...overrides });

async function registerOwn(cookie: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile(overrides), cookie })));
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  return supplierOf(sent).supplierId as string;
}

// ─── POST /api/suppliers ─────────────────────────────────────────────────────

describe("POST /api/suppliers — register a profile", () => {
  it("a Supplier registers their own profile: 201, owned by the session user, Pending", async () => {
    const { cookie, userId } = await loginAs("Supplier");
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: PROFILE, cookie })));
    expect(sent.status).toBe(201);
    expect(sent.body.success).toBe(true);
    const supplier = supplierOf(sent);
    expect(supplier).toMatchObject({ ...PROFILE, userId, verificationStatus: "Pending" });
    expect(supplier.supplierId).toEqual(expect.any(String));
    expect(JSON.stringify(sent.body)).not.toMatch(/password|passwordHash|registrationNumberKey/i);
  });

  it("the response is stored and can be read back", async () => {
    const { cookie } = await loginAs("Supplier");
    const id = await registerOwn(cookie);
    expect(await world.suppliers.findById(id)).not.toBeNull();
  });

  it("a Supplier cannot send userId, not even their own (400) and nothing is stored", async () => {
    const { cookie, userId } = await loginAs("Supplier");
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile({ userId }), cookie })));
    expect(sent.status).toBe(400);
    expect(errorOf(sent).message).toMatch(/fields that are not allowed/i);
    expect(await world.suppliers.findByUserId(userId)).toBeNull();
  });

  it("a second profile for the same account is 409", async () => {
    const { cookie } = await loginAs("Supplier");
    await registerOwn(cookie);
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile(), cookie })));
    expect(sent.status).toBe(409);
    expect(errorOf(sent).code).toBe("DUPLICATE_SUPPLIER_REGISTRATION");
  });

  it("a registration number already used by another supplier is 409, whatever its case", async () => {
    const first = await loginAs("Supplier");
    const second = await loginAs("Supplier");
    await registerOwn(first.cookie, { registrationNumber: "UNIQUE-77" });
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile({ registrationNumber: " unique-77 " }), cookie: second.cookie })));
    expect(sent.status).toBe(409);
  });

  it.each(["Administrator", "Procurement Broker"] as const)("%s registers a profile for an existing Supplier user (201)", async (role) => {
    const staff = await loginAs(role);
    const owner = await loginAs("Supplier");
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile({ userId: owner.userId }), cookie: staff.cookie })));
    expect(sent.status).toBe(201);
    expect(supplierOf(sent).userId).toBe(owner.userId);
    expect(supplierOf(sent).verificationStatus).toBe("Pending");
  });

  it("staff may register a profile for a Supplier account that is still Pending", async () => {
    const staff = await loginAs("Administrator");
    const pending = await loginAs("Supplier", "Pending");
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile({ userId: pending.userId }), cookie: staff.cookie })));
    expect(sent.status).toBe(201);
  });

  it("staff must name userId (400), and it must be a Supplier user", async () => {
    const staff = await loginAs("Administrator");
    const broker = await loginAs("Procurement Broker");
    const committee = await loginAs("Evaluation Committee");
    const cases = [undefined, generateId(), broker.userId, committee.userId, staff.userId];
    for (const userId of cases) {
      const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile(userId === undefined ? {} : { userId }), cookie: staff.cookie })));
      expect(sent.status, String(userId)).toBe(400);
      expect(errorOf(sent).code).toBe("INVALID_SUPPLIER_DATA");
    }
  });

  it("staff sending a blank or non-string userId gets 400", async () => {
    const staff = await loginAs("Administrator");
    for (const userId of ["", "   ", 5, null]) {
      const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile({ userId }), cookie: staff.cookie })));
      expect(sent.status).toBe(400);
    }
  });

  it("a profile for a user that already has one is 409 (staff path)", async () => {
    const staff = await loginAs("Administrator");
    const owner = await loginAs("Supplier");
    await registerOwn(owner.cookie);
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile({ userId: owner.userId }), cookie: staff.cookie })));
    expect(sent.status).toBe(409);
  });

  it("Evaluation Committee cannot register a profile (403), even for a Supplier user", async () => {
    const committee = await loginAs("Evaluation Committee");
    const owner = await loginAs("Supplier");
    for (const body of [profile(), profile({ userId: owner.userId })]) {
      const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body, cookie: committee.cookie })));
      expect(sent.status).toBe(403);
    }
  });

  it("unauthenticated request is 401, and a Pending account (which cannot log in) has no session", async () => {
    expect((await call(await registerRoute(mkReq("POST", BASE_URL, { body: PROFILE })))).status).toBe(401);
    const pending = await loginAs("Supplier", "Pending");
    expect(pending.cookie).toBe("");
    expect((await call(await registerRoute(mkReq("POST", BASE_URL, { body: PROFILE, cookie: pending.cookie })))).status).toBe(401);
  });

  it("an account suspended after login loses access at once (403)", async () => {
    const { cookie, userId } = await loginAs("Supplier");
    await world.users.updateStatus(userId, "Suspended");
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile(), cookie })));
    expect(sent.status).toBe(403);
    expect(errorOf(sent).code).toBe("ACCOUNT_INACTIVE");
    expect(await world.suppliers.findByUserId(userId)).toBeNull();
  });

  it("a wrong or missing origin is rejected (CSRF, 403) before anything is stored", async () => {
    const { cookie, userId } = await loginAs("Supplier");
    for (const origin of ["https://evil.example.com", null]) {
      const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile(), cookie, origin })));
      expect(sent.status).toBe(403);
      expect(errorOf(sent).code).toBe("ORIGIN_NOT_ALLOWED");
    }
    expect(await world.suppliers.findByUserId(userId)).toBeNull();
  });

  it("protected and unknown fields are rejected (400)", async () => {
    const { cookie, userId } = await loginAs("Supplier");
    for (const extra of [
      { verificationStatus: "Verified" },
      { registrationDate: "2020-01-01T00:00:00.000Z" },
      { supplierId: "chosen-id" },
      { role: "Administrator" },
      { roleId: "x" },
      { status: "Active" },
      { password: "x" },
      { qualificationStatus: "Verified" },
    ]) {
      const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile(extra), cookie })));
      expect(sent.status, JSON.stringify(extra)).toBe(400);
      expect(errorOf(sent).message).toMatch(/fields that are not allowed/i);
    }
    expect(await world.suppliers.findByUserId(userId)).toBeNull();
  });

  it("missing, blank, wrongly typed and invalid values are rejected (400)", async () => {
    const { cookie } = await loginAs("Supplier");
    const bodies: unknown[] = [
      { companyName: "Only a name" },
      profile({ companyName: "   " }),
      profile({ registrationNumber: 12 }),
      profile({ email: "not-an-email" }),
      profile({ phoneNumber: "abc" }),
      profile({ address: "" }),
      profile({ companyName: "x".repeat(201) }),
    ];
    for (const body of bodies) {
      const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body, cookie })));
      expect(sent.status, JSON.stringify(body)).toBe(400);
      expect(sent.body.success).toBe(false);
    }
  });

  it("a non-JSON content type, malformed JSON and a non-object body are rejected (400)", async () => {
    const { cookie } = await loginAs("Supplier");
    const base = { method: "POST", headers: { Origin: APP_ORIGIN, Cookie: cookie } };
    const form = new Request(BASE_URL, { ...base, headers: { ...base.headers, "Content-Type": "application/x-www-form-urlencoded" }, body: "a=b" });
    const broken = new Request(BASE_URL, { ...base, headers: { ...base.headers, "Content-Type": "application/json" }, body: "{oops" });
    const array = new Request(BASE_URL, { ...base, headers: { ...base.headers, "Content-Type": "application/json" }, body: "[]" });
    for (const request of [form, broken, array]) expect((await call(await registerRoute(request))).status).toBe(400);
  });

  it("responses are never cacheable", async () => {
    const { cookie } = await loginAs("Supplier");
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile(), cookie })));
    expect(sent.headers.get("cache-control")).toMatch(/no-store/);
  });
});

// ─── GET /api/suppliers (list) ───────────────────────────────────────────────

describe("GET /api/suppliers — list", () => {
  it.each(["Administrator", "Procurement Broker"] as const)("%s sees every supplier", async (role) => {
    const staff = await loginAs(role);
    const a = await registerOwn((await loginAs("Supplier")).cookie);
    const b = await registerOwn((await loginAs("Supplier")).cookie);
    const sent = await call(await listRoute(mkReq("GET", `${BASE_URL}?limit=500`, { cookie: staff.cookie })));
    expect(sent.status).toBe(200);
    const ids = (sent.body.data as { suppliers: Array<{ supplierId: string }> }).suppliers.map((s) => s.supplierId);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
    expect(sent.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("a Supplier and Evaluation Committee cannot list suppliers (403)", async () => {
    for (const role of ["Supplier", "Evaluation Committee"] as const) {
      const { cookie } = await loginAs(role);
      expect((await call(await listRoute(mkReq("GET", BASE_URL, { cookie })))).status).toBe(403);
    }
  });

  it("unauthenticated is 401", async () => {
    expect((await call(await listRoute(mkReq("GET", BASE_URL)))).status).toBe(401);
  });

  it("filters by verificationStatus and pages", async () => {
    const staff = await loginAs("Administrator");
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    await call(await verifyRoute(mkReq("POST", `${BASE_URL}/${id}/verification`, { body: { status: "Verified" }, cookie: staff.cookie }), idParams(id)));

    const verified = await call(await listRoute(mkReq("GET", `${BASE_URL}?verificationStatus=Verified&limit=500`, { cookie: staff.cookie })));
    const list = (verified.body.data as { suppliers: Array<{ supplierId: string; verificationStatus: string }> }).suppliers;
    expect(list.every((s) => s.verificationStatus === "Verified")).toBe(true);
    expect(list.map((s) => s.supplierId)).toContain(id);

    const paged = await call(await listRoute(mkReq("GET", `${BASE_URL}?limit=1&skip=0`, { cookie: staff.cookie })));
    const data = paged.body.data as { suppliers: unknown[]; limit: number; skip: number };
    expect(data.suppliers).toHaveLength(1);
    expect(data).toMatchObject({ limit: 1, skip: 0 });
  });

  it("bad filters and paging are rejected (400)", async () => {
    const staff = await loginAs("Administrator");
    for (const query of ["verificationStatus=Nope", "limit=0", "limit=501", "limit=abc", "limit=", "skip=-1", "skip=1.5"]) {
      const sent = await call(await listRoute(mkReq("GET", `${BASE_URL}?${query}`, { cookie: staff.cookie })));
      expect(sent.status, query).toBe(400);
    }
  });
});

// ─── GET /api/suppliers/me and /api/suppliers/[id] ───────────────────────────

describe("GET /api/suppliers/me", () => {
  it("a Supplier reads their own profile; 404 until they have one", async () => {
    const { cookie, userId } = await loginAs("Supplier");
    expect((await call(await meRoute(mkReq("GET", `${BASE_URL}/me`, { cookie })))).status).toBe(404);
    const id = await registerOwn(cookie);
    const sent = await call(await meRoute(mkReq("GET", `${BASE_URL}/me`, { cookie })));
    expect(sent.status).toBe(200);
    expect(supplierOf(sent)).toMatchObject({ supplierId: id, userId });
  });

  it("staff, committee and anonymous callers cannot use it", async () => {
    for (const role of ["Administrator", "Procurement Broker", "Evaluation Committee"] as const) {
      const { cookie } = await loginAs(role);
      expect((await call(await meRoute(mkReq("GET", `${BASE_URL}/me`, { cookie })))).status).toBe(403);
    }
    expect((await call(await meRoute(mkReq("GET", `${BASE_URL}/me`)))).status).toBe(401);
  });
});

describe("GET /api/suppliers/[id]", () => {
  it("a Supplier reads their own profile", async () => {
    const { cookie } = await loginAs("Supplier");
    const id = await registerOwn(cookie);
    const sent = await call(await getOneRoute(mkReq("GET", `${BASE_URL}/${id}`, { cookie }), idParams(id)));
    expect(sent.status).toBe(200);
    expect(supplierOf(sent).supplierId).toBe(id);
  });

  it("a Supplier cannot read another supplier: 404, identical to a supplier that does not exist", async () => {
    const owner = await loginAs("Supplier");
    const other = await loginAs("Supplier");
    const id = await registerOwn(owner.cookie);

    const denied = await call(await getOneRoute(mkReq("GET", `${BASE_URL}/${id}`, { cookie: other.cookie }), idParams(id)));
    const missing = await call(await getOneRoute(mkReq("GET", `${BASE_URL}/nope`, { cookie: other.cookie }), idParams("nope")));
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual(missing.body);
  });

  it.each(["Administrator", "Procurement Broker"] as const)("%s reads any supplier", async (role) => {
    const staff = await loginAs(role);
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    const sent = await call(await getOneRoute(mkReq("GET", `${BASE_URL}/${id}`, { cookie: staff.cookie }), idParams(id)));
    expect(sent.status).toBe(200);
    expect(supplierOf(sent).supplierId).toBe(id);
  });

  it("Evaluation Committee is refused (403) and anonymous is 401", async () => {
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    const committee = await loginAs("Evaluation Committee");
    expect((await call(await getOneRoute(mkReq("GET", `${BASE_URL}/${id}`, { cookie: committee.cookie }), idParams(id)))).status).toBe(403);
    expect((await call(await getOneRoute(mkReq("GET", `${BASE_URL}/${id}`), idParams(id)))).status).toBe(401);
  });

  it("an unknown or odd id is 404, never a 500", async () => {
    const staff = await loginAs("Administrator");
    for (const id of ["does-not-exist", "   ", "../../etc/passwd", "a".repeat(500), "%00", "{\"$ne\":null}"]) {
      const sent = await call(await getOneRoute(mkReq("GET", `${BASE_URL}/x`, { cookie: staff.cookie }), idParams(id)));
      expect(sent.status, id).toBe(404);
      expect(errorOf(sent).code).toBe("SUPPLIER_NOT_FOUND");
    }
  });
});

// ─── PATCH /api/suppliers/[id] ───────────────────────────────────────────────

describe("PATCH /api/suppliers/[id] — update profile", () => {
  const patch = (id: string, body: unknown, cookie: string, origin?: string | null) =>
    patchRoute(mkReq("PATCH", `${BASE_URL}/${id}`, { body, cookie, origin }), idParams(id));
  const verify = (id: string, status: string, cookie: string) =>
    verifyRoute(mkReq("POST", `${BASE_URL}/${id}/verification`, { body: { status }, cookie }), idParams(id));

  it("a Supplier updates their own profile (200) and only the given fields change", async () => {
    const { cookie } = await loginAs("Supplier");
    const id = await registerOwn(cookie);
    const sent = await call(await patch(id, { address: "New address", phoneNumber: "+251 91 000 0000" }, cookie));
    expect(sent.status).toBe(200);
    expect(supplierOf(sent)).toMatchObject({ address: "New address", phoneNumber: "+251 91 000 0000", companyName: PROFILE.companyName });
  });

  it("a Supplier cannot update another supplier (404) and nothing changes", async () => {
    const owner = await loginAs("Supplier");
    const other = await loginAs("Supplier");
    const id = await registerOwn(owner.cookie);
    const before = (await world.suppliers.findById(id))!.toJSON();

    const sent = await call(await patch(id, { address: "Hijacked" }, other.cookie));
    expect(sent.status).toBe(404);
    expect((await world.suppliers.findById(id))!.toJSON()).toEqual(before);
  });

  it.each(["Administrator", "Procurement Broker"] as const)("%s updates any supplier (200)", async (role) => {
    const staff = await loginAs(role);
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    const sent = await call(await patch(id, { companyName: "Corrected Name PLC" }, staff.cookie));
    expect(sent.status).toBe(200);
    expect(supplierOf(sent).companyName).toBe("Corrected Name PLC");
  });

  it("Evaluation Committee is refused (403), anonymous is 401", async () => {
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    const committee = await loginAs("Evaluation Committee");
    expect((await call(await patch(id, { address: "x" }, committee.cookie))).status).toBe(403);
    expect((await call(await patch(id, { address: "x" }, ""))).status).toBe(401);
  });

  it("protected fields cannot be changed by anyone, staff included (400)", async () => {
    const staff = await loginAs("Administrator");
    const owner = await loginAs("Supplier");
    const id = await registerOwn(owner.cookie);
    const before = (await world.suppliers.findById(id))!.toJSON();
    for (const cookie of [owner.cookie, staff.cookie]) {
      for (const body of [
        { verificationStatus: "Verified" },
        { userId: generateId() },
        { registrationDate: "2020-01-01T00:00:00.000Z" },
        { supplierId: "other" },
        { role: "Administrator" },
        { status: "Active" },
        { address: "ok", verificationStatus: "Verified" },
      ]) {
        const sent = await call(await patch(id, body, cookie));
        expect(sent.status, JSON.stringify(body)).toBe(400);
        expect(errorOf(sent).message).toMatch(/fields that are not allowed/i);
      }
    }
    expect((await world.suppliers.findById(id))!.toJSON()).toEqual(before);
  });

  it("an empty body, blank values and invalid values are rejected (400)", async () => {
    const { cookie } = await loginAs("Supplier");
    const id = await registerOwn(cookie);
    for (const body of [{}, { address: "  " }, { email: "bad" }, { phoneNumber: "x" }, { companyName: 5 }, { registrationNumber: "" }]) {
      expect((await call(await patch(id, body, cookie))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("taking another supplier's registration number is 409", async () => {
    const a = await loginAs("Supplier");
    const b = await loginAs("Supplier");
    await registerOwn(a.cookie, { registrationNumber: "OWNED-1" });
    const idB = await registerOwn(b.cookie);
    expect((await call(await patch(idB, { registrationNumber: "owned-1" }, b.cookie))).status).toBe(409);
  });

  it("a wrong or missing origin is rejected (403) and nothing changes", async () => {
    const { cookie } = await loginAs("Supplier");
    const id = await registerOwn(cookie);
    for (const origin of ["https://evil.example.com", null]) {
      expect((await call(await patch(id, { address: "x" }, cookie, origin))).status).toBe(403);
    }
    expect((await world.suppliers.findById(id))!.address).toBe(PROFILE.address);
  });

  it("a Supplier changing company name or registration number resets a Verified profile to Pending", async () => {
    const staff = await loginAs("Administrator");
    const owner = await loginAs("Supplier");
    const id = await registerOwn(owner.cookie);
    await verify(id, "Verified", staff.cookie);

    const contact = await call(await patch(id, { phoneNumber: "+251 11 555 5555" }, owner.cookie));
    expect(supplierOf(contact).verificationStatus).toBe("Verified");

    const renamed = await call(await patch(id, { companyName: "Renamed PLC" }, owner.cookie));
    expect(supplierOf(renamed).verificationStatus).toBe("Pending");
  });

  it("a staff edit of the company name keeps the verification", async () => {
    const staff = await loginAs("Procurement Broker");
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    await verify(id, "Verified", staff.cookie);
    const sent = await call(await patch(id, { companyName: "Fixed Typo PLC" }, staff.cookie));
    expect(supplierOf(sent).verificationStatus).toBe("Verified");
  });

  it("a suspended Supplier cannot update (403)", async () => {
    const { cookie, userId } = await loginAs("Supplier");
    const id = await registerOwn(cookie);
    await world.users.updateStatus(userId, "Suspended");
    expect((await call(await patch(id, { address: "x" }, cookie))).status).toBe(403);
  });
});

// ─── POST /api/suppliers/[id]/verification ───────────────────────────────────

describe("POST /api/suppliers/[id]/verification", () => {
  const verify = (id: string, body: unknown, cookie: string, origin?: string | null) =>
    verifyRoute(mkReq("POST", `${BASE_URL}/${id}/verification`, { body, cookie, origin }), idParams(id));

  it.each(["Administrator", "Procurement Broker"] as const)("%s verifies and rejects a supplier", async (role) => {
    const staff = await loginAs(role);
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    expect(supplierOf(await call(await verify(id, { status: "Verified" }, staff.cookie))).verificationStatus).toBe("Verified");
    expect(supplierOf(await call(await verify(id, { status: "Rejected" }, staff.cookie))).verificationStatus).toBe("Rejected");
  });

  it("a Supplier cannot verify, not even their own profile (403)", async () => {
    const { cookie } = await loginAs("Supplier");
    const id = await registerOwn(cookie);
    expect((await call(await verify(id, { status: "Verified" }, cookie))).status).toBe(403);
    expect((await world.suppliers.findById(id))!.verificationStatus).toBe("Pending");
  });

  it("Evaluation Committee is refused (403), anonymous is 401", async () => {
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    const committee = await loginAs("Evaluation Committee");
    expect((await call(await verify(id, { status: "Verified" }, committee.cookie))).status).toBe(403);
    expect((await call(await verify(id, { status: "Verified" }, ""))).status).toBe(401);
  });

  it("a wrong or missing origin is rejected (403)", async () => {
    const staff = await loginAs("Administrator");
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    for (const origin of ["https://evil.example.com", null]) {
      expect((await call(await verify(id, { status: "Verified" }, staff.cookie, origin))).status).toBe(403);
    }
  });

  it("only Verified and Rejected are accepted, and unknown fields are rejected (400)", async () => {
    const staff = await loginAs("Administrator");
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    for (const body of [{}, { status: "Pending" }, { status: "Approved" }, { status: 1 }, { status: "Verified", note: "x" }, { verificationStatus: "Verified" }]) {
      expect((await call(await verify(id, body, staff.cookie))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await world.suppliers.findById(id))!.verificationStatus).toBe("Pending");
  });

  it("setting the status the supplier already has is 409", async () => {
    const staff = await loginAs("Administrator");
    const id = await registerOwn((await loginAs("Supplier")).cookie);
    await verify(id, { status: "Verified" }, staff.cookie);
    const sent = await call(await verify(id, { status: "Verified" }, staff.cookie));
    expect(sent.status).toBe(409);
    expect(errorOf(sent).code).toBe("SUPPLIER_VERIFICATION_ERROR");
  });

  it("an unknown supplier is 404", async () => {
    const staff = await loginAs("Administrator");
    expect((await call(await verify("missing", { status: "Verified" }, staff.cookie))).status).toBe(404);
  });
});

// ─── safe errors ─────────────────────────────────────────────────────────────

describe("Safe error responses", () => {
  it("a storage failure is a generic 500: no driver message, no secret, no stack; the cause is logged", async () => {
    const staff = await loginAs("Administrator");
    const spy = vi.spyOn(world.suppliers, "findAll").mockRejectedValueOnce(new Error("failed at mongodb://admin:hunter2@db.internal:27017"));
    const sent = await call(await listRoute(mkReq("GET", BASE_URL, { cookie: staff.cookie })));
    spy.mockRestore();

    expect(sent.status).toBe(500);
    const text = JSON.stringify(sent.body);
    expect(text).not.toMatch(/hunter2|mongodb|db\.internal|stack|at\s.*\(/i);
    expect(world.loggedErrors.some((error) => String((error as Error)?.message).includes("hunter2"))).toBe(true);
  });

  it("every error body has success: false and an error.code and message", async () => {
    const sent = await call(await getOneRoute(mkReq("GET", `${BASE_URL}/unknown`), idParams("unknown")));
    expect(sent.body.success).toBe(false);
    expect(sent.body.error).toHaveProperty("code");
    expect(sent.body.error).toHaveProperty("message");
  });

  it("validation errors never echo submitted values", async () => {
    const { cookie } = await loginAs("Supplier");
    const sent = await call(await registerRoute(mkReq("POST", BASE_URL, { body: profile({ email: "super-secret-value" }), cookie })));
    expect(sent.status).toBe(400);
    expect(JSON.stringify(sent.body)).not.toContain("super-secret-value");
  });
});
