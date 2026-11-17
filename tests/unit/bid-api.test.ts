import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getOneRoute, PATCH as patchRoute } from "@/app/api/bids/[id]/route";
import { POST as withdrawRoute } from "@/app/api/bids/[id]/withdraw/route";
import { GET as listRoute, POST as submitRoute } from "@/app/api/bids/route";
import { Supplier } from "@/entities/Supplier";
import { User } from "@/entities/User";
import { generateId } from "@/shared/utilities/uuid";
import { makeTender, TENDER_DEADLINE, TENDER_NOW } from "../support/fixtures";
import { APP_ORIGIN, createInMemoryBidApiWorld } from "../support/inMemoryBidApiWorld";

type World = Awaited<ReturnType<typeof createInMemoryBidApiWorld>>;
type RoleName = "Administrator" | "Procurement Broker" | "Supplier" | "Evaluation Committee";

const PASSWORD = "correct horse battery";
const BASE = `${APP_ORIGIN}/api/bids`;
let world: World;
let counter = 0;

beforeAll(async () => {
  world = await createInMemoryBidApiWorld();
});
afterAll(() => world.dispose());

interface Sent {
  status: number;
  body: { data: { bid: Record<string, unknown>; bids: Array<Record<string, unknown>> }; error: { code: string } };
  raw: string;
}
function mkReq(method: string, url: string, opts: { body?: unknown; cookie?: string; origin?: string | null; rawBody?: string } = {}): Request {
  const headers = new Headers();
  const origin = opts.origin === undefined ? APP_ORIGIN : opts.origin;
  if (origin !== null) headers.set("Origin", origin);
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, { method, headers, body });
}
async function call(response: Response): Promise<Sent> {
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw), raw };
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const codeOf = (s: Sent) => s.body.error.code;

async function loginAs(roleName: RoleName, status: "Active" | "Suspended" = "Active"): Promise<{ cookie: string; userId: string }> {
  const email = `${roleName.replace(/\s+/g, "").toLowerCase()}${(counter += 1)}@example.com`;
  const role = (await world.roles.findByName(roleName))!;
  const user = await world.users.create(
    User.restore({ userId: generateId(), fullName: "Test", email, passwordHash: await world.passwords.hash(PASSWORD), roleId: role.roleId, status: "Active", createdAt: new Date() }),
  );
  const response = await (await import("@/app/api/auth/login/route")).POST(mkReq("POST", `${APP_ORIGIN}/api/auth/login`, { body: { email, password: PASSWORD } }));
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (status !== "Active") await world.users.updateStatus(user.userId, status);
  return { cookie, userId: user.userId };
}
async function loginSupplier(): Promise<{ cookie: string; userId: string; supplierId: string }> {
  const session = await loginAs("Supplier");
  const supplier = await world.suppliers.create(
    Supplier.register({ supplierId: `supplier-${(counter += 1)}`, userId: session.userId, companyName: "Abyssinia PLC", registrationNumber: `REG-${counter}`, email: "c@a.example", phoneNumber: "+251 11 123 4567", address: "Bole", registrationDate: TENDER_NOW }),
  );
  return { ...session, supplierId: supplier.supplierId };
}
async function publishedTender(brokerId = "broker-1"): Promise<string> {
  const tender = makeTender({ brokerId });
  tender.publish(TENDER_NOW);
  return (await world.tenders.create(tender)).tenderId;
}
const bidBody = (tenderId: string, extra: Record<string, unknown> = {}) => ({ tenderId, technicalProposal: "Plan", financialProposal: 5000, supportingDocuments: ["doc-1"], ...extra });
const submit = async (cookie: string, tenderId: string, extra: Record<string, unknown> = {}) => call(await submitRoute(mkReq("POST", BASE, { cookie, body: bidBody(tenderId, extra) })));
const bidOf = (s: Sent) => s.body.data.bid;

