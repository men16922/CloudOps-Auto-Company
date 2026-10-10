import { z } from 'zod';
import type { CloudBinding, CloudPlanPayload } from './cloud-operations';

export const cloudRequestKeySchema = z.uuid();
export const cloudHandoffSchema = z.object({ note: z.string().trim().min(1).max(2000) }).strict();
export type CloudReview = {
  status: 'not_requested' | 'pending' | 'approved' | 'rejected' | 'changes_requested';
  requestedAt?: string; requestedBy?: string;
  decidedAt?: string; decidedBy?: string; note?: string;
};
export type CloudPlan = {
  payload: CloudPlanPayload; digest: string;
  lifecycle: 'prepared' | 'superseded' | 'consumed';
  review: CloudReview; executionId?: string; supersededBy?: string;
};
export type CloudExecution = {
  id: string; binding: CloudBinding; planId: string; planDigest: string;
  dataMode: 'synthetic' | 'live'; actionId: CloudPlanPayload['action']['id'];
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  createdAt: string; updatedAt: string; createdBy: string;
  startedAt?: string; finishedAt?: string; message: string;
  result?: { evidenceId: string; digest: string; coverage: 'complete' | 'partial'; serviceAssessment: 'unknown' };
  handoffs: { id: string; at: string; actorId: string; note: string }[];
};
export type CloudIntent = {
  id: string; kind: 'review-notification' | 'execution-dispatch';
  binding: CloudBinding; planId: string; executionId?: string;
  state: 'pending' | 'claimed' | 'closed'; createdAt: string;
};

export class CloudOperationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
