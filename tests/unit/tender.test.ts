import { describe, expect, it } from "vitest";
import {
  DeadlineExpiredException,
  InvalidTenderDataException,
  InvalidTenderStatusException,
  TenderDeadlineNotReachedException,
} from "@/entities/exceptions";
import { getPermissionsForRole, ROLE_PERMISSION_MATRIX } from "@/entities/RolePermissionMatrix";
import {
  DELETABLE_TENDER_STATUSES,
  EDITABLE_TENDER_STATUSES,
  Tender,
  TENDER_LIST_MAX_ITEMS,
  TENDER_STATUSES,
  TENDER_STATUS_TRANSITIONS,
  TENDER_TITLE_MAX_LENGTH,
  normalizeTenderQuery,
  type TenderStatus,
} from "@/entities/Tender";
import { catchError, makeTender, TENDER_DEADLINE, TENDER_NOW } from "../support/fixtures";

const day = (n: number) => new Date(TENDER_NOW.getTime() + n * 24 * 60 * 60 * 1000);
const issuesOf = (action: () => unknown) => (catchError(action) as InvalidTenderDataException).issues;

/** A tender in the given status, built only through its own operations. */
function tenderIn(status: TenderStatus): Tender {
  const tender = makeTender();
  if (status === "Draft") return tender;
  if (status === "Cancelled") {
    tender.cancel();
    return tender;
  }
  tender.publish(TENDER_NOW);
  if (status === "Published") return tender;
  tender.close(TENDER_DEADLINE);
  if (status === "Closed") return tender;
  // No operation awards a tender yet; a stored Awarded tender is rebuilt with restore().
  return Tender.restore({
    tenderId: "awarded-1",
    title: "Awarded tender",
    description: "d",
    category: "Goods",
    estimatedBudget: 1,
    requirements: ["r"],
    evaluationCriteria: ["c"],
    publicationDate: TENDER_NOW,
    submissionDeadline: TENDER_DEADLINE,
    status: "Awarded",
    brokerId: "broker-1",
    createdAt: TENDER_NOW,
  });
}

describe("Tender.create (ODD createTender)", () => {
  it("builds a Draft tender with the ODD attributes and no publication date", () => {
    const tender = makeTender();

    expect(tender).toMatchObject({
      title: "Supply of office furniture",
      category: "Goods",
      estimatedBudget: 250000,
      requirements: ["Valid trade licence", "Two years of similar supply experience"],
      evaluationCriteria: ["Technical compliance", "Price"],
      status: "Draft",
      brokerId: "broker-1",
    });
    expect(tender.publicationDate).toBeNull();
    expect(tender.submissionDeadline).toEqual(TENDER_DEADLINE);
    expect(tender.createdAt).toEqual(TENDER_NOW);
    expect(tender.toJSON().publicationDate).toBeNull();
  });

  it("allows a Draft without requirements and criteria (they are needed only to publish)", () => {
    const tender = makeTender({ requirements: undefined, evaluationCriteria: undefined });
    expect(tender.requirements).toEqual([]);
    expect(tender.evaluationCriteria).toEqual([]);
  });

  it("trims text and cleans list items", () => {
    const tender = makeTender({ title: "  Roads  ", category: " Works ", requirements: ["  A  ", "B"] });
    expect(tender.title).toBe("Roads");
    expect(tender.category).toBe("Works");
    expect(tender.requirements).toEqual(["A", "B"]);
  });

  it("reports every problem at once with InvalidTenderDataException", () => {
    const issues = issuesOf(() =>
      makeTender({
        tenderId: "has space",
        brokerId: "",
        title: "   ",
        description: "",
        category: "",
        estimatedBudget: 0,
        submissionDeadline: new Date("nope"),
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tenderId"),
        expect.stringContaining("brokerId"),
        expect.stringContaining("title"),
        expect.stringContaining("description"),
        expect.stringContaining("category"),
        expect.stringContaining("estimatedBudget"),
        expect.stringContaining("submissionDeadline"),
      ]),
    );
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, "100" as unknown as number, null as unknown as number])(
    "rejects the budget %s",
    (budget) => {
      expect(issuesOf(() => makeTender({ estimatedBudget: budget }))).toEqual([expect.stringContaining("estimatedBudget")]);
    },
  );

  it("requires a deadline in the future", () => {
    expect(issuesOf(() => makeTender({ submissionDeadline: TENDER_NOW }))).toEqual(["submissionDeadline must be in the future"]);
    expect(issuesOf(() => makeTender({ submissionDeadline: day(-1) }))).toEqual(["submissionDeadline must be in the future"]);
  });

  it("rejects too long text and bad lists", () => {
    expect(issuesOf(() => makeTender({ title: "x".repeat(TENDER_TITLE_MAX_LENGTH + 1) }))).toEqual([expect.stringContaining("title")]);
    expect(issuesOf(() => makeTender({ requirements: ["Same", "same"] }))).toEqual([expect.stringContaining("requirements")]);
    expect(issuesOf(() => makeTender({ requirements: ["ok", " "] }))).toEqual([expect.stringContaining("requirements")]);
    expect(issuesOf(() => makeTender({ requirements: [1] as never }))).toEqual([expect.stringContaining("requirements")]);
    expect(issuesOf(() => makeTender({ evaluationCriteria: "Price" as never }))).toEqual([expect.stringContaining("evaluationCriteria")]);
    const tooMany = Array.from({ length: TENDER_LIST_MAX_ITEMS + 1 }, (_, i) => `item ${i}`);
    expect(issuesOf(() => makeTender({ evaluationCriteria: tooMany }))).toEqual([expect.stringContaining("at most")]);
  });

  it("does not share its lists or dates with the caller", () => {
    const requirements = ["A"];
    const deadline = new Date(TENDER_DEADLINE);
    const tender = makeTender({ requirements, submissionDeadline: deadline });
    requirements.push("B");
    deadline.setFullYear(2040);
    tender.requirements.push("C");
    tender.submissionDeadline.setFullYear(2041);

    expect(tender.requirements).toEqual(["A"]);
    expect(tender.submissionDeadline).toEqual(TENDER_DEADLINE);
  });
});