describe("POST /api/bids", () => {
  it("201: a supplier submits; the bid belongs to their profile; the body shows no secrets", async () => {
    const s = await loginSupplier();
    const t = await publishedTender();
    const sent = await submit(s.cookie, t);
    expect(sent.status).toBe(201);
    expect(bidOf(sent)).toMatchObject({ tenderId: t, supplierId: s.supplierId, status: "Submitted", financialProposal: 5000 });
    expect(sent.raw).not.toMatch(/passwordHash|userId/);
  });

  it("401 without a session", async () => {
    const t = await publishedTender();
    const sent = await submit("", t);
    expect(sent.status).toBe(401);
  });

  it.each(["Administrator", "Procurement Broker", "Evaluation Committee"] as const)("403 for a %s", async (role) => {
    const { cookie } = await loginAs(role);
    const t = await publishedTender();
    const sent = await submit(cookie, t);
    expect(sent.status).toBe(403);
    expect(await world.bids.findByTenderId(t)).toEqual([]);
  });

  it("a suspended supplier's old session is refused and nothing is stored", async () => {
    const s = await loginSupplier();
    await world.users.updateStatus(s.userId, "Suspended");
    const t = await publishedTender();
    expect([401, 403]).toContain((await submit(s.cookie, t)).status);
    expect(await world.bids.findByTenderId(t)).toEqual([]);
  });

  it("403 when the Origin header is missing or foreign (CSRF)", async () => {
    const s = await loginSupplier();
    const t = await publishedTender();
    for (const origin of [null, "https://evil.example"]) {
      const sent = await call(await submitRoute(mkReq("POST", BASE, { cookie: s.cookie, origin, body: bidBody(t) })));
      expect(sent.status).toBe(403);
    }
    expect(await world.bids.findByTenderId(t)).toEqual([]);
  });

  it.each(["supplierId", "userId", "status", "complianceStatus", "submissionDate", "bidId", "role"])("400 when the body contains the protected field %s", async (field) => {
    const s = await loginSupplier();
    const t = await publishedTender();
    const sent = await submit(s.cookie, t, { [field]: "x" });
    expect(sent.status).toBe(400);
    expect(codeOf(sent)).toBe("INVALID_REQUEST");
    expect(await world.bids.findByTenderId(t)).toEqual([]);
  });

  it.each([
    ["missing technical proposal", { technicalProposal: undefined }],
    ["missing amount", { financialProposal: undefined }],
    ["zero amount", { financialProposal: 0 }],
    ["string amount", { financialProposal: "5" }],
    ["too many documents", { supportingDocuments: Array.from({ length: 21 }, (_, i) => `d${i}`) }],
  ])("400 for %s, and the supplier can still submit afterwards", async (_l, extra) => {
    const s = await loginSupplier();
    const t = await publishedTender();
    expect((await submit(s.cookie, t, extra as Record<string, unknown>)).status).toBe(400);
    expect(await world.bids.existsBySupplierAndTender(s.supplierId, t)).toBe(false);
    expect((await submit(s.cookie, t)).status).toBe(201);
  });

  it("400 for invalid JSON and a non-object body", async () => {
    const s = await loginSupplier();
    for (const rawBody of ["{", "[]", "null"]) {
      expect((await call(await submitRoute(mkReq("POST", BASE, { cookie: s.cookie, rawBody })))).status).toBe(400);
    }
  });

  it("400 for an invalid tender id; 404 for an unknown, Draft or Cancelled tender", async () => {
    const s = await loginSupplier();
    expect((await submit(s.cookie, "bad id")).status).toBe(400);
    expect((await submit(s.cookie, "missing")).status).toBe(404);
    const draft = await world.tenders.create(makeTender());
    expect((await submit(s.cookie, draft.tenderId)).status).toBe(404);
    const cancelled = makeTender();
    cancelled.publish(TENDER_NOW);
    cancelled.cancel();
    await world.tenders.create(cancelled);
    expect((await submit(s.cookie, cancelled.tenderId)).status).toBe(404);
  });

  it("409 for a Closed tender and after the deadline", async () => {
    const s = await loginSupplier();
    const closed = makeTender();
    closed.publish(TENDER_NOW);
    closed.close(TENDER_DEADLINE);
    await world.tenders.create(closed);
    expect(await submit(s.cookie, closed.tenderId)).toMatchObject({ status: 409 });

    const t = await publishedTender();
    world.clock.now = TENDER_DEADLINE;
    const late = await submit(s.cookie, t);
    world.clock.now = TENDER_NOW;
    expect(late.status).toBe(409);
    expect(codeOf(late)).toBe("TENDER_CLOSED");
  });

  it("409 for a duplicate; concurrent requests create exactly one bid", async () => {
    const s = await loginSupplier();
    const t = await publishedTender();
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(s.cookie, t)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await world.bids.findBySupplierId(s.supplierId)).toHaveLength(1);
  });
});

