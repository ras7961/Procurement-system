import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getOneRoute } from "@/app/api/bids/[id]/route";
import { POST as withdrawRoute } from "@/app/api/bids/[id]/withdraw/route";
import { GET as listRoute, POST as submitRoute } from "@/app/api/bids/route";
import { Supplier } from "@/entities/Supplier";
import { User } from "@/entities/User";
import { generateId } from "@/shared/utilities/uuid";
import { makeTender, TENDER_DEADLINE, TENDER_NOW } from "../support/fixtures";
import { APP_ORIGIN, createInMemoryBidApiWorld } from "../support/inMemoryBidApiWorld";

/** Stage 2F: bid management (listing, retrieval, filters, paging, audit visibility) exercised through the real routes. */
type World = Awaited<ReturnType<typeof createInMemoryBidApiWorld>>;
type RoleName = "Administrator" | "Procurement Broker" | "Supplier" | "Evaluation Committee";
type Bid = { bidId: string; supplierId: string; status: string; financialProposal?: number; supportingDocuments?: string[]; technicalProposal?: string };
interface Sent {
  status: number;
  headers: Headers;
  raw: string;
  body: { data: { bid: Bid; bids: Bid[]; limit: number; skip: number }; error: { code: string } };
}

const PASSWORD = "correct horse battery";
const BASE = `${APP_ORIGIN}/api/bids`;
let world: World;
let counter = 0;

beforeAll(async () => {
  world = await createInMemoryBidApiWorld();
});
afterAll(() => world.dispose());

