import type { Collection } from "mongodb";
import {
  AppError,
  DatabaseOperationException,
  DuplicateRoleException,
  RoleNotFoundException,
} from "@/entities/exceptions";
import type { Role, RoleName } from "@/entities/Role";
import type { MongoDBConnection } from "@/infrastructure/database/MongoDBConnection";
import type { RoleRepositoryInterface, RoleUpdateData } from "@/interfaces/repositories/RoleRepositoryInterface";
import { describeDriverError, isDuplicateKeyOn } from "./mongoErrors";
import type { MongoRepositoryOptions } from "./MongoUserRepository";
import { toRole, toRoleDocument, type RoleDocument } from "./roleDocumentMapper";

export const ROLES_COLLECTION = "roles";
export const ROLE_NAME_INDEX = "roleName_unique";

/**
 * repositories.MongoRoleRepository, implementing RoleRepositoryInterface (which is not in the ODD;
 * see the interface file).
 *
 * Same conventions as MongoUserRepository: shared MongoDBConnection, domain id == `_id`,
 * mapping kept in roleDocumentMapper, safe errors (duplicate name -> DuplicateRoleException,
 * everything else -> DatabaseOperationException), idempotent indexes created on first use.
 * update() can change only description and permissions; roleId, roleName and createdAt never change.
 */
export class MongoRoleRepository implements RoleRepositoryInterface {
  readonly #connection: MongoDBConnection;
  readonly #collectionName: string;
  #indexes: Promise<void> | null = null;

  constructor(connection: MongoDBConnection, options: MongoRepositoryOptions = {}) {
    this.#connection = connection;
    this.#collectionName = options.collectionName ?? ROLES_COLLECTION;
  }

  /** Creates the indexes if they are missing. Called automatically on first use; safe to call again. */
  async ensureIndexes(): Promise<void> {
    await this.#run(async () => undefined);
  }

  async create(role: Role): Promise<Role> {
    return this.#run(async (roles) => {
      const document = toRoleDocument(role);
      await roles.insertOne(document);
      return toRole(document);
    });
  }

  async findById(roleId: string): Promise<Role | null> {
    return this.#run(async (roles) => {
      const document = await roles.findOne({ _id: roleId });
      return document ? toRole(document) : null;
    });
  }

  async findByName(roleName: RoleName): Promise<Role | null> {
    return this.#run(async (roles) => {
      const document = await roles.findOne({ roleName });
      return document ? toRole(document) : null;
    });
  }

  async findAll(): Promise<Role[]> {
    return this.#run(async (roles) => {
      const documents = await roles.find({}).sort({ createdAt: 1, _id: 1 }).toArray();
      return documents.map(toRole);
    });
  }

  async update(roleId: string, roleData: RoleUpdateData): Promise<Role> {
    return this.#run(async (roles) => {
      const current = await roles.findOne({ _id: roleId });
      if (!current) throw new RoleNotFoundException();

      // Validate through the entity before writing.
      const merged = toRole({
        ...current,
        description: roleData.description ?? current.description,
        permissions: roleData.permissions ? [...roleData.permissions] : current.permissions,
      });

      const changes: Partial<Pick<RoleDocument, "description" | "permissions">> = {};
      if (roleData.description !== undefined) changes.description = merged.description;
      if (roleData.permissions !== undefined) changes.permissions = merged.getPermissions();
      if (Object.keys(changes).length === 0) return merged;

      const updated = await roles.findOneAndUpdate({ _id: roleId }, { $set: changes }, { returnDocument: "after" });
      if (!updated) throw new RoleNotFoundException(); // deleted between the read and the write
      return toRole(updated);
    });
  }

  async #run<T>(operation: (roles: Collection<RoleDocument>) => Promise<T>): Promise<T> {
    try {
      const database = await this.#connection.getDatabase();
      const roles = database.collection<RoleDocument>(this.#collectionName);
      await this.#prepareIndexes(roles);
      return await operation(roles);
    } catch (error) {
      throw translate(error);
    }
  }

  #prepareIndexes(roles: Collection<RoleDocument>): Promise<void> {
    this.#indexes ??= roles
      .createIndex({ roleName: 1 }, { unique: true, name: ROLE_NAME_INDEX })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#indexes = null; // allow a retry on the next call
        throw error;
      });
    return this.#indexes;
  }
}

function translate(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isDuplicateKeyOn(error, "roleName", ROLE_NAME_INDEX)) return new DuplicateRoleException({ cause: error });
  return new DatabaseOperationException({ cause: error, details: describeDriverError(error) });
}
