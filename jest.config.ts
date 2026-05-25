import type { Config } from 'jest';

const base = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/apps/', '<rootDir>/libs/'],
  moduleNameMapper: {
    '^@app/common(|/.*)$': '<rootDir>/libs/common/src/$1',
    '^\\.prisma/client-orders$': '<rootDir>/node_modules/.prisma/client-orders',
    '^\\.prisma/client-payments$': '<rootDir>/node_modules/.prisma/client-payments',
    '^\\.prisma/client-inventory$': '<rootDir>/node_modules/.prisma/client-inventory',
    '^\\.prisma/client-notifications$': '<rootDir>/node_modules/.prisma/client-notifications',
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
