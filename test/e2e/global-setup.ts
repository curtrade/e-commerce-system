import { execSync } from 'node:child_process';

const E2E_SERVICES = ['orders', 'payments', 'inventory', 'notifications'];

const HEALTH_ENDPOINTS = [
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004',
];

async function waitForHealth(url: string, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      /* service not ready */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`${url}/health not healthy after ${timeoutMs}ms`);
}

export default async function () {
  const cmd = `docker compose up -d --build ${E2E_SERVICES.join(' ')}`;
  console.log(`\nE2E: ${cmd} …`);
  try {
    execSync(cmd, {
      cwd: process.cwd(),
      stdio: 'inherit',
      timeout: 300_000,
    });
  } catch {
    console.error(
      '\nE2E: docker compose up failed — dumping container logs:\n',
    );
    try {
      execSync('docker compose logs --tail=80', {
        cwd: process.cwd(),
        stdio: 'inherit',
        timeout: 30_000,
      });
    } catch {
      /* best effort */
    }
    throw new Error('docker compose up failed (see logs above)');
  }

  console.log('E2E: waiting for services …');
  await Promise.all(HEALTH_ENDPOINTS.map((url) => waitForHealth(url)));
  console.log('E2E: all services healthy\n');
}
