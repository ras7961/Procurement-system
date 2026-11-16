import { ObjectId } from "mongodb";
import { UserRepositoryException } from "@/entities/exceptions";
import { User, type UserStatus } from "@/entities/User";
import { describeDriverError } from "./mongoErrors";

/**
 * How a user is stored in the "users" collection. MongoDB-specific, so it lives here and
 * never in entities.
 *
 * `_id` holds the domain userId. The application layer creates the id before saving (the
 * User entity requires one), so a MongoDB-generated ObjectId is not used as the key.
 */
export interface UserDocument {
  _id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  roleId: string;
  status: UserStatus;
  createdAt: Date;
}

/** A stored document as it may come back from the driver; `_id` could be an ObjectId in legacy data. */
export type StoredUserDocument = Omit<UserDocument, "_id" | "createdAt"> & {
  _id: string | ObjectId;
  createdAt: Date | string | number;
};

export function toUserDocument(user: User): UserDocument {
  return {
    _id: user.userId,
    fullName: user.fullName,
    email: user.email,
    passwordHash: user.passwordHash,
    roleId: user.roleId,
    status: user.status,
    createdAt: user.createdAt,
  };
}

/** Converts a stored document to a validated User. A corrupt document is a storage problem. */
export function toUser(document: StoredUserDocument): User {
  try {
    return User.restore({
      userId: toDomainId(document._id),
      fullName: document.fullName,
      email: document.email,
      passwordHash: document.passwordHash,
      roleId: document.roleId,
      status: document.status,
      createdAt: toDomainDate(document.createdAt),
    });
  } catch (error) {
    throw new UserRepositoryException({
      cause: error,
      details: { reason: "stored user document is invalid", ...describeDriverError(error) },
    });
  }
}

/** ObjectIds are converted to their hex string at the adapter boundary; strings pass through. */
export function toDomainId(value: unknown): string {
  if (value instanceof ObjectId) return value.toHexString();
  return typeof value === "string" ? value : String(value);
}

/** BSON dates arrive as JS Dates. Anything else is converted, and an unusable value becomes an Invalid Date that validation rejects. */
export function toDomainDate(value: unknown): Date {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date(Number.NaN);
}
