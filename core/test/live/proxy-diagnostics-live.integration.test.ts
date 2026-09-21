import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { resolveLiveProviderSocket } from "@lando/core/testing";

import { proxyDiagnosticCases } from "../_support/proxy-diagnostics-cases.ts";
import { expectMatchedRoutesWin, runDiagnosticCase } from "../_support/proxy-diagnostics-requests.ts";
import {
  type ProxyDiagnosticsStack,
  expectEmittedConfigPassesNginxTest,
  startProxyDiagnosticsStack,
} from "../_support/proxy-diagnostics-stack.ts";

const socketPath = resolveLiveProviderSocket()?.socketPath;

// Given: the rendered diagnostic nginx backend and fallback routers running
// beside one matched app route, exactly as `lando setup` installs them.
describe.skipIf(socketPath === undefined)("proxy diagnostics — live integration", () => {
  let stack: ProxyDiagnosticsStack | undefined;

  beforeAll(async () => {
    expect(socketPath).toBeTruthy();
    stack = await startProxyDiagnosticsStack(socketPath ?? "");
  }, 240_000);

  afterAll(async () => {
    await stack?.stop();
  }, 120_000);

  const running = (): ProxyDiagnosticsStack => {
    if (stack === undefined) throw new Error("proxy diagnostics stack did not start");
    return stack;
  };

  test("the emitted nginx configuration passes nginx -t inside the diagnostic image", async () => {
    await expectEmittedConfigPassesNginxTest(running());
  }, 30_000);

  test("matched app routes win over the fallback on both entrypoints", async () => {
    await expectMatchedRoutesWin(running().matchedHostname);
  }, 30_000);

  for (const testCase of proxyDiagnosticCases) {
    test(testCase.name, async () => {
      running();
      await runDiagnosticCase(testCase);
    }, 30_000);
  }
});
