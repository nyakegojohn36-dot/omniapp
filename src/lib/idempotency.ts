/**
 * Idempotency Key Manager
 * Prevents duplicate orders, double payments, and repeated webhook processing.
 */

export interface IdempotencyRecord<T = unknown> {
  key: string;
  tenantId: string;
  operation: string;
  status: 'PENDING' | 'RESOLVED' | 'FAILED';
  response?: T;
  createdAt: string;
  expiresAt: string;
}

export class IdempotencyStore {
  private records: Map<string, IdempotencyRecord> = new Map();

  private makeKey(tenantId: string, operation: string, key: string): string {
    return `${tenantId}:${operation}:${key}`;
  }

  /**
   * Check or acquire idempotency lock
   */
  public acquire<T>(
    tenantId: string,
    operation: string,
    key: string,
    ttlMinutes = 60
  ): { status: 'NEW' | 'CACHED' | 'IN_FLIGHT'; cachedResponse?: T } {
    const fullKey = this.makeKey(tenantId, operation, key);
    const existing = this.records.get(fullKey);

    if (existing) {
      if (existing.status === 'RESOLVED') {
        return { status: 'CACHED', cachedResponse: existing.response as T };
      }
      if (existing.status === 'PENDING') {
        return { status: 'IN_FLIGHT' };
      }
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

    this.records.set(fullKey, {
      key,
      tenantId,
      operation,
      status: 'PENDING',
      createdAt: now.toISOString(),
      expiresAt,
    });

    return { status: 'NEW' };
  }

  /**
   * Commit the result of an idempotent operation
   */
  public resolve<T>(tenantId: string, operation: string, key: string, response: T): void {
    const fullKey = this.makeKey(tenantId, operation, key);
    const existing = this.records.get(fullKey);
    if (existing) {
      existing.status = 'RESOLVED';
      existing.response = response;
      this.records.set(fullKey, existing);
    }
  }

  /**
   * Fail an idempotent operation allowing retry
   */
  public fail(tenantId: string, operation: string, key: string): void {
    const fullKey = this.makeKey(tenantId, operation, key);
    this.records.delete(fullKey);
  }

  public clear(): void {
    this.records.clear();
  }
}
