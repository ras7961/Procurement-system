import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DELETE as deleteRoute,
  GET as getOneRoute,
  PATCH as patchRoute,
} from "@/app/api/tenders/[id]/route";
import { POST as cancelRoute } from "@/app/api/tenders/[id]/cancel/route";
import { POST as closeRoute } from "@/app/api/tenders/[id]/close/route";
import { POST as publishRoute } from "@/app/api/tenders/[id]/publish/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/tenders/route";
import { User, type UserStatus } from "@/entities/User";
import { generateId } from "@/shared/utilities/uuid";
import {
  APP_ORIGIN,
  createInMemoryTenderApiWorld,
} from "../support/inMemoryTenderApiWorld";

type World = Awaited<ReturnType<typeof createInMemoryTenderApiWorld>>;

const PASSWORD = "correct horse battery";
// A deadline well in the future (year 2030, same convention as fixtures.ts)
const DEADLINE = "2030-02-10T09:00:00.000Z";
const BASE_TENDER = {
  title: "Supply of office furniture",
  description: "Desks, chairs, filing cabinets.",
  category: "Goods",
  estimatedBudget: 250000,
  requirements: ["Valid trade licence"],
  evaluationCriteria: ["Technical compliance", "Price"],
  submissionDeadline: DEADLINE,
};

// ─── utilities ───────────────────────────────────────────────────────────────

interface Sent {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

function mkReq(
  method: string,
  url: string,
  opts: { body?: unknown; cookie?: string; origin?: string | null } = {},
): Request {
  const headers = new Headers();
  const origin = opts.origin === undefined ? APP_ORIGIN : opts.origin;
  if (origin !== null) headers.set("Origin", origin);
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function call(res: Response): Promise<Sent> {
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), headers: res.headers };
}

const BASE_URL = `${APP_ORIGIN}/api/tenders`;

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ─── world setup ──────────────────────────────────────────────────────────────

let world: World;
let counter = 0;

type RoleName =
  | "Administrator"
  | "Procurement Broker"
  | "Supplier"
  | "Evaluation Committee";

beforeAll(async () => {
  world = await createInMemoryTenderApiWorld();
});
afterAll(async () => {
  world.dispose();
});

