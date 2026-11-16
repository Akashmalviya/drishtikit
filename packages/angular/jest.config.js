module.exports = {
  displayName: 'angular',
  rootDir: '.',
  preset: 'jest-preset-angular',
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/setup-jest.ts'],
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  transform: { '^.+\\.(ts|js|mjs|html|svg)$': ['jest-preset-angular', { tsconfig: '<rootDir>/tsconfig.spec.json', stringifyContentPathRegex: '\\.(html|svg)$' }] },
  moduleNameMapper: { '^@drishtikit/browser$': '<rootDir>/../browser/src/index.ts', '^(\\.{1,2}/.*)\\.js$': '$1' },
};
