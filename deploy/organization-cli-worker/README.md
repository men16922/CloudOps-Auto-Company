# Organization AWS CLI worker

This is the isolated execution artifact for [Identity.md](../../Identity.md). It is **not yet a deployed multi-user authentication service**. Web identity/membership, durable connections/leases, the supervisor, generation-bound private pipes and an optional company composition factory are implemented and tested with synthetic providers. An optional local Docker driver now has durable intents and synthetic command tests. Real browser sign-in, native Docker/container isolation and live company SSO validation remain required.

For hosted execution, a trusted supervisor receives authenticated registry jobs and owns this child's private pipe. A remote browser cannot attach directly to container stdin. `createOrganizationWorkerRuntime` connects the registry, lease core, supervisor and injected provisioner; no physical driver is supplied by default. Deploying this image alone does not provide that service.

## Implemented boundary

- One immutable server-owned connection binding per worker, with a generated profile and SSO session name.
- A dedicated non-root Linux user with its own home, config, SSO token cache and AWS credential cache. The runtime rejects the shared API process and offline AWS calls.
- Device Code login through AWS CLI; fixed STS and bounded metadata reads: EC2, EKS (list, `describe-cluster-versions --include-all`, per-cluster `describe-cluster` within a 12 s budget), RDS, ElastiCache, MSK (`kafka list-clusters-v2`), CloudWatch alarms, Lambda, DynamoDB, and one `get-metric-data` call with fixed SEARCH expressions over standard AWS namespaces (last hour, 5-minute periods, worst 10 per metric). EKS names come from the worker's own list result and are validated; the metric window comes from the worker clock. No arbitrary command, endpoint, profile or credential request field.
- A service-level denial/throttle/timeout with unchanged before/after STS identity fails only that read (`read_*`); a changed identity still invalidates the session. A metric series with data but an unresolvable resource label fails closed.
- Account/Identity Center role validation after login, exact principal checks before/after reads, cancellation, bounded output/time and safe errors.
- A private JSON-lines stdin/stdout protocol for a trusted controller. **Do not expose or proxy this pipe to a browser.** The controller must verify web identity, current organization membership and connection ownership for every request.
- Disconnect retains this worker's cache; logout removes SSO caches in this worker. Previously issued IAM sessions may still remain valid. No cache is imported from the developer's `~/.aws`.

## Build and runtime contract

`npm run build:cli-worker` produces the standalone `dist-worker/worker.mjs` bundle. The local `make check` includes this build. The final artifact imports neither the demo service nor the personal AWS startup, Firebase or SSO SDK.

The Dockerfile pins AWS CLI **2.30.1**, matching the installed CLI whose `PrintOnlyHandler` was inspected for the synthetic parser fixture. Node is pinned to 24.19.0. The container recipe has **not been built or verified**: automatic approval review rejected Docker inspection as outside the permitted infrastructure scope. Successful JavaScript bundling is not container/runtime evidence.

When the deployment environment is authorized and ready, build from the repository root:

```sh
docker build -f deploy/organization-cli-worker/Dockerfile -t cloudops-organization-cli:local .
```

The Dockerfile-specific ignore file restricts the build context to the worker source and dependency manifests. The final stage contains the bundled worker and CLI, not the repo, host configuration or tokens. Runtime requirements:

| Resource | Required configuration |
|---|---|
| `/run/cloudops/binding.json` | Read-only trusted binding; use the schema in `server/modules/aws/organization/organization-cli-contract.ts`. No tokens or access keys |
| `/run/cloudops/lease.json` | Read-only supervisor allocation handle, matching the entire binding digest and generation; required by the standalone worker bootstrap |
| `/home/cloudops-worker/.aws` | One private writable mount for this connection; UID/GID 10001, directories 0700 and files 0600. The optional local driver uses ephemeral tmpfs; persistent cache restoration is not implemented |
| Root filesystem | Read-only, with a bounded temporary filesystem if needed; drop capabilities and disallow privilege escalation |
| Network | Approved IdP/SSO/STS and selected AWS APIs; company proxy/CA may be passed through approved environment settings |
| stdout/stderr | stdout belongs to the private controller transport and can contain user codes/resource results. Do not copy it to public/shared container logs. stderr is sanitized |
| Lifecycle | One active worker per binding/lease; no cross-user volume reuse. Shutdown cancels work. Restart begins disconnected and requires explicit verification/login |

The bootstrap records a binding digest beside its own configuration. It rejects a different binding or modified config/credentials rather than overwriting an existing cache. This detects accidental remount/reassignment; it is not a substitute for OS/container/storage isolation.

## Internal protocol

Commands are strict JSON objects terminated by a newline. An `id` must be a UUID. Only `status`, `login`, `verify`, `inspect`, `directory`, `disconnect`, `logout`, `sync`, `sync-status` and `sync-unit` are supported. Only `inspect` accepts `service` (one of the fixed read services in `connectionServices`); only `directory` accepts a worker-issued cursor UUID; only `sync-unit` accepts a unit UUID from this worker's own sync. Security Hub "not enabled" and AWS Health "support plan required" are reported as the states `read_not_enabled` and `read_not_subscribed`, not as session failures. All account/role/region/profile values come from the mounted binding.

```json
{"id":"33333333-3333-4333-8333-333333333333","operation":"status"}
```

