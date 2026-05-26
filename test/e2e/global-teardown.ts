import { execSync } from 'node:child_process';
import { closePools } from './helpers';

export default async function () {
  await closePools();
  console.log('\nE2E: docker compose down …');
  execSync('docker compose down -v', {
    cwd: process.cwd(),
    stdio: 'inherit',
    timeout: 60_000,
  });
}