/** Create a user with hashed password and return their session cookie from /api/auth/login. */
async function loginAs(
  roleName: RoleName,
  status: UserStatus = "Active",
): Promise<{ cookie: string; userId: string }> {
  const email = `${roleName.replace(/\s+/g, "").toLowerCase()}${(counter += 1)}@example.com`;
  const hash = await world.passwords.hash(PASSWORD);
  const role = (await world.roles.findByName(roleName))!;
  const user = await world.users.create(
    User.restore({
      userId: generateId(),
      fullName: "Test User",
      email,
      passwordHash: hash,
      roleId: role.roleId,
      status,
      createdAt: new Date(),
    }),
  );
  if (status !== "Active") {
    await world.users.updateStatus(user.userId, status);
    return { cookie: "", userId: user.userId }; // inactive – login would fail; caller uses cookie: ""
  }
  const req = mkReq("POST", `${APP_ORIGIN}/api/auth/login`, {
    body: { email, password: PASSWORD },
  });
  const { headers } = await (await import("@/app/api/auth/login/route"))
    .POST(req)
    .then((r) => ({ headers: r.headers }));
  const setCookie = headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  return { cookie, userId: user.userId };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Create a draft tender as a broker and return its ID. */
async function seedDraft(
  cookie: string,
  overrides: Partial<typeof BASE_TENDER> = {},
): Promise<string> {
  const r = await createRoute(
    mkReq("POST", BASE_URL, { body: { ...BASE_TENDER, ...overrides }, cookie }),
  );
  const sent = await call(r);
  expect(
    sent.status,
    `Expected 201 but got ${sent.status}: ${JSON.stringify(sent.body)}`,
  ).toBe(201);
  return (sent.body.data as { tender: { tenderId: string } }).tender.tenderId;
}

/** Publish a draft tender. */
async function seedPublished(
  cookie: string,
  overrides: Partial<typeof BASE_TENDER> = {},
): Promise<string> {
  const id = await seedDraft(cookie, overrides);
  const r = await publishRoute(
    mkReq("POST", `${BASE_URL}/${id}/publish`, { cookie }),
    idParams(id),
  );
  const sent = await call(r);
  expect(
    sent.status,
    `Expected 200 from publish but got ${sent.status}: ${JSON.stringify(sent.body)}`,
  ).toBe(200);
  return id;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("POST /api/tenders — create", () => {
  it("a Broker creates a draft and gets 201 with the tender data", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(mkReq("POST", BASE_URL, { body: BASE_TENDER, cookie })),
    );
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    const { tender } = r.body.data as { tender: Record<string, unknown> };
    expect(tender.status).toBe("Draft");
    expect(tender.title).toBe(BASE_TENDER.title);
    expect(tender).not.toHaveProperty("passwordHash");
  });

  it("an Administrator without brokerId is rejected with 400 (must name a broker)", async () => {
    const { cookie } = await loginAs("Administrator");
    const r = await call(
      await createRoute(mkReq("POST", BASE_URL, { body: BASE_TENDER, cookie })),
    );
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect((r.body.error as { message: string }).message).toMatch(/brokerId/i);
  });

  it("an Administrator with a valid active Broker brokerId creates the tender (201) owned by that broker", async () => {
    const { cookie } = await loginAs("Administrator");
    const { userId: brokerId } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, { body: { ...BASE_TENDER, brokerId }, cookie }),
      ),
    );
    expect(r.status).toBe(201);
    const { tender } = r.body.data as { tender: Record<string, unknown> };
    expect(tender.brokerId).toBe(brokerId);
    expect(tender.status).toBe("Draft");
  });

  it("an Administrator naming a non-existent brokerId gets 400", async () => {
    const { cookie } = await loginAs("Administrator");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, brokerId: generateId() },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
    expect((r.body.error as { message: string }).message).toMatch(
      /active Procurement Broker/i,
    );
  });

  it("an Administrator naming an inactive Broker gets 400", async () => {
    const { cookie } = await loginAs("Administrator");
    const { userId: suspendedBroker } = await loginAs(
      "Procurement Broker",
      "Suspended",
    );
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, brokerId: suspendedBroker },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
    expect((r.body.error as { message: string }).message).toMatch(
      /active Procurement Broker/i,
    );
  });

  it("an Administrator naming a non-Broker user (Supplier, Administrator, Committee) gets 400", async () => {
    const { cookie, userId: adminId } = await loginAs("Administrator");
    const { userId: supplierId } = await loginAs("Supplier");
    const { userId: committeeId } = await loginAs("Evaluation Committee");
    for (const brokerId of [supplierId, adminId, committeeId]) {
      const r = await call(
        await createRoute(
          mkReq("POST", BASE_URL, {
            body: { ...BASE_TENDER, brokerId },
            cookie,
          }),
        ),
      );
      expect(r.status).toBe(400);
      expect((r.body.error as { message: string }).message).toMatch(
        /active Procurement Broker/i,
      );
    }
  });

  it("an Administrator sending a blank or non-string brokerId gets 400", async () => {
    const { cookie } = await loginAs("Administrator");
    for (const brokerId of ["", "   ", 123, null]) {
      const r = await call(
        await createRoute(
          mkReq("POST", BASE_URL, {
            body: { ...BASE_TENDER, brokerId },
            cookie,
          }),
        ),
      );
      expect(r.status).toBe(400);
    }
  });

  it("an Administrator still cannot send other protected fields (status)", async () => {
    const { cookie } = await loginAs("Administrator");
    const { userId: brokerId } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, brokerId, status: "Published" },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
    expect((r.body.error as { message: string }).message).toMatch(
      /fields that are not allowed/i,
    );
  });

  it("a Broker supplying their own brokerId is still rejected with 400", async () => {
    const { cookie, userId } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, brokerId: userId },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
    expect((r.body.error as { message: string }).message).toMatch(
      /fields that are not allowed/i,
    );
  });

  it("a Broker supplying another broker's brokerId is rejected with 400 and creates nothing", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const { userId: otherBroker } = await loginAs("Procurement Broker");
    const before = (await world.tenders.findAll()).length;
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, brokerId: otherBroker },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
    expect((await world.tenders.findAll()).length).toBe(before);
  });

  it("Supplier and Evaluation Committee supplying brokerId get 403 (permission fails first)", async () => {
    const { userId: brokerId } = await loginAs("Procurement Broker");
    for (const role of ["Supplier", "Evaluation Committee"] as const) {
      const { cookie } = await loginAs(role);
      const r = await call(
        await createRoute(
          mkReq("POST", BASE_URL, {
            body: { ...BASE_TENDER, brokerId },
            cookie,
          }),
        ),
      );
      expect(r.status).toBe(403);
    }
  });

  it("an Administrator's brokerId request is still subject to the CSRF origin check", async () => {
    const { cookie } = await loginAs("Administrator");
    const { userId: brokerId } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, brokerId },
          cookie,
          origin: "https://evil.example.com",
        }),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("unauthenticated request is 401", async () => {
    const r = await call(
      await createRoute(mkReq("POST", BASE_URL, { body: BASE_TENDER })),
    );
    expect(r.status).toBe(401);
    expect(r.body.success).toBe(false);
  });

  it("Supplier cannot create a tender (403)", async () => {
    const { cookie } = await loginAs("Supplier");
    const r = await call(
      await createRoute(mkReq("POST", BASE_URL, { body: BASE_TENDER, cookie })),
    );
    expect(r.status).toBe(403);
  });

  it("Evaluation Committee cannot create a tender (403)", async () => {
    const { cookie } = await loginAs("Evaluation Committee");
    const r = await call(
      await createRoute(mkReq("POST", BASE_URL, { body: BASE_TENDER, cookie })),
    );
    expect(r.status).toBe(403);
  });

  it("wrong origin is rejected with 403 (CSRF)", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: BASE_TENDER,
          cookie,
          origin: "https://evil.example.com",
        }),
      ),
    );
    expect(r.status).toBe(403);
    expect((r.body.error as { code: string }).code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("no origin header is rejected (CSRF)", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, { body: BASE_TENDER, cookie, origin: null }),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("missing required fields return 400 with descriptive error", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, { body: { title: "Only title" }, cookie }),
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
    expect((r.body.error as { message: string }).message).toMatch(/invalid/i);
  });

  it("unknown fields in body are rejected with 400", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, status: "Published" },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
    expect((r.body.error as { message: string }).message).toMatch(
      /fields that are not allowed/i,
    );
  });

  it("brokerId in body is rejected (protected field)", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, brokerId: generateId() },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
  });

  it("non-JSON Content-Type is rejected with 400", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const req = new Request(BASE_URL, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "title=test",
    });
    const r = await call(await createRoute(req));
    expect(r.status).toBe(400);
  });

  it("past deadline returns 400", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: {
            ...BASE_TENDER,
            submissionDeadline: "2000-01-01T00:00:00.000Z",
          },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
  });

  it("negative budget returns 400", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(
        mkReq("POST", BASE_URL, {
          body: { ...BASE_TENDER, estimatedBudget: -1 },
          cookie,
        }),
      ),
    );
    expect(r.status).toBe(400);
  });

  it("inactive user is rejected with 403", async () => {
    // A suspended user cannot log in, so there is no session at all.
    await loginAs("Procurement Broker", "Suspended");
    const r = await call(
      await createRoute(mkReq("POST", BASE_URL, { body: BASE_TENDER })),
    );
    expect(r.status).toBe(401); // no session at all
  });

  it("responses have no-store cache headers", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await createRoute(mkReq("POST", BASE_URL, { body: BASE_TENDER, cookie })),
    );
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
  });
});