describe("Tender.restore (loading stored data)", () => {
  const stored = (changes: object = {}) => ({
    ...makeTender().toJSON(),
    publicationDate: null as Date | null,
    submissionDeadline: TENDER_DEADLINE,
    createdAt: TENDER_NOW,
    ...changes,
  });

  it("accepts a tender whose deadline is already in the past", () => {
    const old = Tender.restore(stored({ submissionDeadline: new Date("2001-01-01T00:00:00Z") }));
    expect(old.status).toBe("Draft");
  });

  it("requires consistency between status and publication date", () => {
    expect(issuesOf(() => Tender.restore(stored({ publicationDate: TENDER_NOW })))).toEqual([expect.stringContaining("Draft")]);
    for (const status of ["Published", "Closed", "Awarded"]) {
      expect(issuesOf(() => Tender.restore(stored({ status })))).toEqual([expect.stringContaining("publicationDate")]);
    }
    expect(Tender.restore(stored({ status: "Cancelled" })).publicationDate).toBeNull();
    expect(Tender.restore(stored({ status: "Cancelled", publicationDate: TENDER_NOW })).publicationDate).toEqual(TENDER_NOW);
  });

  it("rejects an unknown status and a missing createdAt", () => {
    expect(issuesOf(() => Tender.restore(stored({ status: "Archived" })))).toEqual([expect.stringContaining("status")]);
    expect(issuesOf(() => Tender.restore(stored({ createdAt: undefined })))).toEqual([expect.stringContaining("createdAt")]);
  });
});

describe("status model", () => {
  it("has exactly the ODD statuses", () => {
    expect([...TENDER_STATUSES]).toEqual(["Draft", "Published", "Closed", "Awarded", "Cancelled"]);
  });

  it("allows the documented transitions only; Awarded and Cancelled are final", () => {
    expect(TENDER_STATUS_TRANSITIONS).toEqual({
      Draft: ["Published", "Cancelled"],
      Published: ["Closed", "Cancelled"],
      Closed: ["Awarded"],
      Awarded: [],
      Cancelled: [],
    });
    expect(tenderIn("Draft").canTransitionTo("Published")).toBe(true);
    expect(tenderIn("Draft").canTransitionTo("Closed")).toBe(false);
    expect(tenderIn("Closed").canTransitionTo("Cancelled")).toBe(false);
    expect(tenderIn("Cancelled").canTransitionTo("Published")).toBe(false);
    expect(tenderIn("Published").canTransitionTo("Published")).toBe(true); // staying put is a no-op
  });

  it("only Draft and Published tenders are editable; only a Draft can be deleted", () => {
    expect([...EDITABLE_TENDER_STATUSES]).toEqual(["Draft", "Published"]);
    expect([...DELETABLE_TENDER_STATUSES]).toEqual(["Draft"]);
    expect(() => tenderIn("Draft").assertDeletable()).not.toThrow();
    for (const status of ["Published", "Closed", "Awarded", "Cancelled"] as const) {
      expect(catchError(() => tenderIn(status).assertDeletable())).toBeInstanceOf(InvalidTenderStatusException);
    }
  });
});

