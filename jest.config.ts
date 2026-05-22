import type { Config } from 'jest';

const base = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/apps/', '<rootDir>/libs/'],
  moduleNameMapper: {
    '^@app/common(|/.*)$': '<rootDir>/libs/common/src/$1',
  },
} satisfies Config;

const config: Config = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      testRegex: '.*\\.spec\\.ts$',
    },
    {
      ...base,
      displayName: 'integration',
      testRegex: '.*\\.int-spec\\.ts$',
      globalSetup: '<rootDir>/test/setup/global-setup.ts',
      globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
      testTimeout: 60_000,
    },
  ],
  collectCoverageFrom: ['apps/**/*.ts', 'libs/**/*.ts'],
  coverageDirectory: './coverage',
};

export default config;
