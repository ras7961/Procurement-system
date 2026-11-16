import { DuplicateEmailException, UserNotFoundException, UserRepositoryException } from "@/entities/exceptions";
import { User, type RestoreUserProps, type UserStatus } from "@/entities/User";
import type { UserRepositoryInterface, UserUpdateData } from "@/interfaces/repositories/UserRepositoryInterface";

/**
 * Test double that implements UserRepositoryInterface in memory.
 * It proves the interface can be implemented and gives use-case tests a database-free repository.
 */
export class InMemoryUserRepository implements UserRepositoryInterface {
  private readonly rows = new Map<string, RestoreUserProps>();

  async create(user: User): Promise<User> {
    if (this.rows.has(user.userId)) throw new UserRepositoryException();
    if (this.findRowByEmail(user.email)) throw new DuplicateEmailException();
    this.rows.set(user.userId, toRow(user));
    return this.load(user.userId);
  }

  async findById(userId: string): Promise<User | null> {
    return this.rows.has(userId) ? this.load(userId) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = this.findRowByEmail(email);
    return row ? User.restore(row) : null;
  }

  async update(userId: string, userData: UserUpdateData): Promise<User> {
    const current = this.requireRow(userId);
    const next: RestoreUserProps = { ...current, ...definedOnly(userData) };
    const owner = this.findRowByEmail(next.email);
    if (owner && owner.userId !== userId) throw new DuplicateEmailException();
    const validated = User.restore(next);
    this.rows.set(userId, toRow(validated));
    return validated;
  }

  async delete(userId: string): Promise<void> {
    this.requireRow(userId);
    this.rows.delete(userId);
  }

  async findAll(): Promise<User[]> {
    return [...this.rows.keys()].map((id) => this.load(id));
  }

  async updateStatus(userId: string, status: UserStatus): Promise<User> {
    return this.update(userId, { status });
  }

  private load(userId: string): User {
    return User.restore(this.requireRow(userId));
  }

  private requireRow(userId: string): RestoreUserProps {
    const row = this.rows.get(userId);
    if (!row) throw new UserNotFoundException();
    return row;
  }

  private findRowByEmail(email: string): RestoreUserProps | undefined {
    const wanted = email.trim().toLowerCase();
    return [...this.rows.values()].find((row) => row.email === wanted);
  }
}

function toRow(user: User): RestoreUserProps {
  return {
    userId: user.userId,
    fullName: user.fullName,
    email: user.email,
    passwordHash: user.passwordHash,
    roleId: user.roleId,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function definedOnly(data: UserUpdateData): UserUpdateData {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as UserUpdateData;
}
