import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";

import {
  type ErrorPageCase,
  PATHINFO_OK,
  PHAR_EXECUTED,
  apacheCases,
  nginxFpmCases,
  phpFixtureFiles,
  staticCases,
  staticFixtureFiles,
} from "./support/http-error-pages-cases.ts";
import {
  type ErrorPageServer,
  type ErrorPageStack,
  runErrorPageCase,
  startErrorPageStack,
} from "./support/http-error-pages-live.ts";

const socketPath = resolveLiveProviderSocket()?.socketPath;

const suites: ReadonlyArray<{
  readonly server: ErrorPageServer;
  readonly files: Readonly<Record<string, string>>;
  readonly cases: ReadonlyArray<ErrorPageCase>;
}> = [
  { server: "static", files: staticFixtureFiles, cases: staticCases },
  { server: "nginx-fpm", files: phpFixtureFiles, cases: nginxFpmCases },
  { server: "apache", files: phpFixtureFiles, cases: apacheCases },
];

// Given: each Lando-owned web server generator running its planned start
// command against an app root that exercises missing files, index-less
// directories, normal assets, and app-owned 403/404 responses.
for (const suite of suites) {
  describe.skipIf(socketPath === undefined)(`${suite.server} error pages — live integration`, () => {
    let stack: ErrorPageStack | undefined;

    beforeAll(async () => {
      expect(socketPath).toBeTruthy();
      stack = await startErrorPageStack({
        socketPath: socketPath ?? "",
        server: suite.server,
        files: suite.files,
        request: fetch,
      });
    }, 600_000);

    afterAll(async () => {
      await stack?.stop();
    }, 120_000);

    for (const testCase of suite.cases) {
      test(testCase.name, async () => {
        if (stack === undefined) throw new Error(`${suite.server} stack did not start`);
        await runErrorPageCase(stack, testCase);
      }, 30_000);
    }

    if (suite.server === "static") return;

    test("PATH_INFO for /pathinfo.php/one/two is /one/two", async () => {
      if (stack === undefined) throw new Error(`${suite.server} stack did not start`);
      const response = await stack.request(`${stack.baseUrl}/pathinfo.php/one/two`, {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(PATHINFO_OK);
      expect(body).toMatch(/^PATH_INFO=\/one\/two$/m);
    }, 30_000);

    test("bare /pathinfo.php does not invent PATH_INFO", async () => {
      if (stack === undefined) throw new Error(`${suite.server} stack did not start`);
      const response = await stack.request(`${stack.baseUrl}/pathinfo.php`, {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain(PATHINFO_OK);
      expect(body).toMatch(/^PATH_INFO=$/m);
      expect(body).not.toMatch(/^PATH_INFO=\/.+/m);
    }, 30_000);

    if (suite.server !== "nginx-fpm") return;

    test("does not execute /uploads/x.phar/y.php", async () => {
      if (stack === undefined) throw new Error(`${suite.server} stack did not start`);
      const response = await stack.request(`${stack.baseUrl}/uploads/x.phar/y.php`, {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).not.toContain(PHAR_EXECUTED);
      expect(body).not.toContain(PATHINFO_OK);
    }, 30_000);
  });
}