describe("GET /api/bids and GET /api/bids/[id]", () => {
  it("401 without a session", async () => {
    expect((await call(await listRoute(mkReq("GET", BASE)))).status).toBe(401);
    expect((await call(await getOneRoute(mkReq("GET", `${BASE}/x`), idParams("x")))).status).toBe(401);
  });

  it("a supplier sees only their own bids and gets 404 for another supplier's bid", async () => {
    const a = await loginSupplier();
    const b = await loginSupplier();
    const t = await publishedTender();
    const bidA = bidOf(await submit(a.cookie, t));
    await submit(b.cookie, t);
    const list = await call(await listRoute(mkReq("GET", BASE, { cookie: a.cookie })));
    expect(list.status).toBe(200);
    expect(list.body.data.bids).toHaveLength(1);
    expect(list.body.data.bids[0].bidId).toBe(bidA.bidId);
    expect((await call(await getOneRoute(mkReq("GET", `${BASE}/${bidA.bidId}`, { cookie: b.cookie }), idParams(bidA.bidId as string)))).status).toBe(404);
    expect((await call(await getOneRoute(mkReq("GET", `${BASE}/${bidA.bidId}`, { cookie: a.cookie }), idParams(bidA.bidId as string)))).status).toBe(200);
  });

  it("400 for bad query parameters", async () => {
    const s = await loginSupplier();
    for (const q of ["limit=0", "limit=abc", "skip=-1", "status=Bogus", "tenderId=a%20b"]) {
      expect((await call(await listRoute(mkReq("GET", `${BASE}?${q}`, { cookie: s.cookie })))).status).toBe(400);
    }
  });

  it("sealed: an Administrator gets 409 before the tender closes, the data after; Committee always 403; strange broker 404", async () => {
    const owner = await loginAs("Procurement Broker");
    const t = await publishedTender(owner.userId);
    const s = await loginSupplier();
    const bid = bidOf(await submit(s.cookie, t));
    const admin = await loginAs("Administrator");

    const sealedList = await call(await listRoute(mkReq("GET", `${BASE}?tenderId=${t}`, { cookie: admin.cookie })));
    expect(sealedList.status).toBe(409);
    expect(sealedList.raw).not.toContain("5000");
    const sealedOne = await call(await getOneRoute(mkReq("GET", `${BASE}/${bid.bidId}`, { cookie: admin.cookie }), idParams(bid.bidId as string)));
    expect(sealedOne.status).toBe(409);
    expect(sealedOne.raw).not.toContain("Plan");

    const tender = (await world.tenders.findById(t))!;
    tender.close(TENDER_DEADLINE);
    await world.tenders.updateStatus(t, "Closed");

    expect((await call(await listRoute(mkReq("GET", `${BASE}?tenderId=${t}`, { cookie: admin.cookie })))).body.data.bids).toHaveLength(1);
    expect((await call(await listRoute(mkReq("GET", `${BASE}?tenderId=${t}`, { cookie: owner.cookie })))).status).toBe(200);
    const stranger = await loginAs("Procurement Broker");
    expect((await call(await getOneRoute(mkReq("GET", `${BASE}/${bid.bidId}`, { cookie: stranger.cookie }), idParams(bid.bidId as string)))).status).toBe(404);
    const committee = await loginAs("Evaluation Committee");
    expect((await call(await listRoute(mkReq("GET", `${BASE}?tenderId=${t}`, { cookie: committee.cookie })))).status).toBe(403);
    expect((await call(await getOneRoute(mkReq("GET", `${BASE}/${bid.bidId}`, { cookie: committee.cookie }), idParams(bid.bidId as string)))).status).toBe(403);
  });
});

