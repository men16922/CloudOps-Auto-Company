import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { VerifiedCloudContext } from '../../../../src/domain/cloud-operations';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import { bindingDigest, cliReadSchema } from './organization-cli-contract';
import type { OrganizationCliWorker } from './organization-cli-worker';
import { workerLeaseHandleSchema, type WorkerLeaseHandle } from './organization-worker-leases';

export const workerCommandSchema = z.object({
  id: z.uuid(), operation: z.enum(['status', 'login', 'verify', 'inspect', 'directory', 'disconnect', 'logout']),
  service: cliReadSchema.optional(), cursor: z.uuid().optional(),
}).strict().refine(value => (value.operation === 'inspect' ? Boolean(value.service) : value.service === undefined) && (value.operation === 'directory' || value.cursor === undefined));

/** Trusted controller pipe only. No HTTP listener, actor override, profile or raw command input. */
export async function serveCliWorker(worker: OrganizationCliWorker, input: Readable, output: Writable, inputAllocation?: WorkerLeaseHandle) {
  const binding = worker.binding;
  const allocation = inputAllocation === undefined ? undefined : workerLeaseHandleSchema.parse(inputAllocation);
  if (allocation && (allocation.connectionId !== binding.connectionId || allocation.bindingDigest !== bindingDigest(binding))) throw new Error('Worker allocation does not match its binding.');
  // The parent authenticates its web user and binds a private worker to that connection.
  // stdin is NOT an authentication mechanism and must never be publicly forwarded.
  const context: VerifiedCloudContext = { actorId: binding.actorId, owner: { kind: 'organization', organizationId: binding.organizationId }, workspaceId: binding.workspaceId, channel: 'web', roles: ['viewer'] };
  const pending = new Set<Promise<void>>();
  const replies = new Map<string, { input: string; result: Promise<unknown> }>();
  let buffer = '', ended = false;
  const send = (id: string | null, data: unknown) => {
    if (ended || output.destroyed) return;
    if (!output.write(`${JSON.stringify({ id, bindingDigest: bindingDigest(binding), ...(allocation ? { allocation } : {}), ...data as object })}\n`)) {
      input.pause(); output.once('drain', () => { if (!ended) input.resume(); });
    }
  };
  const execute = async (command: z.infer<typeof workerCommandSchema>) => {
    switch (command.operation) {
      case 'status': return worker.status(context);
      case 'login': return worker.start(context);
      case 'verify': return worker.verify(context);
      case 'inspect': return worker.inspect(context, command.service);
      case 'directory': return worker.directory(context, command.cursor);
      case 'disconnect': return worker.disconnect(context);
      case 'logout': return worker.logout(context);
    }
  };
  const line = async (value: string) => {
    let id: string | null = null;
    try {
      const command = workerCommandSchema.parse(JSON.parse(value)); id = command.id;
      const canonical = JSON.stringify(command), prior = replies.get(id);
      if (prior && prior.input !== canonical) throw new CloudOperationError(409, 'request_key_conflict', 'Use a new request identifier.');
      if (!prior && replies.size >= 1000) throw new CloudOperationError(429, 'worker_request_limit', 'Reconnect with a new worker.');
      const reply = prior ?? { input: canonical, result: Promise.resolve().then(() => execute(command)) };
      if (!prior) replies.set(id, reply);
      send(id, { ok: true, result: await reply.result });
    } catch (error) {
      send(id, { ok: false, code: error instanceof CloudOperationError ? error.code : 'invalid_worker_request' });
    }
  };
  await new Promise<void>(resolve => {
    const finish = () => { if (ended) return; ended = true; input.off('data', consume); resolve(); };
    const consume = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 32_768) { send(null, { ok: false, code: 'worker_input_limit' }); finish(); return; }
      let split: number;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const value = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        if (pending.size >= 8) { send(null, { ok: false, code: 'worker_busy' }); continue; }
        const task = line(value).finally(() => pending.delete(task)); pending.add(task);
      }
    };
    input.on('data', consume); input.once('end', finish); input.once('close', finish); input.once('error', finish); output.once('error', finish); output.once('close', finish);
  });
  await worker.close(); await Promise.allSettled(pending);
}