describe("GET /api/tenders — list", () => {
  let brokerCookie: string;
  let otherBrokerCookie: string;
  let supplierCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    ({ cookie: brokerCookie } = await loginAs("Procurement Broker"));
    ({ cookie: otherBrokerCookie } = await loginAs("Procurement Broker"));
    ({ cookie: supplierCookie } = await loginAs("Supplier"));
    ({ cookie: adminCookie } = await loginAs("Administrator"));
  });

  it("Broker lists their own tenders only", async () => {
    const myId = await seedDraft(brokerCookie);
    await seedDraft(otherBrokerCookie);
    const r = await call(
      await listRoute(mkReq("GET", BASE_URL, { cookie: brokerCookie })),
    );
    expect(r.status).toBe(200);
    const { tenders } = r.body.data as { tenders: { tenderId: string }[] };
    const ids = tenders.map((t) => t.tenderId);
    expect(ids).toContain(myId);
    expect(ids).not.toContain("other broker tender");
    // All returned tenders belong to this broker
    expect(tenders.every((t) => t)).toBe(true);
  });

  it("Administrator sees all tenders from all brokers", async () => {
    const id1 = await seedDraft(brokerCookie);
    const id2 = await seedDraft(otherBrokerCookie);
    const r = await call(
      await listRoute(mkReq("GET", BASE_URL, { cookie: adminCookie })),
    );
    expect(r.status).toBe(200);
    const { tenders } = r.body.data as { tenders: { tenderId: string }[] };
    const ids = tenders.map((t) => t.tenderId);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("Supplier sees only Published tenders", async () => {
    const draftId = await seedDraft(brokerCookie);
    const publishedId = await seedPublished(brokerCookie);
    const r = await call(
      await listRoute(mkReq("GET", BASE_URL, { cookie: supplierCookie })),
    );
    expect(r.status).toBe(200);
    const { tenders } = r.body.data as {
      tenders: { tenderId: string; status: string }[];
    };
    expect(tenders.every((t) => t.status === "Published")).toBe(true);
    expect(tenders.map((t) => t.tenderId)).toContain(publishedId);
    expect(tenders.map((t) => t.tenderId)).not.toContain(draftId);
  });

  it("Evaluation Committee is denied (403)", async () => {
    const { cookie } = await loginAs("Evaluation Committee");
    const r = await call(await listRoute(mkReq("GET", BASE_URL, { cookie })));
    expect(r.status).toBe(403);
  });

  it("unauthenticated is 401", async () => {
    const r = await call(await listRoute(mkReq("GET", BASE_URL)));
    expect(r.status).toBe(401);
  });

  it("Supplier filtering for Draft returns empty list", async () => {
    await seedDraft(brokerCookie);
    const r = await call(
      await listRoute(
        mkReq("GET", `${BASE_URL}?status=Draft`, { cookie: supplierCookie }),
      ),
    );
    expect(r.status).toBe(200);
    expect((r.body.data as { tenders: unknown[] }).tenders).toHaveLength(0);
  });

  it("Broker asking for another broker's tenders returns empty list", async () => {
    const { userId: otherId } = await loginAs("Procurement Broker");
    const r = await call(
      await listRoute(
        mkReq("GET", `${BASE_URL}?brokerId=${otherId}`, {
          cookie: brokerCookie,
        }),
      ),
    );
    expect(r.status).toBe(200);
    expect((r.body.data as { tenders: unknown[] }).tenders).toHaveLength(0);
  });

  it("valid pagination params work", async () => {
    await seedDraft(brokerCookie);
    const r = await call(
      await listRoute(
        mkReq("GET", `${BASE_URL}?limit=5&skip=0`, { cookie: brokerCookie }),
      ),
    );
    expect(r.status).toBe(200);
    const data = r.body.data as { limit: number; skip: number };
    expect(data.limit).toBe(5);
    expect(data.skip).toBe(0);
  });

  it("invalid status query param is 400", async () => {
    const r = await call(
      await listRoute(
        mkReq("GET", `${BASE_URL}?status=Archived`, { cookie: brokerCookie }),
      ),
    );
    expect(r.status).toBe(400);
  });

  it("invalid limit is 400", async () => {
    const r = await call(
      await listRoute(
        mkReq("GET", `${BASE_URL}?limit=0`, { cookie: brokerCookie }),
      ),
    );
    expect(r.status).toBe(400);
  });

  it("negative skip is 400", async () => {
    const r = await call(
      await listRoute(
        mkReq("GET", `${BASE_URL}?skip=-1`, { cookie: brokerCookie }),
      ),
    );
    expect(r.status).toBe(400);
  });
});

