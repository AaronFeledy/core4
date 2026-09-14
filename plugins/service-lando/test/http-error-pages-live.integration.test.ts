import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";

import {
  type ErrorPageCase,
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
  });
}
