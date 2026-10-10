import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import { bindingDigest, cliBindingSchema, type CliBinding } from './organization-cli-contract';
import type { OrganizationWorkerTransport } from './organization-connections';
import { workerLeaseHandleSchema, type WorkerLeaseHandle } from './organization-worker-leases';

const responseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.uuid(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), allocation: workerLeaseHandleSchema.optional(), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: z.uuid(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), allocation: workerLeaseHandleSchema.optional(), ok: z.literal(false), code: z.string().regex(/^[a-z_]{1,64}$/) }).strict(),
]);
type Reply = z.infer<typeof responseSchema>;
type Channel = { digest: string; ready: boolean; closed: boolean; input: Writable; pending: Map<string, { resolve(value: Reply): void; reject(error: Error): void }>; dispose(): void };
const unavailable = () => new CloudOperationError(503, 'worker_unavailable', 'The isolated connection worker is unavailable.');

/** Routes only already-provisioned, private worker pipes; never launches a shared host AWS CLI. */
export class OrganizationWorkerRouter implements OrganizationWorkerTransport {
  private readonly channels = new Map<string, Channel>();
  /** Trusted supervisor only. A cloud provisioner must additionally enforce a durable worker lease. */
  async attach(inputBinding: unknown, input: Writable, output: Readable, stop: () => Promise<void>, inputAllocation?: WorkerLeaseHandle): Promise<void> {
    const binding = cliBindingSchema.parse(inputBinding);
    const allocation = inputAllocation === undefined ? undefined : workerLeaseHandleSchema.parse(inputAllocation);
    if (allocation && (allocation.connectionId !== binding.connectionId || allocation.bindingDigest !== bindingDigest(binding))) throw unavailable();
    if (this.channels.has(binding.connectionId)) throw new CloudOperationError(409, 'worker_already_attached', 'This connection already has a worker.');
    const channel: Channel = { digest: bindingDigest(binding), ready: false, closed: false, input, pending: new Map(), dispose: () => {} };
    this.channels.set(binding.connectionId, channel); let buffer = '';
    channel.dispose = () => {
      if (channel.closed) return; channel.closed = true; channel.ready = false;
      if (this.channels.get(binding.connectionId) === channel) this.channels.delete(binding.connectionId);
      for (const value of channel.pending.values()) value.reject(unavailable()); channel.pending.clear();
      output.off('data', consume); void Promise.resolve().then(stop).catch(() => undefined);
    };
    const consume = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1_000_000) { channel.dispose(); return; }
      let split: number;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const value = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        let reply: Reply;
        try { reply = responseSchema.parse(JSON.parse(value)); } catch { channel.dispose(); return; }
        if (reply.bindingDigest !== channel.digest || JSON.stringify(reply.allocation) !== JSON.stringify(allocation)) { channel.dispose(); return; }
        const pending = channel.pending.get(reply.id); channel.pending.delete(reply.id); pending?.resolve(reply);
      }
    };
    output.on('data', consume); output.once('end', channel.dispose); output.once('close', channel.dispose); output.once('error', channel.dispose); input.once('error', channel.dispose);
    try {
      const reply = await this.send(channel, { id: randomUUID(), operation: 'status' }, AbortSignal.timeout(5000));
      const state = reply.ok ? z.object({ connectionId: z.uuid(), accountId: z.string(), roleName: z.string(), region: z.string() }).parse(reply.result) : undefined;
      if (!state || state.connectionId !== binding.connectionId || state.accountId !== binding.accountId || state.roleName !== binding.roleName || state.region !== binding.region || channel.closed) throw unavailable();
      channel.ready = true;
    } catch { channel.dispose(); throw unavailable(); }
  }
  private send(channel: Channel, command: Parameters<OrganizationWorkerTransport['invoke']>[1], signal: AbortSignal): Promise<Reply> {
    if (channel.closed || signal.aborted) return Promise.reject(unavailable());
    if (channel.pending.size >= 8 || channel.pending.has(command.id)) return Promise.reject(new CloudOperationError(409, 'worker_busy', 'The worker request is already in progress.'));
    return new Promise((resolve, reject) => {
      const done = (reply?: Reply, error?: Error) => {
        signal.removeEventListener('abort', abort); channel.pending.delete(command.id);
        if (reply) resolve(reply); else reject(error ?? unavailable());
      };
      const abort = () => done(undefined, unavailable());
      channel.pending.set(command.id, { resolve: reply => done(reply), reject: error => done(undefined, error) });
      signal.addEventListener('abort', abort, { once: true });
      try { channel.input.write(`${JSON.stringify(command)}\n`, error => { if (error) channel.dispose(); }); } catch { channel.dispose(); }
    });
  }
  async invoke(binding: CliBinding, command: Parameters<OrganizationWorkerTransport['invoke']>[1], signal: AbortSignal) {
    const channel = this.channels.get(binding.connectionId);
    if (!channel?.ready || channel.closed || channel.digest !== bindingDigest(binding)) throw unavailable();
    const reply = await this.send(channel, command, signal);
    return reply.ok ? { ok: true as const, result: reply.result } : { ok: false as const, code: reply.code };
  }
  detach(binding: CliBinding) {
    const channel = this.channels.get(binding.connectionId);
    if (!channel || channel.digest !== bindingDigest(binding)) throw unavailable();
    channel.dispose();
  }
  close() { for (const channel of this.channels.values()) channel.dispose(); }
}