function req(method: string, url: string, cookie?: string, body?: unknown): Request {
  const headers = new Headers({ Origin: APP_ORIGIN });
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function sent(response: Response): Promise<Sent> {
  const raw = await response.text();
  return { status: response.status, headers: response.headers, raw, body: JSON.parse(raw) };
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const list = async (cookie: string, query = "") => sent(await listRoute(req("GET", `${BASE}${query}`, cookie)));
const get = async (cookie: string, id: string) => sent(await getOneRoute(req("GET", `${BASE}/${id}`, cookie), idParams(id)));

async function loginAs(roleName: RoleName): Promise<{ cookie: string; userId: string }> {
  const email = `${roleName.replace(/\s+/g, "").toLowerCase()}${(counter += 1)}@example.com`;
  const role = (await world.roles.findByName(roleName))!;
  const user = await world.users.create(
    User.restore({ userId: generateId(), fullName: "T", email, passwordHash: await world.passwords.hash(PASSWORD), roleId: role.roleId, status: "Active", createdAt: new Date() }),
  );
  const response = await (await import("@/app/api/auth/login/route")).POST(req("POST", `${APP_ORIGIN}/api/auth/login`, undefined, { email, password: PASSWORD }));
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "", userId: user.userId };
}
async function supplier() {
  const s = await loginAs("Supplier");
  const profile = await world.suppliers.create(
    Supplier.register({ supplierId: `sup-${(counter += 1)}`, userId: s.userId, companyName: "Co", registrationNumber: `R-${counter}`, email: "c@c.example", phoneNumber: "+251 11 123 4567", address: "Bole", registrationDate: TENDER_NOW }),
  );
  return { ...s, supplierId: profile.supplierId };
}
async function tenderWithBids(brokerId: string, suppliers: number) {
  const tender = makeTender({ brokerId });
  tender.publish(TENDER_NOW);
  await world.tenders.create(tender);
  const bidders = [];
  for (let i = 0; i < suppliers; i += 1) {
    const s = await supplier();
    world.clock.now = new Date(TENDER_NOW.getTime() + (i + 1) * 60_000);
    const res = await sent(await submitRoute(req("POST", BASE, s.cookie, { tenderId: tender.tenderId, technicalProposal: `plan-${i}`, financialProposal: 1000 + i, supportingDocuments: [`doc-${i}`] })));
    expect(res.status).toBe(201);
    bidders.push({ ...s, bidId: res.body.data.bid.bidId });
  }
  world.clock.now = TENDER_NOW;
  return { tenderId: tender.tenderId, bidders };
}
async function setTenderStatus(tenderId: string, status: "Closed" | "Awarded") {
  const tender = (await world.tenders.findById(tenderId))!;
  if (tender.status === "Published") tender.close(TENDER_DEADLINE);
  await world.tenders.updateStatus(tenderId, "Closed");
  if (status === "Awarded") await world.tenders.updateStatus(tenderId, "Awarded");
}

describe("Stage 2F bid management: confidentiality by tender status", () => {
  it("Published: Administrator and owning Broker get 409 and no bid content, even after the deadline; Closed and Awarded unlock", async () => {
    const broker = await loginAs("Procurement Broker");
    const admin = await loginAs("Administrator");
    const { tenderId, bidders } = await tenderWithBids(broker.userId, 2);

    world.clock.now = new Date(TENDER_DEADLINE.getTime() + 86_400_000); // deadline passed, tender still Published
    for (const who of [admin, broker]) {
      const l = await list(who.cookie, `?tenderId=${tenderId}`);
      expect(l.status).toBe(409);
      expect(l.raw).not.toMatch(/plan-|1000|doc-/);
      expect((await get(who.cookie, bidders[0]!.bidId)).status).toBe(409);
    }
    world.clock.now = TENDER_NOW;

    await setTenderStatus(tenderId, "Closed");
    for (const who of [admin, broker]) expect((await list(who.cookie, `?tenderId=${tenderId}`)).body.data.bids).toHaveLength(2);
    await setTenderStatus(tenderId, "Awarded");
    for (const who of [admin, broker]) expect((await list(who.cookie, `?tenderId=${tenderId}`)).body.data.bids).toHaveLength(2);
  });

  it("a supplier can always read their own bid, but never sees another supplier's offer or documents", async () => {
    const { tenderId, bidders } = await tenderWithBids("broker-x", 2);
    const [a, b] = bidders;
    expect((await get(a!.cookie, a!.bidId)).body.data.bid.financialProposal).toBe(1000);
    const foreign = await get(a!.cookie, b!.bidId);
    expect(foreign.status).toBe(404);
    expect(foreign.raw).not.toMatch(/1001|doc-1|plan-1/);
    await setTenderStatus(tenderId, "Closed");
    const foreignAfterClose = await get(a!.cookie, b!.bidId);
    expect(foreignAfterClose.status).toBe(404);
    const own = await list(a!.cookie);
    expect(own.body.data.bids.map((x) => x.bidId)).toEqual([a!.bidId]);
    expect(own.raw).not.toMatch(/1001|doc-1/);
  });
});

describe("Stage 2F bid management: roles and ownership", () => {
  it("a broker sees only their own tender's bids; another broker gets 404 for list and get", async () => {
    const owner = await loginAs("Procurement Broker");
    const other = await loginAs("Procurement Broker");
    const { tenderId, bidders } = await tenderWithBids(owner.userId, 1);
    await setTenderStatus(tenderId, "Closed");
    expect((await list(owner.cookie, `?tenderId=${tenderId}`)).status).toBe(200);
    expect((await get(owner.cookie, bidders[0]!.bidId)).status).toBe(200);
    const l = await list(other.cookie, `?tenderId=${tenderId}`);
    expect(l.status).toBe(404);
    expect(l.raw).not.toMatch(/plan-|1000/);
    expect((await get(other.cookie, bidders[0]!.bidId)).status).toBe(404);
  });

  it("the Evaluation Committee is denied list and get, in every tender status", async () => {
    const committee = await loginAs("Evaluation Committee");
    const { tenderId, bidders } = await tenderWithBids("b", 1);
    for (const status of ["Published", "Closed", "Awarded"] as const) {
      if (status !== "Published") await setTenderStatus(tenderId, status);
      expect((await list(committee.cookie, `?tenderId=${tenderId}`)).status).toBe(403);
      expect((await get(committee.cookie, bidders[0]!.bidId)).status).toBe(403);
    }
  });

  it("anonymous callers get 401; client-supplied identity parameters are ignored and cannot widen access", async () => {
    const { tenderId, bidders } = await tenderWithBids("b", 2);
    expect((await list("", `?tenderId=${tenderId}`)).status).toBe(401);
    expect((await get("", bidders[0]!.bidId)).status).toBe(401);
    const a = bidders[0]!;
    const spoof = await list(a.cookie, `?supplierId=${bidders[1]!.supplierId}&userId=x&role=Administrator&brokerId=b`);
    expect(spoof.status).toBe(200);
    expect(spoof.body.data.bids.map((x) => x.bidId)).toEqual([a.bidId]);
  });

  it("responses are never cached", async () => {
    const { bidders } = await tenderWithBids("b", 1);
    const res = await get(bidders[0]!.cookie, bidders[0]!.bidId);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
});

describe("Stage 2F bid management: withdrawn bids (audit)", () => {
  it("are preserved, visible to the owning supplier at any time, and to authorized staff only after closure, marked Withdrawn", async () => {
    const broker = await loginAs("Procurement Broker");
    const admin = await loginAs("Administrator");
    const { tenderId, bidders } = await tenderWithBids(broker.userId, 2);
    const [a, b] = bidders;
    const withdrawn = await sent(await withdrawRoute(req("POST", `${BASE}/${a!.bidId}/withdraw`, a!.cookie), idParams(a!.bidId)));
    expect(withdrawn.status).toBe(200);

    expect((await get(a!.cookie, a!.bidId)).body.data.bid.status).toBe("Withdrawn");
    expect((await list(a!.cookie, "?status=Withdrawn")).body.data.bids).toHaveLength(1);
    expect((await get(admin.cookie, a!.bidId)).status).toBe(409); // still sealed

    await setTenderStatus(tenderId, "Closed");
    for (const who of [admin, broker]) {
      const all = await list(who.cookie, `?tenderId=${tenderId}`);
      expect(Object.fromEntries(all.body.data.bids.map((x) => [x.bidId, x.status]))).toEqual({ [a!.bidId]: "Withdrawn", [b!.bidId]: "Submitted" });
      expect((await list(who.cookie, `?tenderId=${tenderId}&status=Withdrawn`)).body.data.bids.map((x) => x.bidId)).toEqual([a!.bidId]);
      expect((await get(who.cookie, a!.bidId)).body.data.bid.status).toBe("Withdrawn");
    }
    const stored = await world.bids.findById(a!.bidId);
    expect(stored?.status).toBe("Withdrawn");
    expect(stored?.isEligibleForEvaluation()).toBe(false);
    expect((await world.bids.findById(b!.bidId))?.isEligibleForEvaluation()).toBe(true);
  });

  it("a withdrawn bid cannot be resubmitted and no delete operation exists for bids", async () => {
    const { tenderId, bidders } = await tenderWithBids("b", 1);
    const a = bidders[0]!;
    await withdrawRoute(req("POST", `${BASE}/${a.bidId}/withdraw`, a.cookie), idParams(a.bidId));
    const again = await sent(await submitRoute(req("POST", BASE, a.cookie, { tenderId, technicalProposal: "x", financialProposal: 1 })));
    expect(again.status).toBe(409);
    expect(await world.bids.findById(a.bidId)).not.toBeNull();
    expect("delete" in world.bids).toBe(false);
  });
});

describe("Stage 2F bid management: filters, pagination, malformed requests", () => {
  it("pages a tender's bids newest first with limit and skip, and echoes them", async () => {
    const admin = await loginAs("Administrator");
    const { tenderId, bidders } = await tenderWithBids("b", 5);
    await setTenderStatus(tenderId, "Closed");
    const newestFirst = [...bidders].reverse().map((x) => x.bidId);
    const p1 = await list(admin.cookie, `?tenderId=${tenderId}&limit=2`);
    const p2 = await list(admin.cookie, `?tenderId=${tenderId}&limit=2&skip=2`);
    const p3 = await list(admin.cookie, `?tenderId=${tenderId}&limit=2&skip=4`);
    expect(p1.body.data.bids.map((x) => x.bidId)).toEqual(newestFirst.slice(0, 2));
    expect(p2.body.data.bids.map((x) => x.bidId)).toEqual(newestFirst.slice(2, 4));
    expect(p3.body.data.bids.map((x) => x.bidId)).toEqual(newestFirst.slice(4));
    expect(p2.body.data).toMatchObject({ limit: 2, skip: 2 });
  });

  it("filters by one or several statuses", async () => {
    const admin = await loginAs("Administrator");
    const { tenderId, bidders } = await tenderWithBids("b", 3);
    await withdrawRoute(req("POST", `${BASE}/${bidders[0]!.bidId}/withdraw`, bidders[0]!.cookie), idParams(bidders[0]!.bidId));
    await setTenderStatus(tenderId, "Closed");
    expect((await list(admin.cookie, `?tenderId=${tenderId}&status=Submitted`)).body.data.bids).toHaveLength(2);
    expect((await list(admin.cookie, `?tenderId=${tenderId}&status=Submitted&status=Withdrawn`)).body.data.bids).toHaveLength(3);
    expect((await list(admin.cookie, `?tenderId=${tenderId}&status=Accepted`)).body.data.bids).toEqual([]);
  });

  it("rejects malformed queries, ids and unknown tenders safely", async () => {
    const admin = await loginAs("Administrator");
    for (const q of ["?limit=0", "?limit=501", "?limit=1.5", "?skip=-1", "?skip=abc", "?status=Bogus", "?tenderId=a%20b", `?tenderId=${"x".repeat(101)}`]) {
      expect((await list(admin.cookie, q)).status).toBe(400);
    }
    expect((await list(admin.cookie)).status).toBe(400); // staff must name a tender
    const unknown = await list(admin.cookie, "?tenderId=no-such-tender");
    expect(unknown.status).toBe(404);
    expect((await get(admin.cookie, "no-such-bid")).status).toBe(404);
    expect((await get(admin.cookie, "bad%20id")).status).toBeGreaterThanOrEqual(400);
    expect(unknown.raw).not.toMatch(/stack|mongodb/i);
  });

  it("Stage 2E behavior is intact: a supplier still cannot read bids of others and non-suppliers still cannot submit", async () => {
    const { tenderId } = await tenderWithBids("b", 1);
    const admin = await loginAs("Administrator");
    const denied = await sent(await submitRoute(req("POST", BASE, admin.cookie, { tenderId, technicalProposal: "x", financialProposal: 1 })));
    expect(denied.status).toBe(403);
  });
});
