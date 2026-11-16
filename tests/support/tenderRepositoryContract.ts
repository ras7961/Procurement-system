import { beforeEach, describe, expect, it } from "vitest";
import {
  InvalidTenderDataException,
  InvalidTenderStatusException,
  TenderNotFoundException,
  TenderRepositoryException,
} from "@/entities/exceptions";
import type { TenderStatus } from "@/entities/Tender";
import type { TenderRepositoryInterface } from "@/interfaces/repositories/TenderRepositoryInterface";
import { catchAsyncError, makeTender, TENDER_DEADLINE, TENDER_NOW } from "./fixtures";

const day = (n: number) => new Date(TENDER_NOW.getTime() + n * 24 * 60 * 60 * 1000);

/** Behaviour every TenderRepositoryInterface implementation must have. */
export function runTenderRepositoryContract(name: string, createRepository: () => Promise<TenderRepositoryInterface> | TenderRepositoryInterface) {
  describe(`TenderRepositoryInterface contract: ${name}`, () => {
    let repository: TenderRepositoryInterface;

    beforeEach(async () => {
      repository = await createRepository();
    });

    /** Stores a tender and moves it to `status` through the repository's own status changes. */
    async function store(overrides: Parameters<typeof makeTender>[0] = {}, status: TenderStatus = "Draft") {
      const tender = await repository.create(makeTender(overrides));
      const id = tender.tenderId;
      if (status === "Draft") return tender;
      if (status === "Cancelled") return repository.updateStatus(id, "Cancelled");
      await repository.updateStatus(id, "Published", { publicationDate: TENDER_NOW });
      if (status === "Published") return (await repository.findById(id))!;
      await repository.updateStatus(id, "Closed");
      if (status === "Closed") return (await repository.findById(id))!;
      return repository.updateStatus(id, "Awarded");
    }

    describe("create and findById", () => {
      it("stores a tender that findById() returns with every field", async () => {
        const tender = makeTender();
        await repository.create(tender);

        expect((await repository.findById(tender.tenderId))?.toJSON()).toEqual(tender.toJSON());
        expect((await repository.findById(tender.tenderId))?.publicationDate).toBeNull();
      });

      it("findById() returns null when nothing matches", async () => {
        expect(await repository.findById("missing")).toBeNull();
      });

      it("create() rejects an existing tenderId with TenderRepositoryException", async () => {
        const tender = makeTender();
        await repository.create(tender);
        expect(await catchAsyncError(() => repository.create(tender))).toBeInstanceOf(TenderRepositoryException);
      });

      it("returns new instances: changing one does not change stored data", async () => {
        const stored = await repository.create(makeTender());
        stored.updateTender({ title: "Changed locally" }, TENDER_NOW);
        expect((await repository.findById(stored.tenderId))?.title).toBe("Supply of office furniture");
      });

      it("keeps the budget, lists and dates exactly", async () => {
        const tender = makeTender({ estimatedBudget: 1234567.89, requirements: ["B", "A"], evaluationCriteria: ["Z"] });
        const stored = await repository.create(tender);
        expect(stored.estimatedBudget).toBe(1234567.89);
        expect(stored.requirements).toEqual(["B", "A"]);
        expect(stored.submissionDeadline.getTime()).toBe(TENDER_DEADLINE.getTime());
      });
    });

    describe("update", () => {
      it("changes the given fields and nothing else", async () => {
        const original = await store();
        const updated = await repository.update(original.tenderId, {
          title: "New title",
          estimatedBudget: 99,
          requirements: ["Only one"],
          submissionDeadline: day(60),
        });

        expect(updated.title).toBe("New title");
        expect(updated.estimatedBudget).toBe(99);
        expect(updated.requirements).toEqual(["Only one"]);
        expect(updated.submissionDeadline.getTime()).toBe(day(60).getTime());
        expect(updated.description).toBe(original.description);
        expect(updated.category).toBe(original.category);
        expect(updated.evaluationCriteria).toEqual(original.evaluationCriteria);
        expect(updated.tenderId).toBe(original.tenderId);
        expect(updated.brokerId).toBe(original.brokerId);
        expect(updated.status).toBe("Draft");
        expect(updated.createdAt.getTime()).toBe(original.createdAt.getTime());
        expect((await repository.findById(original.tenderId))?.toJSON()).toEqual(updated.toJSON());
      });

      it("also works for a Published tender and keeps its publication date", async () => {
        const published = await store({}, "Published");
        const updated = await repository.update(published.tenderId, { category: "Works" });
        expect(updated.category).toBe("Works");
        expect(updated.status).toBe("Published");
        expect(updated.publicationDate?.getTime()).toBe(TENDER_NOW.getTime());
      });

      it("an update without fields changes nothing", async () => {
        const original = await store();
        expect((await repository.update(original.tenderId, {})).toJSON()).toEqual(original.toJSON());
      });

      it("throws TenderNotFoundException for an unknown tenderId", async () => {
        expect(await catchAsyncError(() => repository.update("missing", { title: "x" }))).toBeInstanceOf(TenderNotFoundException);
      });

      it.each(["Closed", "Awarded", "Cancelled"] as const)("refuses to change a %s tender and leaves it as it was", async (status) => {
        const tender = await store({}, status);
        const error = await catchAsyncError(() => repository.update(tender.tenderId, { title: "Nope" }));
        expect(error).toBeInstanceOf(InvalidTenderStatusException);
        expect((await repository.findById(tender.tenderId))?.title).toBe(tender.title);
      });

      it("rejects invalid values with InvalidTenderDataException and stores nothing", async () => {
        const original = await store();
        for (const changes of [{ title: "  " }, { estimatedBudget: -1 }, { requirements: ["a", "A"] }, { submissionDeadline: new Date("nope") }]) {
          expect(await catchAsyncError(() => repository.update(original.tenderId, changes))).toBeInstanceOf(InvalidTenderDataException);
        }
        expect((await repository.findById(original.tenderId))?.toJSON()).toEqual(original.toJSON());
      });

      it("rejects fields that can never change (status, brokerId, tenderId, createdAt, publicationDate)", async () => {
        const original = await store();
        const forbidden = [{ status: "Published" }, { brokerId: "other" }, { tenderId: "other" }, { createdAt: new Date() }, { publicationDate: new Date() }];
        for (const changes of forbidden) {
          const error = await catchAsyncError(() => repository.update(original.tenderId, changes as never));
          expect(error).toBeInstanceOf(InvalidTenderDataException);
        }
        expect((await repository.findById(original.tenderId))?.toJSON()).toEqual(original.toJSON());
      });
    });

    describe("updateStatus", () => {
      it("publishes a Draft with its publication date", async () => {
        const draft = await store();
        const published = await repository.updateStatus(draft.tenderId, "Published", { publicationDate: TENDER_NOW, expectedStatus: "Draft" });
        expect(published.status).toBe("Published");
        expect(published.publicationDate?.getTime()).toBe(TENDER_NOW.getTime());
        expect((await repository.findById(draft.tenderId))?.status).toBe("Published");
      });

      it("follows Published -> Closed -> Awarded and Published -> Cancelled", async () => {
        const closed = await store({}, "Closed");
        expect(closed.status).toBe("Closed");
        expect((await repository.updateStatus(closed.tenderId, "Awarded")).status).toBe("Awarded");

        const published = await store({}, "Published");
        const cancelled = await repository.updateStatus(published.tenderId, "Cancelled");
        expect(cancelled.status).toBe("Cancelled");
        expect(cancelled.publicationDate?.getTime()).toBe(TENDER_NOW.getTime());
      });

      it("cancels a Draft without a publication date", async () => {
        const draft = await store();
        const cancelled = await repository.updateStatus(draft.tenderId, "Cancelled");
        expect(cancelled.status).toBe("Cancelled");
        expect(cancelled.publicationDate).toBeNull();
      });

      it("refuses transitions that are not allowed and keeps the status", async () => {
        const draft = await store();
        for (const status of ["Closed", "Awarded"] as const) {
          expect(await catchAsyncError(() => repository.updateStatus(draft.tenderId, status))).toBeInstanceOf(InvalidTenderStatusException);
        }
        const cancelled = await store({}, "Cancelled");
        expect(await catchAsyncError(() => repository.updateStatus(cancelled.tenderId, "Published", { publicationDate: TENDER_NOW }))).toBeInstanceOf(
          InvalidTenderStatusException,
        );
        const closed = await store({}, "Closed");
        expect(await catchAsyncError(() => repository.updateStatus(closed.tenderId, "Cancelled"))).toBeInstanceOf(InvalidTenderStatusException);
        expect((await repository.findById(draft.tenderId))?.status).toBe("Draft");
        expect((await repository.findById(closed.tenderId))?.status).toBe("Closed");
      });

      it("asking for the current status changes nothing", async () => {
        const published = await store({}, "Published");
        const same = await repository.updateStatus(published.tenderId, "Published");
        expect(same.toJSON()).toEqual(published.toJSON());
      });

      it("expectedStatus protects against a status that has already changed", async () => {
        const draft = await store();
        await repository.updateStatus(draft.tenderId, "Cancelled");
        const error = await catchAsyncError(() =>
          repository.updateStatus(draft.tenderId, "Published", { expectedStatus: "Draft", publicationDate: TENDER_NOW }),
        );
        expect(error).toBeInstanceOf(InvalidTenderStatusException);
        expect((await repository.findById(draft.tenderId))?.status).toBe("Cancelled");
      });

      it("needs a publication date to publish, and accepts one only when publishing", async () => {
        const draft = await store();
        expect(await catchAsyncError(() => repository.updateStatus(draft.tenderId, "Published"))).toBeInstanceOf(InvalidTenderDataException);
        expect(await catchAsyncError(() => repository.updateStatus(draft.tenderId, "Cancelled", { publicationDate: TENDER_NOW }))).toBeInstanceOf(
          InvalidTenderDataException,
        );
        expect((await repository.findById(draft.tenderId))?.status).toBe("Draft");
      });

      it("rejects an unknown status and an unknown tender", async () => {
        const draft = await store();
        expect(await catchAsyncError(() => repository.updateStatus(draft.tenderId, "Archived" as never))).toBeInstanceOf(InvalidTenderDataException);
        expect(await catchAsyncError(() => repository.updateStatus("missing", "Cancelled"))).toBeInstanceOf(TenderNotFoundException);
      });
    });

    describe("delete", () => {
      it("removes a Draft tender", async () => {
        const draft = await store();
        await repository.delete(draft.tenderId);
        expect(await repository.findById(draft.tenderId)).toBeNull();
      });

      it.each(["Published", "Closed", "Awarded", "Cancelled"] as const)("keeps a %s tender and throws InvalidTenderStatusException", async (status) => {
        const tender = await store({}, status);
        expect(await catchAsyncError(() => repository.delete(tender.tenderId))).toBeInstanceOf(InvalidTenderStatusException);
        expect(await repository.findById(tender.tenderId)).not.toBeNull();
      });

      it("throws TenderNotFoundException for an unknown tenderId", async () => {
        expect(await catchAsyncError(() => repository.delete("missing"))).toBeInstanceOf(TenderNotFoundException);
      });
    });

    describe("findAll", () => {
      it("returns tenders newest first", async () => {
        const a = await store({ createdAt: day(0) });
        const b = await store({ createdAt: day(2), submissionDeadline: day(40) });
        const c = await store({ createdAt: day(1), submissionDeadline: day(40) });
        expect((await repository.findAll()).map((t) => t.tenderId)).toEqual([b.tenderId, c.tenderId, a.tenderId]);
      });

      it("returns an empty list when there are no tenders", async () => {
        expect(await repository.findAll()).toEqual([]);
      });

      it("filters by status (one or several), broker and category", async () => {
        const draft = await store({ brokerId: "broker-1", category: "Goods", createdAt: day(0) });
        const published = await store({ brokerId: "broker-2", category: "Works", createdAt: day(1) }, "Published");
        const closed = await store({ brokerId: "broker-1", category: "Works", createdAt: day(2) }, "Closed");
        const ids = async (filters: Parameters<TenderRepositoryInterface["findAll"]>[0]) => (await repository.findAll(filters)).map((t) => t.tenderId).sort();

        expect(await ids({ status: "Draft" })).toEqual([draft.tenderId]);
        expect(await ids({ status: ["Published", "Closed"] })).toEqual([published.tenderId, closed.tenderId].sort());
        expect(await ids({ brokerId: "broker-1" })).toEqual([draft.tenderId, closed.tenderId].sort());
        expect(await ids({ category: "Works" })).toEqual([published.tenderId, closed.tenderId].sort());
        expect(await ids({ brokerId: "broker-1", category: "Works", status: "Closed" })).toEqual([closed.tenderId]);
        expect(await ids({ brokerId: "nobody" })).toEqual([]);
      });

      it("pages with limit and skip", async () => {
        const created = [];
        for (let i = 0; i < 5; i += 1) created.push(await store({ createdAt: day(i) }));
        const newestFirst = created.map((t) => t.tenderId).reverse();

        expect((await repository.findAll({ limit: 2 })).map((t) => t.tenderId)).toEqual(newestFirst.slice(0, 2));
        expect((await repository.findAll({ limit: 2, skip: 2 })).map((t) => t.tenderId)).toEqual(newestFirst.slice(2, 4));
        expect((await repository.findAll({ skip: 4 })).map((t) => t.tenderId)).toEqual(newestFirst.slice(4));
      });

      it("rejects bad filters with InvalidTenderDataException", async () => {
        for (const filters of [{ status: "Archived" }, { status: [] }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { skip: -1 }, { brokerId: " " }, { category: 3 }]) {
          expect(await catchAsyncError(() => repository.findAll(filters as never))).toBeInstanceOf(InvalidTenderDataException);
        }
      });
    });

    describe("findOpenTenders", () => {
      it("returns only Published tenders whose deadline is after the reference date, soonest first", async () => {
        const later = await store({ submissionDeadline: day(50), createdAt: day(0) }, "Published");
        const sooner = await store({ submissionDeadline: day(20), createdAt: day(1) }, "Published");
        await store({ submissionDeadline: day(30) }, "Draft");
        await store({ submissionDeadline: day(30) }, "Closed");
        await store({ submissionDeadline: day(30) }, "Cancelled");
        await store({ submissionDeadline: day(5) }, "Published"); // deadline already passed at the reference date

        const open = await repository.findOpenTenders({ referenceDate: day(10) });
        expect(open.map((t) => t.tenderId)).toEqual([sooner.tenderId, later.tenderId]);
      });

      it("a tender whose deadline equals the reference date is no longer open", async () => {
        await store({ submissionDeadline: day(10) }, "Published");
        expect(await repository.findOpenTenders({ referenceDate: day(10) })).toEqual([]);
      });

      it("filters by category and pages", async () => {
        const works = await store({ category: "Works", submissionDeadline: day(20) }, "Published");
        await store({ category: "Goods", submissionDeadline: day(21) }, "Published");
        await store({ category: "Works", submissionDeadline: day(22) }, "Published");

        expect((await repository.findOpenTenders({ referenceDate: day(1), category: "Works" })).map((t) => t.tenderId)).toContain(works.tenderId);
        expect(await repository.findOpenTenders({ referenceDate: day(1), category: "Works" })).toHaveLength(2);
        expect(await repository.findOpenTenders({ referenceDate: day(1), limit: 1, skip: 1 })).toHaveLength(1);
      });

      it("defaults the reference date to now (the fixtures' 2030 deadlines are open)", async () => {
        const open = await store({}, "Published");
        expect((await repository.findOpenTenders()).map((t) => t.tenderId)).toContain(open.tenderId);
      });

      it("rejects an invalid reference date or paging", async () => {
        expect(await catchAsyncError(() => repository.findOpenTenders({ referenceDate: new Date("nope") }))).toBeInstanceOf(InvalidTenderDataException);
        expect(await catchAsyncError(() => repository.findOpenTenders({ limit: 0 }))).toBeInstanceOf(InvalidTenderDataException);
      });
    });
  });
}
