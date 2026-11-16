import { describe, expect, it } from "vitest";
import { InvalidSupplierDataException, SupplierVerificationException } from "@/entities/exceptions";
import { Supplier, normalizeSupplierQuery, registrationNumberKey } from "@/entities/Supplier";
import { catchError, makeSupplier, TENDER_NOW } from "../support/fixtures";

const valid = {
  supplierId: "s-1",
  userId: "u-1",
  companyName: "  Acme Trading PLC ",
  registrationNumber: " ET-AA-001 ",
  email: " info@acme.example ",
  phoneNumber: "+251 91 234 5678",
  address: "Piassa, Addis Ababa",
  registrationDate: TENDER_NOW,
};

describe("Supplier.register", () => {
  it("builds a Pending profile with trimmed values and a copy of the date", () => {
    const supplier = Supplier.register(valid);
    expect(supplier.toJSON()).toEqual({
      supplierId: "s-1",
      userId: "u-1",
      companyName: "Acme Trading PLC",
      registrationNumber: "ET-AA-001",
      email: "info@acme.example",
      phoneNumber: "+251 91 234 5678",
      address: "Piassa, Addis Ababa",
      verificationStatus: "Pending",
      registrationDate: TENDER_NOW.toISOString(),
    });
    expect(supplier.registrationDate).not.toBe(supplier.registrationDate); // a new Date each time
  });

  it("always starts Pending: a status passed in is ignored", () => {
    const supplier = Supplier.register({ ...valid, verificationStatus: "Verified" } as never);
    expect(supplier.verificationStatus).toBe("Pending");
  });

  it("holds no account fields: no password, role or account status", () => {
    const json = JSON.stringify(Supplier.register(valid).toJSON());
    expect(json).not.toMatch(/password|role|accountStatus/i);
  });

  it("lists every problem at once", () => {
    const error = catchError(() => Supplier.register({ ...valid, companyName: "", email: "nope", phoneNumber: "x", address: " " }));
    expect(error).toBeInstanceOf(InvalidSupplierDataException);
    const issues = (error as InvalidSupplierDataException).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        "companyName is required",
        "email must be a valid email address",
        "phoneNumber must be a valid phone number",
        "address is required",
      ]),
    );
  });

  it.each([
    ["supplierId", { supplierId: "a b" }],
    ["userId", { userId: "" }],
    ["companyName too long", { companyName: "x".repeat(201) }],
    ["registrationNumber missing", { registrationNumber: undefined }],
    ["non-string values", { companyName: 5 }],
    ["bad date", { registrationDate: new Date("nope") }],
  ])("rejects invalid %s", (_label, override) => {
    expect(catchError(() => Supplier.register({ ...valid, ...override } as never))).toBeInstanceOf(InvalidSupplierDataException);
  });

  it("rejects a missing props object without crashing", () => {
    expect(catchError(() => Supplier.register(undefined as never))).toBeInstanceOf(InvalidSupplierDataException);
  });

  it("error messages never contain the submitted values", () => {
    const error = catchError(() => Supplier.register({ ...valid, email: "secret-value" }));
    expect(error.message).not.toContain("secret-value");
  });
});

