/** Transaction callbacks can retry. Only storage reads/writes belong inside them. */
export interface CloudTransaction {
  get<T>(key: string): Promise<T | undefined>;
  /** Read the key first, and complete all reads before staging any writes. */
  put<T>(key: string, value: T): void;
}
export interface CloudStore {
  transact<T>(body: (transaction: CloudTransaction) => Promise<T>): Promise<T>;
}
