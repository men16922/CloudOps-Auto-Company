/** Browser identity only. AWS credentials and Device Code tokens never implement this interface. */
export type WebIdentity = Readonly<{ key: string; label: string }>;
export interface WebIdentityClient {
  subscribe(listener: (identity: WebIdentity | null) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  tokenFor(identityKey: string): Promise<string>;
  close(): Promise<void>;
}
