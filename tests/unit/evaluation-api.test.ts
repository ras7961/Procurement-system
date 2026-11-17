import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getOneRoute } from "@/app/api/evaluations/[id]/route";
import { GET as listRoute } from "@/app/api/evaluations/route";
import { Evaluation } from "@/entities/Evaluation";
import { User } from "@/entities/User";
import { generateId } from "@/shared/utilities/uuid";
import { makeBid, makeTender, TENDER_DEADLINE, TENDER_NOW } from "../support/fixtures";
import { APP_ORIGIN, createInMemoryEvaluationApiWorld } from "../support/inMemoryEvaluationApiWorld";

type World = Awaited<ReturnType<typeof createInMemoryEvaluationApiWorld>>;
type RoleName = "Administrator" | "Procurement Broker" | "Supplier" | "Evaluation Committee";
interface Sent {
  status: number;
  headers: Headers;
  raw: string;
  body: { data: { evaluation: { evaluationId: string; comments: string }; evaluations: Array<{ evaluationId: string }>; limit: number; skip: number }; error: { code: string } };
}

const PASSWORD = "correct horse battery";
const BASE = `${APP_ORIGIN}/api/evaluations`;
let world: World;
let counter = 0;

beforeAll(async () => {
  world = await createInMemoryEvaluationApiWorld();
});
afterAll(() => world.dispose());

const mk = (method: string, url: string, cookie?: string, extra: Record<string, string> = {}) => new Request(url, { method, headers: { Origin: APP_ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...extra } });
async function sent(response: Response): Promise<Sent> {
  const raw = await response.text();
  return { status: response.status, headers: response.headers, raw, body: JSON.parse(raw) };
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const list = async (cookie: string, query: string) => sent(await listRoute(mk("GET", `${BASE}${query}`, cookie)));
const get = async (cookie: string, id: string) => sent(await getOneRoute(mk("GET", `${BASE}/${id}`, cookie), idParams(id)));

async function loginAs(roleName: RoleName): Promise<{ cookie: string; userId: string }> {
  const email = `${roleName.replace(/\s+/g, "").toLowerCase()}${(counter += 1)}@example.com`;
  const role = (await world.roles.findByName(roleName))!;
  const user = await world.users.create(
    User.restore({ userId: generateId(), fullName: "T", email, passwordHash: await world.passwords.hash(PASSWORD), roleId: role.roleId, status: "Active", createdAt: new Date() }),
  );
  const response = await (await import("@/app/api/auth/login/route")).POST(
    new Request(`${APP_ORIGIN}/api/auth/login`, { method: "POST", headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) }),
  );
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "", userId: user.userId };
}
async function tenderWithEvaluation(brokerId: string, status: "Published" | "Closed" | "Awarded" = "Closed") {
  const tender = makeTender({ brokerId });
  tender.publish(TENDER_NOW);
  await world.tenders.create(tender);
  const evaluation = Evaluation.create({ evaluationId: generateId(), bid: makeBid({ tenderId: tender.tenderId }), evaluatorId: "committee-1", now: TENDER_NOW });
  evaluation.addComments("secret committee remark");
  await world.evaluations.create(evaluation);
  if (status !== "Published") {
    tender.close(TENDER_DEADLINE);
    await world.tenders.updateStatus(tender.tenderId, "Closed");
    if (status === "Awarded") await world.tenders.updateStatus(tender.tenderId, "Awarded");
  }
  return { tenderId: tender.tenderId, evaluationId: evaluation.evaluationId };
}

describe("evaluation read endpoints", () => {
  it("Administrator and the owning Broker read evaluations of a Closed or Awarded tender; responses are no-store", async () => {
    const broker = await loginAs("Procurement Broker");
    const admin = await loginAs("Administrator");
    for (const status of ["Closed", "Awarded"] as const) {
      const { tenderId, evaluationId } = await tenderWithEvaluation(broker.userId, status);
      for (const who of [admin, broker]) {
        const l = await list(who.cookie, `?tenderId=${tenderId}`);
        expect(l.status).toBe(200);
        expect(l.body.data.evaluations.map((e) => e.evaluationId)).toEqual([evaluationId]);
        expect(l.headers.get("cache-control")).toMatch(/no-store/);
        expect((await get(who.cookie, evaluationId)).body.data.evaluation.evaluationId).toBe(evaluationId);
      }
    }
  });

  it("sealed while the tender is Published: 409 and no evaluation content", async () => {
    const admin = await loginAs("Administrator");
    const { tenderId, evaluationId } = await tenderWithEvaluation("b", "Published");
    const l = await list(admin.cookie, `?tenderId=${tenderId}`);
    const g = await get(admin.cookie, evaluationId);
    expect([l.status, g.status]).toEqual([409, 409]);
    expect(l.raw + g.raw).not.toContain("secret committee remark");
  });

  it("another Broker gets 404; Supplier and Evaluation Committee get 403; anonymous gets 401", async () => {
    const owner = await loginAs("Procurement Broker");
    const { tenderId, evaluationId } = await tenderWithEvaluation(owner.userId);
    const other = await loginAs("Procurement Broker");
    expect([(await list(other.cookie, `?tenderId=${tenderId}`)).status, (await get(other.cookie, evaluationId)).status]).toEqual([404, 404]);
    for (const role of ["Supplier", "Evaluation Committee"] as const) {
      const { cookie } = await loginAs(role);
      const l = await list(cookie, `?tenderId=${tenderId}`);
      expect([l.status, (await get(cookie, evaluationId)).status]).toEqual([403, 403]);
      expect(l.raw).not.toContain("secret committee remark");
    }
    expect([(await list("", `?tenderId=${tenderId}`)).status, (await get("", evaluationId)).status]).toEqual([401, 401]);
  });

  it("validates input and hides internals", async () => {
    const admin = await loginAs("Administrator");
    for (const q of ["", "?limit=1", "?tenderId=a%20b", "?tenderId=t&limit=0", "?tenderId=t&limit=501", "?tenderId=t&skip=-1", "?tenderId=t&skip=x"]) {
      expect((await list(admin.cookie, q)).status).toBe(400);
    }
    expect((await list(admin.cookie, "?tenderId=missing")).status).toBe(404);
    expect((await get(admin.cookie, "missing")).status).toBe(404);
  });

  it("pages with limit and skip, ignoring client identity parameters", async () => {
    const admin = await loginAs("Administrator");
    const { tenderId } = await tenderWithEvaluation("b");
    const l = await list(admin.cookie, `?tenderId=${tenderId}&limit=1&skip=0&evaluatorId=x&role=Supplier`);
    expect(l.status).toBe(200);
    expect(l.body.data).toMatchObject({ limit: 1, skip: 0 });
  });

  it("exposes no write endpoints: scores cannot be set by anyone over HTTP", async () => {
    const broker = await loginAs("Procurement Broker");
    const { tenderId } = await tenderWithEvaluation(broker.userId);
    const listModule = (await import("@/app/api/evaluations/route")) as Record<string, unknown>;
    const idModule = (await import("@/app/api/evaluations/[id]/route")) as Record<string, unknown>;
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(listModule[m]).toBeUndefined();
      expect(idModule[m]).toBeUndefined();
    }
    expect(tenderId).toBeTruthy();
  });
});
