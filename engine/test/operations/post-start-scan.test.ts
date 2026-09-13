import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ScannerError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";
import type { AppPlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import type { EventServiceShape, ScanEndpoint, ScanResult, UrlScannerShape } from "@lando/sdk/services";

import { appendScanPath, runPostStartScan, startupScanUrls } from "../../src/operations/post-start-scan.ts";

const appId = AppId.make("scan-demo");
const plan = { id: appId, services: {} } as unknown as AppPlan;

type PublishedEvent = Parameters<EventServiceShape["publish"]>[0];

const collector = () => {
  const published: PublishedEvent[] = [];
  return {
    published,
    publish: (event: PublishedEvent) => Effect.asVoid(Effect.sync(() => void published.push(event))),
  };
};

const warnBody = (event: PublishedEvent | undefined): string =>
  (event as unknown as { readonly body?: string } | undefined)?.body ?? "";

const endpoint = (overrides: Partial<ScanEndpoint>): ScanEndpoint => ({
  service: ServiceName.make("web"),
  url: "http://localhost:8080/",
  reachable: true,
  outcome: "green",
  ...overrides,
});

const scannerReturning = (
  endpoints: ReadonlyArray<ScanEndpoint>,
  seen: {
    appId?: AppId;
    plan?: AppPlan | undefined;
    urls?: ReadonlyArray<{ readonly service: ServiceName; readonly url: string }>;
  },
): UrlScannerShape => ({
  id: "stub",
  scan: (id, options) =>
    Effect.sync((): ScanResult => {
      seen.appId = id;
      seen.plan = options?.plan;
      if (options?.urls !== undefined) seen.urls = options.urls;
      return { appId: id, endpoints };
    }),
  detectCollisions: () => Effect.succeed([]),
});

const failingScanner = (): UrlScannerShape => ({
  id: "stub",
  scan: () => Effect.fail(new ScannerError({ message: "scan blew up", scannerId: "stub" })),
  detectCollisions: () => Effect.succeed([]),
});

describe("runPostStartScan", () => {
  test("stays silent when every scanned endpoint passes", async () => {
    const events = collector();
    const seen: { appId?: AppId; plan?: AppPlan | undefined } = {};
    await Effect.runPromise(
      runPostStartScan({ scanner: scannerReturning([endpoint({})], seen), plan, events }),
    );
    expect(events.published).toHaveLength(0);
  });

  test("hands the plan to the scanner so per-service settings apply", async () => {
    const events = collector();
    const seen: { appId?: AppId; plan?: AppPlan | undefined } = {};
    await Effect.runPromise(
      runPostStartScan({ scanner: scannerReturning([endpoint({})], seen), plan, events }),
    );
    expect(seen.appId).toBe(appId);
    expect(seen.plan).toBe(plan);
  });

  test("forwards supplied startup urls to the scanner", async () => {
    const events = collector();
    const seen: {
      appId?: AppId;
      plan?: AppPlan | undefined;
      urls?: ReadonlyArray<{ readonly service: ServiceName; readonly url: string }>;
    } = {};
    const urls = [{ service: ServiceName.make("web"), url: "https://web.demo.lndo.site/" }];
    await Effect.runPromise(
      runPostStartScan({ scanner: scannerReturning([endpoint({})], seen), plan, events, urls }),
    );
    expect(seen.urls).toEqual(urls);
  });

  test("warns once per endpoint that did not pass", async () => {
    const events = collector();
    const seen: { appId?: AppId; plan?: AppPlan | undefined } = {};
    const scanner = scannerReturning(
      [
        endpoint({}),
        endpoint({ url: "http://localhost:8081/", outcome: "yellow", detail: "HTTP 500" }),
        endpoint({
          service: ServiceName.make("api"),
          url: "http://localhost:8082/",
          reachable: false,
          outcome: "red",
          detail: "timeout after 5s",
        }),
      ],
      seen,
    );
    await Effect.runPromise(runPostStartScan({ scanner, plan, events }));
    expect(events.published).toHaveLength(2);
    const bodies = events.published.map((event) => warnBody(event));
    expect(bodies[0]).toContain("http://localhost:8081/");
    expect(bodies[0]).toContain("HTTP 500");
    expect(bodies[1]).toContain("api");
    expect(bodies[1]).toContain("timeout after 5s");
    expect(events.published.every((event) => event._tag === "message.warn")).toBe(true);
  });

  test("warns once and never fails when the scan itself fails", async () => {
    const events = collector();
    const result = await Effect.runPromise(
      Effect.either(runPostStartScan({ scanner: failingScanner(), plan, events })),
    );
    expect(result._tag).toBe("Right");
    expect(events.published).toHaveLength(1);
    expect(warnBody(events.published[0])).toContain("scan blew up");
  });

  test("succeeds even when publishing the warning fails", async () => {
    const seen: { appId?: AppId; plan?: AppPlan | undefined } = {};
    const scanner = scannerReturning([endpoint({ reachable: false, outcome: "red" })], seen);
    const events: Pick<EventServiceShape, "publish"> = {
      publish: () => Effect.die(new Error("bus down")),
    };
    const result = await Effect.runPromise(Effect.either(runPostStartScan({ scanner, plan, events })));
    expect(result._tag).toBe("Right");
  });
});

describe("startupScanUrls", () => {
  test("joins scanner paths onto published and routed bases", () => {
    const urls = startupScanUrls(
      {
        ...plan,
        services: {
          web: { scanner: { enabled: true, path: "/ready", okCodes: [], retries: 0, timeoutMs: 1000 } },
        },
      } as unknown as AppPlan,
      [{ name: "web", endpoints: ["http://localhost:8080", "https://web.demo.lndo.site:4443"] }],
    );
    expect(urls.map((row) => row.url)).toEqual([
      "http://localhost:8080/ready",
      "https://web.demo.lndo.site:4443/ready",
    ]);
    expect(appendScanPath("https://web.demo.lndo.site/api", "/")).toBe("https://web.demo.lndo.site/api/");
  });
});
