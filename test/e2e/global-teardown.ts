import { execSync } from 'node:child_process';
import { closePools } from './helpers';

export default async function () {
  await closePools();
  console.log('\nE2E: docker compose down …');
  try {
    execSync('docker compose down -v --remove-orphans', {
      cwd: process.cwd(),
      stdio: 'inherit',
      timeout: 60_000,
    });
  } catch {
    /* container processes may exit non-zero during forced shutdown */
  }
}
