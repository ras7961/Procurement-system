/**
 * Identifier strategy for new records: random UUID v4 from the runtime's Web Crypto
 * (globalThis.crypto, available in Node 19+ and in browsers). Ids are created in the
 * application layer, never by the database, and never derived from user input.
 */
export function generateId(): string {
  return globalThis.crypto.randomUUID();
}
