import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../../../../packages/contracts/errors';
import type { VerifiedCloudContext } from '../../../../packages/contracts/access-context';
import type { CloudStore, CloudTransaction } from '../storage/store';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
/** `loginName` is a signed login claim (for example the e-mail) the server may compare with the AWS session name; it never selects an actor or a role. */
export type VerifiedWebIdentity = Readonly<{ actorId: string; expiresAt: number; loginName?: string }>;
/** Implementations must verify signature, issuer/audience, expiry and provider revocation. */
export interface WebIdentityVerifier { verify(token: string): Promise<VerifiedWebIdentity> }
export function identityActor(issuer: string, subject: string, tenant = '') {
  return createHash('sha256').update(JSON.stringify([issuer, tenant, subject])).digest('hex');
}
export const membershipSchema = z.object({
  organizationId: id, workspaceId: id, actorId: id, active: z.boolean(),
  roles: z.array(z.enum(['viewer', 'operator', 'reviewer'])).min(1).max(3),
  version: z.number().int().positive(), updatedAt: z.iso.datetime(),
}).strict();
type OrganizationMembership = z.infer<typeof membershipSchema>;
export type OrganizationWebSession = Readonly<{ identity: VerifiedWebIdentity; context: VerifiedCloudContext; membershipVersion: number }>;
export function membershipKey(organizationId: string, workspaceId: string, actorId: string) {
  return `membership:${createHash('sha256').update(JSON.stringify([organizationId, workspaceId, actorId])).digest('hex')}`;
}
const denied = () => new CloudOperationError(403, 'organization_access_denied', 'Organization membership is required.');
const unauthenticated = () => new CloudOperationError(401, 'web_sign_in_required', 'Sign in to the web application again.');

/** The company edition injects its own verifier; this module has no Firebase/SSO SDK dependency. */
export class OrganizationWebAccess {
  private readonly identities: WebIdentityVerifier;
  private readonly store: CloudStore;
  private readonly now: () => number;
  constructor(identities: WebIdentityVerifier, store: CloudStore, now = Date.now) { this.identities = identities; this.store = store; this.now = now; }
  async authenticate(authorization: string | undefined, organizationId: string, workspaceId: string): Promise<OrganizationWebSession> {
    id.parse(organizationId); id.parse(workspaceId);
    if (!authorization || authorization.length > 16_384 || !/^Bearer [A-Za-z0-9_.~-]+$/.test(authorization)) throw unauthenticated();
    let identity: VerifiedWebIdentity;
    try { identity = await this.identities.verify(authorization.slice(7)); }
    catch { throw unauthenticated(); }
    if (!id.safeParse(identity.actorId).success || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= this.now()) throw unauthenticated();
    return this.store.transact(async tx => {
      const membership = membershipSchema.safeParse(await tx.get(membershipKey(organizationId, workspaceId, identity.actorId)));
      if (!membership.success || !membership.data.active || membership.data.actorId !== identity.actorId || membership.data.organizationId !== organizationId || membership.data.workspaceId !== workspaceId) throw denied();
      return { identity: Object.freeze({ ...identity }), membershipVersion: membership.data.version,
        context: { actorId: identity.actorId, owner: { kind: 'organization', organizationId }, workspaceId, channel: 'web', roles: membership.data.roles } };
    });
  }
  async assertCurrentIn(tx: CloudTransaction, session: OrganizationWebSession) {
    const { identity, context } = session;
    if (identity.expiresAt <= this.now()) throw unauthenticated();
    if (context.owner.kind !== 'organization' || context.channel !== 'web' || context.actorId !== identity.actorId) throw denied();
    const value = membershipSchema.safeParse(await tx.get(membershipKey(context.owner.organizationId, context.workspaceId, identity.actorId)));
    if (!value.success || !value.data.active || value.data.version !== session.membershipVersion
      || value.data.actorId !== identity.actorId || value.data.organizationId !== context.owner.organizationId || value.data.workspaceId !== context.workspaceId
      || JSON.stringify(value.data.roles) !== JSON.stringify(context.roles)) throw denied();
  }
  async assertCurrent(session: OrganizationWebSession) { await this.store.transact(tx => this.assertCurrentIn(tx, session)); }
  /** Trusted administration/bootstrap only; deliberately not exposed by an HTTP route. */
  async provision(input: unknown): Promise<void> {
    const value = membershipSchema.parse(input), key = membershipKey(value.organizationId, value.workspaceId, value.actorId);
    await this.store.transact(async tx => {
      const previous = await tx.get<OrganizationMembership>(key);
      if (previous && value.version <= previous.version) throw new CloudOperationError(409, 'membership_version_conflict', 'Provision a newer membership version.');
      tx.put(key, value);
    });
  }
}
