import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { identityActor } from './cloud-auth';
import { SqliteCloudStore } from './cloud-sqlite-store';
import { DynamoDbCloudStore, environmentCredentials } from './cloud-dynamodb-store';
import { deploymentSummary, dockerProvisionerFromConfig, provisionLocalMembership, reconcileLocalWorker, startLocalOrganizationHost } from './organization-local-host';

const usage = `CloudOps Auto local organization host (loopback verification only; not a production server)

  serve                                   Same-origin web build + organization API on loopback.
  actor --issuer <url> --subject <sub> [--tenant <id>]
                                          Print the actorId a verified OIDC identity maps to.
  provision-membership <membership.json>  Trusted bootstrap of a versioned membership into the local store.
  check-deployment <deployment.json> [oidc-verifier.json]
                                          Validate trusted files together and print a redacted summary.
  reconcile-worker <connectionId> [--investigated-container <id>]
                                          After an ungraceful exit: fence/remove an expired worker and retire its
                                          lease (needs CLOUDOPS_DOCKER_WORKER_CONFIG and the Docker enable flag). The
                                          investigated ID is only for a create whose confirmation was lost.

Environment
  CLOUDOPS_DEPLOYMENT    trusted deployment JSON (publicOrigin/web/connections). Absent: unconfigured.
  CLOUDOPS_WEB_IDENTITY  OIDC verifier JSON. Absent: the API stays unconfigured (fail closed).
  CLOUDOPS_LOCAL_STORE   SQLite test-adapter path (default .data/organization-local.sqlite).
  CLOUDOPS_DYNAMODB_STORE  optional DynamoDB store JSON {tableName, region, endpoint?}; credentials come only from
                         AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY[/AWS_SESSION_TOKEN] (no CLI profile lookup).
  CLOUDOPS_LOCAL_HOST    127.0.0.1 or localhost (default 127.0.0.1).
  CLOUDOPS_LOCAL_PORT    default 5176.
  CLOUDOPS_WEB_ROOT      built web directory (default dist-company).
  CLOUDOPS_TLS_CERT_FILE / CLOUDOPS_TLS_KEY_FILE  optional PEM files; serve https (publicOrigin must be https://host:port).
  CLOUDOPS_DOCKER_WORKER_CONFIG  optional Docker driver config for an authorized isolation run; also requires
                         CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1. Absent: no provisioner, AWS login/inspect return worker_unavailable.`;

const readJson = (path: string) => JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
function openStore(): { transact: SqliteCloudStore['transact']; close(): void } {
  if (process.env.CLOUDOPS_DYNAMODB_STORE) {
    const store = new DynamoDbCloudStore(readJson(process.env.CLOUDOPS_DYNAMODB_STORE), { credentials: environmentCredentials() });
    return { transact: body => store.transact(body), close: () => undefined };
  }
  const path = resolve(process.env.CLOUDOPS_LOCAL_STORE ?? '.data/organization-local.sqlite');
  // Only directories created here get the private mode; an existing directory is left unchanged.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return new SqliteCloudStore(path);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'actor') {
    const { values } = parseArgs({ args: rest, options: { issuer: { type: 'string' }, subject: { type: 'string' }, tenant: { type: 'string' } }, strict: true });
    if (!values.issuer || !values.subject) throw new Error('--issuer and --subject are required.');
    console.log(identityActor(values.issuer, values.subject, values.tenant ?? ''));
  } else if (command === 'provision-membership' && rest.length === 1) {
    const store = openStore();
    try { const value = await provisionLocalMembership(store, readJson(rest[0]!)); console.log(`Provisioned membership version ${value.version} for ${value.organizationId}/${value.workspaceId}.`); }
    finally { store.close(); }
  } else if (command === 'reconcile-worker' && rest.length >= 1) {
    if (!process.env.CLOUDOPS_DOCKER_WORKER_CONFIG) throw new Error('CLOUDOPS_DOCKER_WORKER_CONFIG is required.');
    const { values, positionals } = parseArgs({ args: rest, options: { 'investigated-container': { type: 'string' } }, allowPositionals: true, strict: true });
    if (positionals.length !== 1) throw new Error('reconcile-worker takes exactly one connectionId.');
    const store = openStore();
    try { console.log(await reconcileLocalWorker(store, positionals[0]!, dockerProvisionerFromConfig(store, readJson(process.env.CLOUDOPS_DOCKER_WORKER_CONFIG)), undefined, values['investigated-container'])); }
    finally { store.close(); }
  } else if (command === 'check-deployment' && (rest.length === 1 || rest.length === 2)) {
    console.log(JSON.stringify(deploymentSummary(readJson(rest[0]!), rest[1] ? readJson(rest[1]) : undefined), null, 2));
  } else if (command === 'serve' && rest.length === 0) {
    const host = process.env.CLOUDOPS_LOCAL_HOST ?? '127.0.0.1', port = Number(process.env.CLOUDOPS_LOCAL_PORT ?? 5176);
    const scheme = process.env.CLOUDOPS_TLS_CERT_FILE ? 'https' : 'http';
    const deployment = process.env.CLOUDOPS_DEPLOYMENT ? readJson(process.env.CLOUDOPS_DEPLOYMENT) : { publicOrigin: `${scheme}://${host}:${port}`, web: { configured: false }, connections: [] };
    const webIdentity = process.env.CLOUDOPS_WEB_IDENTITY ? readJson(process.env.CLOUDOPS_WEB_IDENTITY) : undefined;
    const store = openStore();
    const provisioner = process.env.CLOUDOPS_DOCKER_WORKER_CONFIG ? dockerProvisionerFromConfig(store, readJson(process.env.CLOUDOPS_DOCKER_WORKER_CONFIG)) : undefined;
    const tls = process.env.CLOUDOPS_TLS_CERT_FILE && process.env.CLOUDOPS_TLS_KEY_FILE
      ? { cert: readFileSync(resolve(process.env.CLOUDOPS_TLS_CERT_FILE), 'utf8'), key: readFileSync(resolve(process.env.CLOUDOPS_TLS_KEY_FILE), 'utf8') } : undefined;
    const local = await startLocalOrganizationHost({ deployment, webIdentity, store, webRoot: process.env.CLOUDOPS_WEB_ROOT ?? 'dist-company', host, port, provisioner, tls });
    console.log(`Local organization host ${local.origin} (identity: ${local.signIn}, worker provisioner: ${provisioner ? 'docker' : 'none'}).`);
    const stop = () => { void local.close().finally(() => { store.close(); process.exit(0); }); };
    // SIGHUP arrives when a wrapping shell exits; workers must still be fenced and retired.
    process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGHUP', stop);
  } else {
    console.log(usage); process.exitCode = command === undefined || command === 'help' ? 0 : 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'The local organization command failed.');
  process.exitCode = 1;
}