describe("Tender.publish (ODD publish)", () => {
  it("publishes a complete Draft and records the publication date", () => {
    const tender = makeTender();
    tender.publish(TENDER_NOW);
    expect(tender.status).toBe("Published");
    expect(tender.publicationDate).toEqual(TENDER_NOW);
  });

  it("refuses an incomplete Draft and stays a Draft", () => {
    const noRequirements = makeTender({ requirements: [] });
    expect((catchError(() => noRequirements.publish(TENDER_NOW)) as InvalidTenderDataException).issues).toEqual([
      expect.stringContaining("requirement"),
    ]);
    const nothing = makeTender({ requirements: [], evaluationCriteria: [] });
    expect((catchError(() => nothing.publish(TENDER_NOW)) as InvalidTenderDataException).issues).toHaveLength(2);
    expect(nothing.status).toBe("Draft");
    expect(nothing.publicationDate).toBeNull();
  });

  it("refuses to publish once the deadline has passed (DeadlineExpiredException)", () => {
    const tender = makeTender();
    expect(catchError(() => tender.publish(TENDER_DEADLINE))).toBeInstanceOf(DeadlineExpiredException);
    expect(catchError(() => tender.publish(day(90)))).toBeInstanceOf(DeadlineExpiredException);
    expect(tender.status).toBe("Draft");
  });

  it.each(["Published", "Closed", "Awarded", "Cancelled"] as const)("refuses a %s tender", (status) => {
    expect(catchError(() => tenderIn(status).publish(TENDER_NOW))).toBeInstanceOf(InvalidTenderStatusException);
  });
});

describe("Tender.close (ODD close)", () => {
  it("closes a Published tender once the deadline is reached", () => {
    const tender = tenderIn("Published");
    tender.close(TENDER_DEADLINE);
    expect(tender.status).toBe("Closed");
  });

  it("closes after the deadline as well", () => {
    const tender = tenderIn("Published");
    tender.close(day(90));
    expect(tender.status).toBe("Closed");
  });

  it("refuses to close early unless early closure is explicitly authorized", () => {
    const tender = tenderIn("Published");
    expect(catchError(() => tender.close(day(1)))).toBeInstanceOf(TenderDeadlineNotReachedException);
    expect(catchError(() => tender.close(day(1), { early: false }))).toBeInstanceOf(TenderDeadlineNotReachedException);
    expect(tender.status).toBe("Published");

    tender.close(day(1), { early: true });
    expect(tender.status).toBe("Closed");
  });

  it.each(["Draft", "Closed", "Awarded", "Cancelled"] as const)("refuses a %s tender", (status) => {
    expect(catchError(() => tenderIn(status).close(day(90), { early: true }))).toBeInstanceOf(InvalidTenderStatusException);
  });
});

describe("Tender.cancel (ODD cancel)", () => {
  it.each(["Draft", "Published"] as const)("cancels a %s tender", (status) => {
    const tender = tenderIn(status);
    tender.cancel();
    expect(tender.status).toBe("Cancelled");
  });

  it.each(["Closed", "Awarded", "Cancelled"] as const)("refuses a %s tender", (status) => {
    const tender = tenderIn(status);
    expect(catchError(() => tender.cancel())).toBeInstanceOf(InvalidTenderStatusException);
    expect(tender.status).toBe(status);
  });

  it("keeps the publication date of a cancelled published tender", () => {
    const tender = tenderIn("Published");
    tender.cancel();
    expect(tender.publicationDate).toEqual(TENDER_NOW);
  });
});

describe("Tender.isOpenForSubmissions", () => {
  it("is true only while Published and before the deadline", () => {
    const published = tenderIn("Published");
    expect(published.isOpenForSubmissions(day(1))).toBe(true);
    expect(published.isOpenForSubmissions(TENDER_DEADLINE)).toBe(false);
    expect(published.isOpenForSubmissions(day(90))).toBe(false);
    for (const status of ["Draft", "Closed", "Awarded", "Cancelled"] as const) {
      expect(tenderIn(status).isOpenForSubmissions(day(1))).toBe(false);
    }
  });
});

