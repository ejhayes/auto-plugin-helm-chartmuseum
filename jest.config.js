/** @type {import('ts-jest').JestConfigWithTsJest} */
// eslint-disable-next-line no-undef
module.exports = {
  collectCoverage: true,
  coverageReporters: ['lcov', 'text'],
  preset: 'ts-jest',
  testEnvironment: 'node',
}
