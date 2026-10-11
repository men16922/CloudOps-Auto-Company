import { z } from 'zod';
import { executionIdSchema, runbookIdSchema } from '../contracts/aws/runbooks';
import { cliReadSchema, cliTargetSchema } from './cli-contract';

/** A catalog runbook on one target (the instance only for EC2 runbooks); the host fills it from a checked, approved request. */
export const workerRunbookSchema = cliTargetSchema.extend({ id: runbookIdSchema, instanceId: z.string().regex(/^i-[a-f0-9]{8,17}$/).optional() }).strict();
/** An execution this connection started, read back in the same account and region. */
export const workerExecutionSchema = cliTargetSchema.extend({ id: executionIdSchema }).strict();
/** One command on the private host→worker pipe. The host never forwards browser input as a command. */
export const workerCommandSchema = z.object({
  id: z.uuid(), operation: z.enum(['status', 'login', 'verify', 'inspect', 'directory', 'disconnect', 'logout', 'sync', 'sync-status', 'sync-unit', 'runbook-start', 'runbook-status']),
  service: cliReadSchema.optional(), cursor: z.uuid().optional(), unit: z.uuid().optional(), runbook: workerRunbookSchema.optional(), execution: workerExecutionSchema.optional(),
}).strict().refine(value => (value.operation === 'inspect' ? Boolean(value.service) : value.service === undefined) && (value.operation === 'directory' || value.cursor === undefined)
  && (value.operation === 'sync-unit' ? Boolean(value.unit) : value.unit === undefined)
  && (value.operation === 'runbook-start' ? Boolean(value.runbook) : value.runbook === undefined)
  && (value.operation === 'runbook-status' ? Boolean(value.execution) : value.execution === undefined));
