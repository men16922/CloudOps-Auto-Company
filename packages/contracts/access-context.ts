/** Owner of a verified web session. This repository serves organization owners only; other kinds are refused by the access checks. */
export type CloudOwner = { kind: 'personal'; userId: string } | { kind: 'organization'; organizationId: string };

/** Only an identity adapter may construct this context; never deserialize it from a client body. */
export type VerifiedCloudContext = {
  actorId: string; owner: CloudOwner; workspaceId: string; channel: 'web' | 'mobile';
  roles: readonly ('viewer' | 'operator' | 'reviewer')[];
};
