# Optional local Docker worker driver

2026-10-10. The company API library exports `DockerOrganizationWorkerProvisioner`, `dockerWorkerEngine`, `createLocalDockerWorkerEngine` and their configuration/port types. This is an opt-in source implementation, verified with synthetic commands, temporary SQLite stores, private Node streams and a separate local child-process test. **No Docker CLI/socket, image build, physical isolation or company SSO has been verified.** The default app/cloud loaders do not activate it.

## Server-owned configuration

The strict `dockerWorkerConfigSchema` accepts only:

| Field | Contract |
|---|---|
| `executable` | Absolute, normalized Docker CLI path |
| `socketPath` | Absolute local Unix socket path; no remote context/TCP selection |
| `metadataRoot` | Canonical private directory owned by the supervisor user; parent must already exist |
| `daemonId` | Explicit expected daemon identity; checked before and after commands |
| `imageId` | Existing local immutable `sha256:` image ID; `--pull=never` |
| `network` | Server-selected existing network; `host`, `bridge` and `default` rejected |

Paths reject control characters, commas and normalization changes. Configuration comes from trusted composition, never an HTTP request. A network name does not establish an egress policy: DNS, proxy/CA, destination restrictions and peer isolation must be verified in the actual runtime. This driver does not provision networks or accept arbitrary proxy/environment/mount fields.

`createLocalDockerWorkerEngine(config)` returns `undefined` before parsing config or accessing the filesystem unless `CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1` and `CLOUDOPS_OFFLINE_TEST` is not `1`. Each native operation rechecks those flags. The flag alone creates no runtime, listener or worker. The factory captures a fixed process environment without host AWS credentials or Docker contexts; commands use argument arrays and `shell:false`.

Trusted composition supplies the engine to `new DockerOrganizationWorkerProvisioner({store, leases, config, engine})`, then supplies that provisioner to the supervisor/runtime factory. The driver and supervisor must use the same durable store and compatible lease clock/configuration. See the [supervisor composition](README.md#supervisor-and-provisioner-composition). There is no browser-selectable driver or shared-host AWS CLI fallback.

## Fixed container and private data

The driver separates creation, start and private attachment. Docker `create` does not start the process; `--interactive` preserves stdin for the later controller connection. [Docker create reference](https://docs.docker.com/reference/cli/docker/container/create/)

- Fixed UID/GID `10001:10001`, read-only root, all capabilities dropped, no privilege escalation, private IPC, no restart/healthcheck, no published ports/devices/socket mount.
- CPU `0.25`, memory and total memory/swap limit `256 MiB`, process limit `64`, `log-driver=none`. stdout is the private protocol, not a log destination.
- `binding.json` and `lease.json` are immutable read-only binds. Their parent directory is `0700`; files are `0444` so container UID 10001 can read noncredential configuration. The host Docker client config is an empty `0600` auth map. Existing mismatched files, symlinks or hardlinks are rejected.
- The cache at `/home/cloudops-worker/.aws` and `/tmp` use separate bounded `16 MiB` tmpfs mounts with UID/GID 10001 and mode 0700. No host `.aws` or shared/persistent named cache volume is mounted. A new generation must log in again. Tmpfs is not proof of secure disk erasure; host swap/storage policy remains a separate check. [Docker tmpfs behavior](https://docs.docker.com/engine/storage/tmpfs/)
- The private CLI attachment uses `--sig-proxy=false`; the supervisor owns its lifecycle. Native stderr is drained with a byte limit and never persisted as a log. Stream errors terminate the owned attachment. Close waits for the child close event for up to two seconds; missing confirmation rejects instead of attesting. The provisioning request's abort signal stops governing a successfully attached pipe; subsequent teardown is explicit. [Docker attach reference](https://docs.docker.com/reference/cli/docker/container/attach/)

Inspection validates the full container ID, pinned image/daemon, binding/config/lease/generation/supervisor/cache labels, runtime limits and mount set. A mismatch fails closed before start or removal. Noncredential binding/lease metadata remains on disk after retirement; automatic metadata retention/cleanup is not implemented. Do not publish it as a report or copy it into source candidates.

## Durable lifecycle and uncertain results

Every create/start/remove attempt records an intent before external work. Retryable store callbacks never call Docker or write metadata files. The durable record is keyed by lease UUID and binds the full allocation and configuration digest.

| Condition | Result |
|---|---|
| Repeated provisioning, including another process | Reject; do not repeat create/start |
| Fence before provisioning starts | Persist a tombstone; future provisioning for that lease is rejected |
| Fence while create/start is pending | Block further progression; remove a known owned ID when possible, but withhold retirement |
| Lost or interrupted create/start confirmation | Remain unknown, including after restart or an absent-container observation; no automatic retry |
| Late confirmed intent after cancellation | Reconcile targeted cleanup on both fulfilled and rejected provisioning responses; never attach a late pipe |
| Known ID removed and absent, with all create/start intents confirmed | Persist retirement, then return the matching stop/cache-access receipt |
| Unknown create with no confirmed ID | No blind name lookup/removal; explicit operator investigation is required |

Shutdown tracks cleanup initiated by late rejected responses as well as ordinary teardown. An attachment close failure still attempts removal of its known container, retains the local pipe for explicit cleanup and withholds retirement confirmation. A timed-out cleanup remains unknown. Receipts rely on the trusted engine port and have only synthetic evidence here; they do not prove OS isolation, physical cache revocation or AWS session invalidation.

## Validation and next integration

`server/organization-worker-docker.test.ts` covers fixed commands, two-controller races, persistent fencing/reopen, interrupted and late responses, identity/runtime tampering, A/B separation, transaction rollback/retry, private metadata and supervisor shutdown. Its Docker command transport is synthetic; temporary files/SQLite and Node streams are real local test resources.

`server/organization-worker-process.test.ts` separately verifies the native process primitive with local Node children: literal arguments/private bytes, explicit environment, spawn failure/cancellation, persistent attachment, stderr limits, early exit and pipe errors. A fake child that never confirms termination verifies the bounded failure. All eight pass; they do not launch Docker or access its socket. The guarded engine remains disabled in these offline tests.

After the existing Docker authorization is resolved, build the pinned image, compare real inspect shapes and tmpfs permissions, verify bounded Docker attach/termination and two users' cache/login/logout isolation. Company web identity, SSO assignments, durable hosted storage and network policy remain separate requirements. Local process success is not Docker/container evidence.
