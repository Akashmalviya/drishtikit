/** Shared Jest settings. Tests run on the TypeScript source, so no build is needed first. */
const base = {
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.json', isolatedModules: true, diagnostics: false }] },
  moduleNameMapper: {
    '^@drishtikit/(core|mongo|nest|browser)$': '<rootDir>/../../packages/$1/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
};

module.exports = {
  projects: [
    { ...base, displayName: 'core', rootDir: 'packages/core', testEnvironment: 'node' },
    { ...base, displayName: 'mongo', rootDir: 'packages/mongo', testEnvironment: 'node', testTimeout: 60000 },
    { ...base, displayName: 'nest', rootDir: 'packages/nest', testEnvironment: 'node', testTimeout: 60000 },
    { ...base, displayName: 'browser', rootDir: 'packages/browser', testEnvironment: 'jsdom' },
    '<rootDir>/packages/angular/jest.config.js',
  ],
};
