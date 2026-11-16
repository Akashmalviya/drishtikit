module.exports = {
  displayName: 'angular',
  rootDir: '.',
  preset: 'jest-preset-angular',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  moduleNameMapper: { '^@drishtikit/browser$': '<rootDir>/../browser/src/index.ts', '^(\\.{1,2}/.*)\\.js$': '$1' },
};
