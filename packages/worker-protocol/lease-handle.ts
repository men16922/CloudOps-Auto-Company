import { z } from 'zod';

/** Identity of one worker generation, shared by the host lease store, provisioners and the worker handshake. */
export const leaseIdentity = {
  connectionId: z.uuid(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  supervisorId: z.uuid(), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), leaseId: z.uuid(),
  resourceKey: z.string().regex(/^worker-[a-f0-9-]{36}$/), cacheKey: z.string().regex(/^cache-[a-f0-9-]{36}$/),
};
export const workerLeaseHandleSchema = z.object(leaseIdentity).strict().refine(value => value.resourceKey === `worker-${value.leaseId}` && value.cacheKey === `cache-${value.leaseId}`);
export type WorkerLeaseHandle = z.infer<typeof workerLeaseHandleSchema>;
