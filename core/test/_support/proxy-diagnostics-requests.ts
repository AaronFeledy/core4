import { expect } from "bun:test";

import { renderTraefikDiagnosticHtml } from "@lando/proxy-traefik";

import type { DiagnosticCase, DiagnosticRequest } from "./proxy-diagnostics-cases.ts";

export const TRAEFIK_WEB_PORT = 38086;
export const TRAEFIK_WEBSECURE_PORT = 38446;
export const BACKEND_CONTENT = "lando matched route backend\n";
const PLAIN_404_BODY = "404 page not found\n";

const requestPort = (scheme: DiagnosticRequest["scheme"]): number =>
  scheme === "https" ? TRAEFIK_WEBSECURE_PORT : TRAEFIK_WEB_PORT;

export const sendDiagnosticRequest = (request: DiagnosticRequest): Promise<Response> =>
  fetch(`${request.scheme}://127.0.0.1:${requestPort(request.scheme)}${request.path}`, {
    method: request.method,
    headers: { Host: request.host, ...(request.accept === undefined ? {} : { Accept: request.accept }) },
    ...(request.method === "POST" ? { body: "a=b" } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    // The fallback router serves Traefik's generated default certificate.
    tls: { rejectUnauthorized: false },
  });

export const waitForMatchedRoute = async (matchedHostname: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await sendDiagnosticRequest({
        scheme: "http",
        method: "GET",
        host: matchedHostname,
        path: "/",
      });
      // Wait for the app backend itself, not Traefik's startup 404.
      if (response.status === 200 && (await response.text()) === BACKEND_CONTENT) return;
      lastError = new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Traefik did not route to the matched backend within ${timeoutMs}ms: ${String(lastError)}`);
};

export const runDiagnosticCase = async (testCase: DiagnosticCase): Promise<void> => {
  const response = await sendDiagnosticRequest(testCase.request);
  const body = await response.text();
  const expectedBody = testCase.expected === "html" ? renderTraefikDiagnosticHtml() : PLAIN_404_BODY;
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe(
    testCase.expected === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
  );
  expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(expectedBody)));
  expect(body).toBe(testCase.request.method === "HEAD" ? "" : expectedBody);
};

export const expectMatchedRoutesWin = async (matchedHostname: string): Promise<void> => {
  for (const scheme of ["http", "https"] as const) {
    const response = await sendDiagnosticRequest({
      scheme,
      method: "GET",
      host: matchedHostname,
      path: "/",
      accept: "text/html",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BACKEND_CONTENT);
  }
};