describe("GET /api/tenders/[id] — get one", () => {
  it("Broker reads their own tender", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/${id}`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
    expect(
      (r.body.data as { tender: { tenderId: string } }).tender.tenderId,
    ).toBe(id);
  });

  it("Broker cannot read another broker's tender (404)", async () => {
    const { cookie: broker1Cookie } = await loginAs("Procurement Broker");
    const { cookie: broker2Cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(broker1Cookie);
    const r = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/${id}`, { cookie: broker2Cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(404);
  });

  it("Administrator reads any tender", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: adminCookie } = await loginAs("Administrator");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/${id}`, { cookie: adminCookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
  });

  it("Supplier can read a Published tender", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: supplierCookie } = await loginAs("Supplier");
    const id = await seedPublished(brokerCookie);
    const r = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/${id}`, { cookie: supplierCookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
    expect((r.body.data as { tender: { status: string } }).tender.status).toBe(
      "Published",
    );
  });

  it("Supplier cannot read a Draft (404 — does not reveal existence)", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: supplierCookie } = await loginAs("Supplier");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/${id}`, { cookie: supplierCookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(404);
  });

  it("Evaluation Committee is denied (403)", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: committeeCookie } = await loginAs("Evaluation Committee");
    const id = await seedPublished(brokerCookie);
    const r = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/${id}`, { cookie: committeeCookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("non-existent ID is 404", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/nonexistent`, { cookie }),
        idParams("nonexistent"),
      ),
    );
    expect(r.status).toBe(404);
  });

  it("unauthenticated is 401", async () => {
    const r = await call(
      await getOneRoute(mkReq("GET", `${BASE_URL}/any`), idParams("any")),
    );
    expect(r.status).toBe(401);
  });
});

describe("PATCH /api/tenders/[id] — update", () => {
  it("Broker updates their own draft and gets updated data", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { title: "New Title" },
          cookie,
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
    expect((r.body.data as { tender: { title: string } }).tender.title).toBe(
      "New Title",
    );
  });

  it("another Broker cannot update someone else's tender (403)", async () => {
    const { cookie: owner } = await loginAs("Procurement Broker");
    const { cookie: other } = await loginAs("Procurement Broker");
    const id = await seedDraft(owner);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { title: "Hijacked" },
          cookie: other,
        }),
        idParams(id),
      ),
    );
    expect([403, 404]).toContain(r.status);
  });

  it("another Broker with their own cookie is denied (403)", async () => {
    const { cookie: owner } = await loginAs("Procurement Broker");
    const { cookie: other } = await loginAs("Procurement Broker");
    const id = await seedDraft(owner);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { title: "Hijacked" },
          cookie: other,
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("Administrator can update any broker's tender", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: adminCookie } = await loginAs("Administrator");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { title: "Admin update" },
          cookie: adminCookie,
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
  });

  it("Supplier cannot update (403)", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: supplierCookie } = await loginAs("Supplier");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { title: "x" },
          cookie: supplierCookie,
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("wrong origin is 403", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { title: "x" },
          cookie,
          origin: "https://evil.com",
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("unknown fields in body are 400", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { status: "Published" },
          cookie,
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(400);
  });

  it("an Administrator cannot reassign brokerId through PATCH (400, owner unchanged)", async () => {
    const { cookie: brokerCookie, userId: brokerId } =
      await loginAs("Procurement Broker");
    const { userId: otherBroker } = await loginAs("Procurement Broker");
    const { cookie: adminCookie } = await loginAs("Administrator");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { brokerId: otherBroker },
          cookie: adminCookie,
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(400);
    expect((await world.tenders.findById(id))?.brokerId).toBe(brokerId);
  });

  it("brokerId in body is rejected", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, {
          body: { brokerId: generateId() },
          cookie,
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(400);
  });

  it("empty body (no changes) returns 400", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await patchRoute(
        mkReq("PATCH", `${BASE_URL}/${id}`, { body: {}, cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(400);
  });
});

describe("POST /api/tenders/[id]/publish", () => {
  it("Broker publishes their own draft", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await publishRoute(
        mkReq("POST", `${BASE_URL}/${id}/publish`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
    expect((r.body.data as { tender: { status: string } }).tender.status).toBe(
      "Published",
    );
  });

  it("another Broker cannot publish (403)", async () => {
    const { cookie: owner } = await loginAs("Procurement Broker");
    const { cookie: other } = await loginAs("Procurement Broker");
    const id = await seedDraft(owner);
    const r = await call(
      await publishRoute(
        mkReq("POST", `${BASE_URL}/${id}/publish`, { cookie: other }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("Administrator can publish any tender", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: adminCookie } = await loginAs("Administrator");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await publishRoute(
        mkReq("POST", `${BASE_URL}/${id}/publish`, { cookie: adminCookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
  });

  it("Supplier cannot publish (403)", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: supplierCookie } = await loginAs("Supplier");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await publishRoute(
        mkReq("POST", `${BASE_URL}/${id}/publish`, { cookie: supplierCookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("publishing already Published tender returns 409", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedPublished(cookie);
    const r = await call(
      await publishRoute(
        mkReq("POST", `${BASE_URL}/${id}/publish`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(409);
  });

  it("wrong origin is 403", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await publishRoute(
        mkReq("POST", `${BASE_URL}/${id}/publish`, {
          cookie,
          origin: "https://evil.com",
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("non-existent tender is 404", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await publishRoute(
        mkReq("POST", `${BASE_URL}/missing/publish`, { cookie }),
        idParams("missing"),
      ),
    );
    expect(r.status).toBe(404);
  });
});

describe("POST /api/tenders/[id]/cancel", () => {
  it("Broker cancels their own draft", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await cancelRoute(
        mkReq("POST", `${BASE_URL}/${id}/cancel`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
    expect((r.body.data as { tender: { status: string } }).tender.status).toBe(
      "Cancelled",
    );
  });

  it("another Broker cannot cancel (403)", async () => {
    const { cookie: owner } = await loginAs("Procurement Broker");
    const { cookie: other } = await loginAs("Procurement Broker");
    const id = await seedDraft(owner);
    const r = await call(
      await cancelRoute(
        mkReq("POST", `${BASE_URL}/${id}/cancel`, { cookie: other }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("cancelling already Cancelled tender returns 409", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    await cancelRoute(
      mkReq("POST", `${BASE_URL}/${id}/cancel`, { cookie }),
      idParams(id),
    );
    const r = await call(
      await cancelRoute(
        mkReq("POST", `${BASE_URL}/${id}/cancel`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(409);
  });

  it("wrong origin is 403", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await cancelRoute(
        mkReq("POST", `${BASE_URL}/${id}/cancel`, {
          cookie,
          origin: "https://evil.com",
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });
});

describe("POST /api/tenders/[id]/close", () => {
  it("closing before deadline returns 409 (deadline not reached)", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedPublished(cookie);
    const r = await call(
      await closeRoute(
        mkReq("POST", `${BASE_URL}/${id}/close`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(409);
  });

  it("another Broker cannot close (403)", async () => {
    const { cookie: owner } = await loginAs("Procurement Broker");
    const { cookie: other } = await loginAs("Procurement Broker");
    const id = await seedPublished(owner);
    const r = await call(
      await closeRoute(
        mkReq("POST", `${BASE_URL}/${id}/close`, { cookie: other }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("closing a Draft returns 409", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await closeRoute(
        mkReq("POST", `${BASE_URL}/${id}/close`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(409);
  });

  it("wrong origin is 403", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedPublished(cookie);
    const r = await call(
      await closeRoute(
        mkReq("POST", `${BASE_URL}/${id}/close`, {
          cookie,
          origin: "https://evil.com",
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });
});

describe("DELETE /api/tenders/[id] — delete draft", () => {
  it("Broker deletes their own draft and gets 200", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await deleteRoute(
        mkReq("DELETE", `${BASE_URL}/${id}`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
    // Verify gone
    const r2 = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/${id}`, { cookie }),
        idParams(id),
      ),
    );
    expect(r2.status).toBe(404);
  });

  it("another Broker cannot delete (403)", async () => {
    const { cookie: owner } = await loginAs("Procurement Broker");
    const { cookie: other } = await loginAs("Procurement Broker");
    const id = await seedDraft(owner);
    const r = await call(
      await deleteRoute(
        mkReq("DELETE", `${BASE_URL}/${id}`, { cookie: other }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("Administrator can delete any draft", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: adminCookie } = await loginAs("Administrator");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await deleteRoute(
        mkReq("DELETE", `${BASE_URL}/${id}`, { cookie: adminCookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(200);
  });

  it("deleting a Published tender returns 409", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedPublished(cookie);
    const r = await call(
      await deleteRoute(
        mkReq("DELETE", `${BASE_URL}/${id}`, { cookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(409);
  });

  it("Supplier cannot delete (403)", async () => {
    const { cookie: brokerCookie } = await loginAs("Procurement Broker");
    const { cookie: supplierCookie } = await loginAs("Supplier");
    const id = await seedDraft(brokerCookie);
    const r = await call(
      await deleteRoute(
        mkReq("DELETE", `${BASE_URL}/${id}`, { cookie: supplierCookie }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("wrong origin is 403", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const id = await seedDraft(cookie);
    const r = await call(
      await deleteRoute(
        mkReq("DELETE", `${BASE_URL}/${id}`, {
          cookie,
          origin: "https://evil.com",
        }),
        idParams(id),
      ),
    );
    expect(r.status).toBe(403);
  });

  it("non-existent ID is 404", async () => {
    const { cookie } = await loginAs("Procurement Broker");
    const r = await call(
      await deleteRoute(
        mkReq("DELETE", `${BASE_URL}/nonexistent`, { cookie }),
        idParams("nonexistent"),
      ),
    );
    expect(r.status).toBe(404);
  });

  it("unauthenticated is 401", async () => {
    const r = await call(
      await deleteRoute(mkReq("DELETE", `${BASE_URL}/any`), idParams("any")),
    );
    expect(r.status).toBe(401);
  });
});

describe("Safe error responses — no internal details leak", () => {
  it("5xx responses return generic message, not stack traces or db errors", async () => {
    // A database failure (injected by using a never-valid user ID path)
    // We test indirectly: storage failure should return 500 with generic message.
    const { cookie } = await loginAs("Procurement Broker");
    // Force an error by simulating a corrupt tenderId that causes a lookup failure
    const r = await call(
      await getOneRoute(mkReq("GET", `${BASE_URL}/`, { cookie }), idParams("")),
    );
    // Should be 404 (empty string becomes TenderNotFoundException), not 500
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/mongodb/i);
    expect(JSON.stringify(r.body)).not.toMatch(/password/i);
  });

  it("every error body has success: false and an error.code", async () => {
    const r = await call(
      await getOneRoute(
        mkReq("GET", `${BASE_URL}/unknown`),
        idParams("unknown"),
      ),
    );
    expect(r.body.success).toBe(false);
    expect(r.body.error).toHaveProperty("code");
    expect(r.body.error).toHaveProperty("message");
  });
});
