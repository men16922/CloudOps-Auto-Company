// Opt-in: start DynamoDB Local in Docker on loopback, run the CloudStore conformance and registry checks, stop it.
// NOT part of `make check`. No AWS account, credentials or network endpoint is used.
import { execFileSync, spawnSync } from 'node:child_process';
const image = process.env.CLOUDOPS_DYNAMODB_LOCAL_IMAGE ?? 'amazon/dynamodb-local@sha256:d89f8fcc6b1a39cb35976c248ed42a28c66ae00dc043099210f5571e42648ab4', port = process.env.CLOUDOPS_DYNAMODB_LOCAL_PORT ?? '18000';
const name = `cloudops-dynamodb-local-${process.pid}`;
execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', `127.0.0.1:${port}:8000`, image, '-jar', 'DynamoDBLocal.jar', '-inMemory'], { stdio: ['ignore', 'ignore', 'inherit'] });
try {
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) { try { await fetch(endpoint); break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); } }
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/opt-in/dynamodb-local.conformance.ts'], { stdio: 'inherit', env: { ...process.env, CLOUDOPS_DYNAMODB_LOCAL_ENDPOINT: endpoint, AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_PROFILE: '' } });
  process.exitCode = result.status ?? 1;
} finally { spawnSync('docker', ['stop', name], { stdio: 'ignore' }); }