describe("Supplier.updateProfile", () => {
  it("changes only the given fields", () => {
    const supplier = makeSupplier();
    const before = supplier.toJSON();
    supplier.updateProfile({ address: "  New address " });
    expect(supplier.toJSON()).toEqual({ ...before, address: "New address" });
  });

  it("rejects an empty update, unknown fields and protected fields, changing nothing", () => {
    const supplier = makeSupplier();
    const before = supplier.toJSON();
    for (const changes of [{}, { userId: "x" }, { verificationStatus: "Verified" }, { registrationDate: new Date() }, { supplierId: "x" }]) {
      expect(catchError(() => supplier.updateProfile(changes as never))).toBeInstanceOf(InvalidSupplierDataException);
    }
    expect(supplier.toJSON()).toEqual(before);
  });

  it("validates new values and changes nothing when one is invalid", () => {
    const supplier = makeSupplier();
    const before = supplier.toJSON();
    expect(catchError(() => supplier.updateProfile({ address: "New", email: "bad" }))).toBeInstanceOf(InvalidSupplierDataException);
    expect(supplier.toJSON()).toEqual(before);
  });

  it("resets a Verified profile to Pending only when asked and only when the company name or registration number changes", () => {
    const base = () => {
      const s = makeSupplier();
      s.verify("Verified");
      return s;
    };

    const staffEdit = base();
    staffEdit.updateProfile({ companyName: "Renamed PLC" });
    expect(staffEdit.verificationStatus).toBe("Verified");

    const contactOnly = base();
    contactOnly.updateProfile({ phoneNumber: "+251 11 000 0000", address: "Elsewhere" }, { resetVerification: true });
    expect(contactOnly.verificationStatus).toBe("Verified");

    const sameName = base();
    sameName.updateProfile({ companyName: sameName.companyName }, { resetVerification: true });
    expect(sameName.verificationStatus).toBe("Verified");

    const renamed = base();
    renamed.updateProfile({ companyName: "Renamed PLC" }, { resetVerification: true });
    expect(renamed.verificationStatus).toBe("Pending");

    const newNumber = base();
    newNumber.updateProfile({ registrationNumber: "OTHER-1" }, { resetVerification: true });
    expect(newNumber.verificationStatus).toBe("Pending");
  });

  it("does not reset a Rejected profile", () => {
    const supplier = makeSupplier();
    supplier.verify("Rejected");
    supplier.updateProfile({ companyName: "Renamed PLC" }, { resetVerification: true });
    expect(supplier.verificationStatus).toBe("Rejected");
  });

  it("a registration number that differs only by case or spaces is not an identity change", () => {
    const supplier = makeSupplier({ registrationNumber: "AB-1" });
    supplier.verify("Verified");
    supplier.updateProfile({ registrationNumber: " ab-1 " }, { resetVerification: true });
    expect(supplier.verificationStatus).toBe("Verified");
    expect(supplier.registrationNumber).toBe("ab-1");
  });
});

describe("Supplier.verify", () => {
  it("moves between Pending, Verified and Rejected as a reviewer decides", () => {
    const supplier = makeSupplier();
    supplier.verify("Verified");
    expect(supplier.verificationStatus).toBe("Verified");
    supplier.verify("Rejected");
    expect(supplier.verificationStatus).toBe("Rejected");
    supplier.verify("Verified");
    expect(supplier.verificationStatus).toBe("Verified");
  });

  it("refuses the status it already has", () => {
    const supplier = makeSupplier();
    supplier.verify("Verified");
    expect(catchError(() => supplier.verify("Verified"))).toBeInstanceOf(SupplierVerificationException);
  });

  it("cannot be used to set Pending or an unknown status", () => {
    const supplier = makeSupplier();
    expect(catchError(() => supplier.verify("Pending" as never))).toBeInstanceOf(InvalidSupplierDataException);
    expect(catchError(() => supplier.verify("Approved" as never))).toBeInstanceOf(InvalidSupplierDataException);
    expect(supplier.verificationStatus).toBe("Pending");
  });
});

describe("Supplier.restore", () => {
  it("rebuilds a stored profile of any status", () => {
    for (const verificationStatus of ["Pending", "Verified", "Rejected"] as const) {
      expect(Supplier.restore({ ...valid, verificationStatus }).verificationStatus).toBe(verificationStatus);
    }
  });

  it("rejects a stored profile with an unknown status", () => {
    expect(catchError(() => Supplier.restore({ ...valid, verificationStatus: "Archived" } as never))).toBeInstanceOf(InvalidSupplierDataException);
  });
});

describe("normalizeSupplierQuery and registrationNumberKey", () => {
  it("applies defaults, dedupes statuses and validates paging", () => {
    expect(normalizeSupplierQuery()).toEqual({ statuses: null, limit: 100, skip: 0 });
    expect(normalizeSupplierQuery({ verificationStatus: ["Pending", "Pending", "Verified"], limit: 5, skip: 2 })).toEqual({
      statuses: ["Pending", "Verified"],
      limit: 5,
      skip: 2,
    });
    for (const bad of [{ verificationStatus: "Nope" }, { verificationStatus: [] }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { skip: -1 }]) {
      expect(catchError(() => normalizeSupplierQuery(bad as never))).toBeInstanceOf(InvalidSupplierDataException);
    }
  });

  it("ignores case and surrounding spaces", () => {
    expect(registrationNumberKey("  ET-AA-001 ")).toBe(registrationNumberKey("et-aa-001"));
  });
});
