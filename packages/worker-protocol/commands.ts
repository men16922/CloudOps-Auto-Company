import { z } from 'zod';
import { cliReadSchema } from './cli-contract';

/** One command on the private host→worker pipe. The host never forwards browser input as a command. */
export const workerCommandSchema = z.object({
  id: z.uuid(), operation: z.enum(['status', 'login', 'verify', 'inspect', 'directory', 'disconnect', 'logout', 'sync', 'sync-status', 'sync-unit']),
  service: cliReadSchema.optional(), cursor: z.uuid().optional(), unit: z.uuid().optional(),
}).strict().refine(value => (value.operation === 'inspect' ? Boolean(value.service) : value.service === undefined) && (value.operation === 'directory' || value.cursor === undefined)
  && (value.operation === 'sync-unit' ? Boolean(value.unit) : value.unit === undefined));
