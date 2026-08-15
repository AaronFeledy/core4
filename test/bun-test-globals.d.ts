import type * as BunTest from "bun:test";

declare global {
  const afterAll: typeof BunTest.afterAll;
  const afterEach: typeof BunTest.afterEach;
  const beforeAll: typeof BunTest.beforeAll;
  const beforeEach: typeof BunTest.beforeEach;
  const describe: typeof BunTest.describe;
  const expect: typeof BunTest.expect;
  const it: typeof BunTest.it;
  const jest: typeof BunTest.jest;
  const mock: typeof BunTest.mock;
  const setSystemTime: typeof BunTest.setSystemTime;
  const spyOn: typeof BunTest.spyOn;
  const test: typeof BunTest.test;
  const vi: typeof BunTest.vi;
}
