import { describe, expect, test } from "bun:test";
import { RuntimeBundleDownloadError, fetchOverHttps } from "../../../scripts/runtime-bundle-fetch.ts";

describe("fetchOverHttps terminal failures", () => {
  const url = "https://example.test/runtime-artifact.tar.gz";

  for (const phase of ["fetch", "body"] as const) {
    test(`includes artifact context and retains the final cause when ${phase} fails on every attempt`, async () => {
      // Given
      const failures = Array.from(
        { length: 4 },
        (_, index) => new TypeError(`${phase} connection reset on attempt ${index + 1}`),
      );
      const delays: number[] = [];
      let calls = 0;
      let terminalCause: Error | undefined;
      let failure: unknown;

      // When
      try {
        await fetchOverHttps(url, {
          fetchImpl: async () => {
            const cause = failures[calls];
            if (cause === undefined) throw new Error("unexpected extra attempt");
            calls += 1;
            terminalCause = cause;
            if (phase === "fetch") throw cause;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(cause);
                },
              }),
            );
          },
          sleep: async (ms) => {
            delays.push(ms);
          },
        });
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause;
        failure = cause;
      }

      // Then
      expect(calls).toBe(4);
      expect(delays).toEqual([250, 500, 1000]);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("expected download failure");
      expect(failure.message).toContain(url);
      expect(failure.message).toContain(`${phase} connection reset on attempt 4`);
      expect(failure.cause).toBe(terminalCause);
    });
  }

  for (const status of [404, 429, 503]) {
    test(`preserves HTTP error semantics when the server returns ${status}`, async () => {
      // Given
      const delays: number[] = [];
      let calls = 0;
      let failure: unknown;

      // When
      try {
        await fetchOverHttps(url, {
          fetchImpl: async () => {
            calls += 1;
            return new Response(null, { status });
          },
          sleep: async (ms) => {
            delays.push(ms);
          },
        });
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause;
        failure = cause;
      }

      // Then
      expect(calls).toBe(status === 404 ? 1 : 4);
      expect(delays).toEqual(status === 404 ? [] : [250, 500, 1000]);
      expect(failure).toBeInstanceOf(RuntimeBundleDownloadError);
      expect(failure).toMatchObject({
        name: "RuntimeBundleDownloadError",
        url,
        status,
        message: `assemble-runtime-bundle: download failed (${status}) for ${url}`,
      });
      if (!(failure instanceof Error)) throw new Error("expected HTTP failure");
      expect(failure.cause).toBeUndefined();
    });
  }
});