describe("Tender.updateTender (ODD updateTender)", () => {
  it("changes the given fields of a Draft", () => {
    const tender = makeTender();
    tender.updateTender(
      { title: "  New title ", description: "New", category: "Works", estimatedBudget: 10, requirements: ["R"], evaluationCriteria: ["C"], submissionDeadline: day(60) },
      day(1),
    );
    expect(tender).toMatchObject({ title: "New title", description: "New", category: "Works", estimatedBudget: 10, requirements: ["R"], evaluationCriteria: ["C"] });
    expect(tender.submissionDeadline).toEqual(day(60));
    expect(tender.status).toBe("Draft");
  });

  it("changes only what is given", () => {
    const tender = makeTender();
    tender.updateTender({ category: "Works" }, day(1));
    expect(tender.title).toBe("Supply of office furniture");
    expect(tender.requirements).toHaveLength(2);
  });

  it("updates a Published tender before its deadline and keeps it Published", () => {
    const tender = tenderIn("Published");
    tender.updateTender({ estimatedBudget: 300000 }, day(5));
    expect(tender.estimatedBudget).toBe(300000);
    expect(tender.status).toBe("Published");
    expect(tender.publicationDate).toEqual(TENDER_NOW);
  });

  it("refuses to update a Published tender once its deadline has passed", () => {
    const tender = tenderIn("Published");
    expect(catchError(() => tender.updateTender({ title: "Late" }, TENDER_DEADLINE))).toBeInstanceOf(DeadlineExpiredException);
    expect(catchError(() => tender.updateTender({ title: "Late" }, day(90)))).toBeInstanceOf(DeadlineExpiredException);
    expect(tender.title).toBe("Supply of office furniture");
  });

  it("lets a Draft whose deadline has passed be fixed, but only with a future deadline", () => {
    const tender = makeTender();
    tender.updateTender({ title: "Still draft" }, day(90));
    expect(tender.title).toBe("Still draft");
    expect(issuesOf(() => tender.updateTender({ submissionDeadline: day(10) }, day(90)))).toEqual(["submissionDeadline must be in the future"]);
    tender.updateTender({ submissionDeadline: day(100) }, day(90));
    expect(tender.submissionDeadline).toEqual(day(100));
  });

  it.each(["Closed", "Awarded", "Cancelled"] as const)("refuses to update a %s tender", (status) => {
    expect(catchError(() => tenderIn(status).updateTender({ title: "Nope" }, day(1)))).toBeInstanceOf(InvalidTenderStatusException);
  });

  it("changes nothing when any value is invalid", () => {
    const tender = makeTender();
    const before = tender.toJSON();
    const issues = issuesOf(() => tender.updateTender({ title: "Fine", estimatedBudget: -1, requirements: ["x", "X"] }, day(1)));
    expect(issues).toHaveLength(2);
    expect(tender.toJSON()).toEqual(before);
  });

  it("requires at least one field and refuses fields that cannot change", () => {
    const tender = makeTender();
    expect(issuesOf(() => tender.updateTender({}, day(1)))).toEqual(["at least one field to update is required"]);
    expect(issuesOf(() => tender.updateTender({ status: "Published", brokerId: "x", tenderId: "y" } as never, day(1)))).toEqual([
      "status cannot be changed",
      "brokerId cannot be changed",
      "tenderId cannot be changed",
    ]);
  });

  it("keeps a Published tender complete: it cannot lose all requirements or criteria", () => {
    const tender = tenderIn("Published");
    expect(issuesOf(() => tender.updateTender({ requirements: [] }, day(1)))).toEqual([expect.stringContaining("requirement")]);
    expect(issuesOf(() => tender.updateTender({ evaluationCriteria: [] }, day(1)))).toEqual([expect.stringContaining("criterion")]);
    expect(tender.requirements).toHaveLength(2);
    // ...whereas a Draft may be emptied while it is being prepared.
    const draft = makeTender();
    draft.updateTender({ requirements: [] }, day(1));
    expect(draft.requirements).toEqual([]);
  });
});

