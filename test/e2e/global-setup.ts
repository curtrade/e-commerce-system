import { execSync } from 'node:child_process';

const SERVICES = [
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
  console.log('\nE2E: docker compose up --build …');
  execSync('docker compose up -d --build', {
    cwd: process.cwd(),
    stdio: 'inherit',
    timeout: 300_000,
  });

  console.log('E2E: waiting for services …');
  await Promise.all(SERVICES.map((url) => waitForHealth(url)));
  console.log('E2E: all services healthy\n');
}