Responses contain `id`, `bindingDigest`, `allocation`, `ok`, and `result` or a safe `code`. `allocation` is the handle mounted at bootstrap, never a value accepted from an incoming command. The supervisor requires it on the handshake and every reply; a different generation/resource/cache/supervisor or missing stamp closes that pipe. Low-level legacy synthetic router tests may omit allocation, but they cannot attach to the supervisor path. Login returns immediately; request status with a new request ID until it reaches a terminal state. A product deadline is not claimed to be the AWS device-code expiration. Reused IDs with changed contents are rejected; identical requests replay within the same worker. The connection registry supplies durable command reservations and unknown results. The provisioner must enforce physical fencing across replicas.

## Durable allocation contract

`OrganizationWorkerLeases` is exported by the company API library and uses the injected `CloudStore`. It does not start a process. `OrganizationWorkerSupervisor` implements the private transport and generates a fresh UUID per process incarnation. SQLite is the local verification adapter; hosted deployments require an external durable store.

| Operation | Persisted behavior |
|---|---|
| `read(binding)` | No allocation or renewal. Expiry or a clock rollback quarantines an active generation as `unknown` |
| `claim(binding, supervisorId, requestId)` | Atomically reserves a generation and random resource/cache keys. Only a committed `created:true` permits a new provisioning attempt; a replay always returns `created:false`, including uncertain/retired states |
| `ready(binding, handle, receipt)` | Requires the complete allocation identity and a trusted provisioner receipt. Late or mismatched confirmation cannot revive an unknown generation |
| `assertActive` / `renew` | Exact owner/generation checks. Only explicit renewal extends a live lease; default 60 seconds, configurable 10–300 seconds |
| `quarantine` / `retire` | Deny new work, then require matching termination **and** cache-access revocation attestations. Expiry alone never permits reallocation |

The handle includes the full binding digest, connection, supervisor, generation, lease ID and resource/cache keys. Every new generation gets fresh keys; cache restoration is not implemented. Claim/lease writes commit together; retryable transaction callbacks contain no external work. Rejected expiry checks still commit quarantine. Clocks that regress behind a retired generation also prevent a new claim.

Receipts belong to a trusted provisioner, **never a browser or child-worker JSON reply**. Their booleans are contractual attestations, not evidence of physical isolation. The supervisor now checks membership/configuration revision and lease before/after provisioning and commands, connects a separate router to each generation, quarantines lost owners and rejects late replies. The lease core's 18 storage tests and supervisor's 21 tests (including two nested stamp cases) are synthetic; no physical worker or company SSO runs. [Implementation and next step](../../docs/plans/2026-10-10-organization-worker-supervisor.md)

## Supervisor and provisioner composition

Use the company's API-library exports with its own verified web identity/store:

```ts
const runtime = createOrganizationWorkerRuntime({
  store, access, configurations: trustedAccountConfigurations,
  provisioner: companyInfrastructureDriver, // Explicit injection; no enabled default or shared CLI fallback.
});
const server = createOrganizationApiServer({ access, connections: runtime.connections, publicOrigin });
// The hosting process owns server.listen(), TLS and an awaited shutdown:
// stop accepting HTTP work, then await runtime.supervisor.close().
```

- `OrganizationConnections` authenticates each request and owns durable command reservations/replay. `workerAuthorization` is a trusted lifecycle check of the stored connection, current configuration and active membership version/roles; it is not a replacement web login endpoint.
- Only an explicit `login` with a committed new claim calls `provision`. Status, verification, listing and retry never create workers. Missing provisioners reject as unavailable without reserving a new lease.
- `provision({binding,handle}, signal)` must create only that fixed allocation, mount its binding/lease, enforce its private cache and return private pipes plus a matching ready receipt. The supervisor checks the pipe's own allocation stamp before dispatching login.
- `fenceAndStop({binding,handle}, signal)` must prevent pending/late creation for that lease ID, terminate its process and revoke cache access **before** returning the retirement receipt. A kill request, timeout or missing local handle is insufficient. A failed/invalid receipt leaves durable unknown; explicit trusted `supervisor.stop(binding)` can reconcile it later. Status/login never take over an abandoned allocation automatically.
- Heartbeats run every 5 seconds by default and renew only after current membership/configuration and lease checks. `heartbeatIntervalMs:0` is for an explicitly managed loop/tests. The host needs an always-running lifecycle process; do not rely on Cloud Run continuing background work after an HTTP response. Web logout remains separate from AWS logout. A version/role change or absent membership stops the old worker on the next guard/heartbeat.
- Request/provisioner waits are bounded to 25 seconds by default. Stop has an independent cleanup deadline; late provision responses cannot attach. Shutdown cancels requests and awaits tracked cleanup, including entries already removed from routing. Failed cleanup remains unknown and needs reconciliation.
- The base app/cloud loaders do not silently enable this factory or a physical driver. The API factory is injected in the company composition. Docker/OS cache and network policy must be validated separately.

## Evidence and next checks

Offline tests exercise two users, ownership boundaries, state races, changed STS identity, child termination/output limits, configuration tampering and the controller pipe. Synthetic credentials are never sent to AWS. Tests do not establish container isolation, company authorization or live AWS login.

The recipe's missing build-policy/directory/lease sources and COPY paths were corrected. A separate source-only tree contained all 14 required inputs and bundled with existing offline dependencies; private data/startup/other providers were excluded. This is source-closure evidence, not a Docker build or Linux runtime check.

The [optional local Docker driver](docker-driver.md) now persists create/start/remove intents, fences late work, validates pinned container configuration and uses per-container ephemeral caches. Its 32 new synthetic checks include late rejected replies and shutdown reconciliation. Eight additional tests exercise the native attachment primitive with local Node children/injected process behavior, including pipe errors and unconfirmed termination. Actual Docker execution remains unverified. After existing authorization, build/inspect the image, check CLI/home/UID/permissions and validate two users' login, logout and restart against a configured test portal.