describe("Tender.addRequirement and setEvaluationCriteria", () => {
  it("adds a requirement to a Draft and a Published tender", () => {
    const draft = makeTender();
    draft.addRequirement("  ISO 9001 certificate ", day(1));
    expect(draft.requirements.at(-1)).toBe("ISO 9001 certificate");

    const published = tenderIn("Published");
    published.addRequirement("Local office", day(1));
    expect(published.requirements).toHaveLength(3);
  });

  it("refuses an empty or duplicate requirement and changes nothing", () => {
    const tender = makeTender();
    expect(catchError(() => tender.addRequirement("  ", day(1)))).toBeInstanceOf(InvalidTenderDataException);
    expect(catchError(() => tender.addRequirement("valid TRADE licence", day(1)))).toBeInstanceOf(InvalidTenderDataException);
    expect(tender.requirements).toHaveLength(2);
  });

  it("refuses to add a requirement outside the editable window", () => {
    expect(catchError(() => tenderIn("Closed").addRequirement("x", day(1)))).toBeInstanceOf(InvalidTenderStatusException);
    expect(catchError(() => tenderIn("Cancelled").addRequirement("x", day(1)))).toBeInstanceOf(InvalidTenderStatusException);
    expect(catchError(() => tenderIn("Published").addRequirement("x", day(90)))).toBeInstanceOf(DeadlineExpiredException);
  });

  it("replaces the evaluation criteria", () => {
    const tender = makeTender();
    tender.setEvaluationCriteria(["Quality", "Delivery time", "Price"], day(1));
    expect(tender.evaluationCriteria).toEqual(["Quality", "Delivery time", "Price"]);
  });

  it("refuses bad criteria, an empty list on a Published tender, and a closed tender", () => {
    const tender = makeTender();
    expect(catchError(() => tender.setEvaluationCriteria(["A", "a"], day(1)))).toBeInstanceOf(InvalidTenderDataException);
    expect(tender.evaluationCriteria).toEqual(["Technical compliance", "Price"]);
    tender.setEvaluationCriteria([], day(1)); // allowed while Draft

    const published = tenderIn("Published");
    expect(catchError(() => published.setEvaluationCriteria([], day(1)))).toBeInstanceOf(InvalidTenderDataException);
    expect(catchError(() => tenderIn("Closed").setEvaluationCriteria(["A"], day(1)))).toBeInstanceOf(InvalidTenderStatusException);
    expect(catchError(() => published.setEvaluationCriteria(["A"], day(90)))).toBeInstanceOf(DeadlineExpiredException);
  });
});

describe("normalizeTenderQuery", () => {
  it("applies the defaults", () => {
    expect(normalizeTenderQuery()).toEqual({ statuses: null, brokerId: null, category: null, limit: 100, skip: 0 });
  });

  it("accepts one status or several, removes repeats and trims text filters", () => {
    expect(normalizeTenderQuery({ status: "Draft" }).statuses).toEqual(["Draft"]);
    expect(normalizeTenderQuery({ status: ["Draft", "Draft", "Closed"] }).statuses).toEqual(["Draft", "Closed"]);
    expect(normalizeTenderQuery({ brokerId: " b-1 ", category: " Goods " })).toMatchObject({ brokerId: "b-1", category: "Goods" });
  });

  it("rejects bad filters with InvalidTenderDataException", () => {
    for (const input of [{ status: "Archived" }, { status: [] }, { limit: 0 }, { limit: 501 }, { skip: -1 }, { skip: 1.2 }, { brokerId: "" }]) {
      expect(catchError(() => normalizeTenderQuery(input as never))).toBeInstanceOf(InvalidTenderDataException);
    }
  });
});

describe("tender permissions of the approved matrix (nothing here enforces them yet)", () => {
  it("Administrators and Brokers hold create, update, publish and read for tenders", () => {
    for (const role of ["Administrator", "Procurement Broker"] as const) {
      expect(getPermissionsForRole(role)).toEqual(expect.arrayContaining(["tender:create", "tender:update", "tender:publish", "tender:read"]));
    }
  });

  it("Suppliers and Committee members cannot create, update or publish tenders; they may only read (restricted)", () => {
    for (const role of ["Supplier", "Evaluation Committee"] as const) {
      const held = getPermissionsForRole(role);
      for (const permission of ["tender:create", "tender:update", "tender:publish"]) expect(held).not.toContain(permission);
      expect(ROLE_PERMISSION_MATRIX["tender:read"][role]).toBe("restricted");
    }
  });

  it("no award permission exists and no tender operation awards a tender", () => {
    expect(Object.keys(ROLE_PERMISSION_MATRIX).filter((permission) => permission.startsWith("award"))).toEqual([]);
    const operations = Object.getOwnPropertyNames(Tender.prototype);
    expect(operations.filter((name) => /award/i.test(name))).toEqual([]);
  });
});