describe("PATCH /api/bids/[id] and POST /api/bids/[id]/withdraw", () => {
  async function owned() {
    const s = await loginSupplier();
    const t = await publishedTender();
    const bid = bidOf(await submit(s.cookie, t));
    return { s, t, id: bid.bidId as string };
  }
  const patch = async (cookie: string, id: string, body: unknown, origin?: string | null) => call(await patchRoute(mkReq("PATCH", `${BASE}/${id}`, { cookie, body, ...(origin !== undefined ? { origin } : {}) }), idParams(id)));
  const withdraw = async (cookie: string, id: string, origin?: string | null) => call(await withdrawRoute(mkReq("POST", `${BASE}/${id}/withdraw`, { cookie, ...(origin !== undefined ? { origin } : {}) }), idParams(id)));

  it("200: the owner updates and withdraws before the deadline", async () => {
    const { s, id } = await owned();
    const updated = await patch(s.cookie, id, { financialProposal: 4000 });
    expect(updated.status).toBe(200);
    expect(bidOf(updated).financialProposal).toBe(4000);
    const withdrawn = await withdraw(s.cookie, id);
    expect(withdrawn.status).toBe(200);
    expect(bidOf(withdrawn).status).toBe("Withdrawn");
  });

  it("401 anonymous, 403 for non-suppliers, 403 for a bad origin", async () => {
    const { s, id } = await owned();
    expect((await patch("", id, { financialProposal: 1 })).status).toBe(401);
    expect((await withdraw("", id)).status).toBe(401);
    for (const role of ["Administrator", "Procurement Broker", "Evaluation Committee"] as const) {
      const { cookie } = await loginAs(role);
      expect((await patch(cookie, id, { financialProposal: 1 })).status).toBe(403);
      expect((await withdraw(cookie, id)).status).toBe(403);
    }
    expect((await patch(s.cookie, id, { financialProposal: 1 }, "https://evil.example")).status).toBe(403);
    expect((await withdraw(s.cookie, id, null)).status).toBe(403);
    expect(await world.bids.findById(id)).toMatchObject({ financialProposal: 5000, status: "Submitted" });
  });

  it("404 for another supplier's bid and an unknown bid; nothing changes", async () => {
    const { id } = await owned();
    const other = await loginSupplier();
    expect((await patch(other.cookie, id, { financialProposal: 1 })).status).toBe(404);
    expect((await withdraw(other.cookie, id)).status).toBe(404);
    expect((await patch(other.cookie, "missing", { financialProposal: 1 })).status).toBe(404);
    expect(await world.bids.findById(id)).toMatchObject({ financialProposal: 5000, status: "Submitted" });
  });

  it.each([{ status: "Accepted" }, { supplierId: "x" }, { tenderId: "t" }, { complianceStatus: "Compliant" }, {}, { financialProposal: -1 }, { technicalProposal: "" }])("400 for the update body %j", async (body) => {
    const { s, id } = await owned();
    expect((await patch(s.cookie, id, body)).status).toBe(400);
    expect(await world.bids.findById(id)).toMatchObject({ financialProposal: 5000 });
  });

  it("409 after the deadline: the bid is immutable", async () => {
    const { s, id } = await owned();
    world.clock.now = TENDER_DEADLINE;
    const updated = await patch(s.cookie, id, { financialProposal: 1 });
    const withdrawn = await withdraw(s.cookie, id);
    world.clock.now = TENDER_NOW;
    expect(updated.status).toBe(409);
    expect(codeOf(updated)).toBe("DEADLINE_EXPIRED");
    expect(withdrawn.status).toBe(409);
    expect(await world.bids.findById(id)).toMatchObject({ financialProposal: 5000, status: "Submitted" });
  });

  it("409 when updating or withdrawing a withdrawn bid", async () => {
    const { s, id } = await owned();
    await withdraw(s.cookie, id);
    expect((await patch(s.cookie, id, { financialProposal: 1 })).status).toBe(409);
    expect((await withdraw(s.cookie, id)).status).toBe(409);
  });

  it("a server error is hidden: no stack or internals in the response", async () => {
    const { s, id } = await owned();
    const original = world.bids.findById.bind(world.bids);
    world.bids.findById = async () => {
      throw new Error("mongodb://secret-host/db exploded");
    };
    const sent = await call(await getOneRoute(mkReq("GET", `${BASE}/${id}`, { cookie: s.cookie }), idParams(id)));
    world.bids.findById = original;
    expect(sent.status).toBe(500);
    expect(sent.raw).not.toMatch(/secret-host|exploded|stack/);
  });
});
