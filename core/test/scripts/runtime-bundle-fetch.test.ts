import { describe, expect, test } from "bun:test";
import {
  RUNTIME_BUNDLE_FETCH_ATTEMPTS,
  RuntimeBundleDownloadError,
  debianMetadataCopyrightFallbacks,
  fetchOverHttps,
} from "../../../scripts/runtime-bundle-fetch.ts";

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

describe("Debian metadata copyright fallbacks", () => {
  const pin =
    "https://metadata.ftp-master.debian.org/changelogs/main/g/glibc/glibc_2.41-12+deb13u5_copyright";
  const historical = "https://sources.debian.org/data/main/g/glibc/2.41-12%2Bdeb13u5/debian/copyright";
  const payload = new TextEncoder().encode("debian-copyright");
  const noSleep = async (): Promise<void> => {};

  test("maps ftp-master copyright URLs onto sources.debian.org for the exact version", () => {
    expect(debianMetadataCopyrightFallbacks(pin)).toEqual([historical]);
    expect(
      debianMetadataCopyrightFallbacks(
        "https://metadata.ftp-master.debian.org/changelogs/main/c/catatonit/catatonit_0.2.1-2_copyright",
      ),
    ).toEqual(["https://sources.debian.org/data/main/c/catatonit/0.2.1-2/debian/copyright"]);
    expect(debianMetadataCopyrightFallbacks("https://example.test/glibc_2.41-12+deb13u5_copyright")).toEqual(
      [],
    );
  });

  test("uses the historical debian/copyright when ftp-master has rotated the pin", async () => {
    const calls: string[] = [];
    const bytes = await fetchOverHttps(pin, {
      sleep: noSleep,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url === pin) return new Response(null, { status: 404 });
        expect(url).toBe(historical);
        return new Response(payload, { status: 200 });
      },
    });
    expect(calls).toEqual([pin, historical]);
    expect(bytes).toEqual(payload);
  });

  test("keeps the original pin URL when ftp-master and the historical copy are both gone", async () => {
    const calls: string[] = [];
    await expect(
      fetchOverHttps(pin, {
        sleep: noSleep,
        fetchImpl: async (url) => {
          calls.push(url);
          return new Response(null, { status: 404 });
        },
      }),
    ).rejects.toMatchObject({ status: 404, url: pin, name: "RuntimeBundleDownloadError" });
    expect(calls).toEqual([pin, historical]);
  });

  test("does not fall back to sources.debian.org on a ftp-master 500", async () => {
    const calls: string[] = [];
    await expect(
      fetchOverHttps(pin, {
        sleep: noSleep,
        fetchImpl: async (url) => {
          calls.push(url);
          return new Response(null, { status: 500 });
        },
      }),
    ).rejects.toMatchObject({ status: 500, url: pin, name: "RuntimeBundleDownloadError" });
    expect(calls).toEqual(Array.from({ length: RUNTIME_BUNDLE_FETCH_ATTEMPTS }, () => pin));
  });

  test("does not fall back to sources.debian.org on a ftp-master network error", async () => {
    const calls: string[] = [];
    await expect(
      fetchOverHttps(pin, {
        sleep: noSleep,
        fetchImpl: async (url) => {
          calls.push(url);
          throw new TypeError("socket hang up");
        },
      }),
    ).rejects.toThrow(/socket hang up/u);
    expect(calls).toEqual(Array.from({ length: RUNTIME_BUNDLE_FETCH_ATTEMPTS }, () => pin));
  });
});
