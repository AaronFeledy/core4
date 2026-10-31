import { describe, expect, test } from "bun:test";
import {
  AppRemoteEntry,
  AppRemoteMutationResult,
  DestroyAppResult,
  InfoAppResult,
  LandofileEventsOutcome,
  ServiceName,
  ShareStopAppResult,
  StartAppResult,
  StopAppResult,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
  Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" });

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, value: unknown): A => {
  const encoded = Schema.encodeUnknownSync(schema)(value, { onExcessProperty: "error" });
  return Schema.decodeUnknownSync(schema)(encoded, { onExcessProperty: "error" });
};

const startedService = { name: "web", state: "running" as const, connections: [] as const };

const infoService = {
  app: "demo",
  service: "web",
  api: 4 as const,
  type: "nginx",
  provider: "test",
  primary: true,
  status: "running" as const,
  connections: [] as const,
};

describe("LandofileEventsOutcome", () => {
  test("skipped requires reason", () => {
    expect(Result.isFailure(decode(LandofileEventsOutcome, { status: "skipped" }))).toBe(true);
    const encoded = { status: "skipped" as const, reason: "no landofile at applied root" };
    expect(roundTrip(LandofileEventsOutcome, encoded)).toEqual(encoded);
  });

  test("rejects unknown status", () => {
    expect(Result.isFailure(decode(LandofileEventsOutcome, { status: "pending" }))).toBe(true);
    expect(Result.isFailure(decode(LandofileEventsOutcome, { status: "failed", reason: "x" }))).toBe(true);
  });

  test("rejects excess properties", () => {
    expect(Result.isFailure(decode(LandofileEventsOutcome, { status: "ran", extra: true }))).toBe(true);
  });
});

describe("StartAppResult", () => {
  test("encode→decode round-trip preserves services and optional checks", () => {
    const withChecks = {
      app: "demo",
      servicesStarted: [startedService],
      checks: [
        {
          id: "http:web:http://localhost/",
          kind: "http" as const,
          service: Schema.decodeUnknownSync(ServiceName)("web"),
          url: "http://localhost/",
          verdict: "ready" as const,
        },
      ],
    };
    expect(roundTrip(StartAppResult, withChecks)).toEqual(withChecks);
  });

  test("rejects excess properties", () => {
    expect(
      Result.isFailure(
        decode(StartAppResult, { app: "demo", servicesStarted: [startedService], unexpected: 1 }),
      ),
    ).toBe(true);
  });
});

describe("StopAppResult", () => {
  test("outcome may be omitted or present", () => {
    const omitted = { app: "demo", servicesStopped: ["web"] };
    expect(roundTrip(StopAppResult, omitted)).toStrictEqual(omitted);

    for (const outcome of ["stopped", "unchanged"] as const) {
      const present = { app: "demo", outcome, servicesStopped: ["web"] };
      expect(roundTrip(StopAppResult, present)).toEqual(present);
    }
  });

  test("preserves landofileEvents when present", () => {
    const encoded = {
      app: "demo",
      outcome: "stopped" as const,
      servicesStopped: ["web"],
      landofileEvents: { status: "skipped" as const, reason: "landofile load failed" },
    };
    expect(roundTrip(StopAppResult, encoded)).toEqual(encoded);
  });

  test("rejects excess properties", () => {
    expect(Result.isFailure(decode(StopAppResult, { app: "demo", servicesStopped: [], extra: true }))).toBe(
      true,
    );
  });
});

describe("DestroyAppResult", () => {
  test("outcome may be omitted or present", () => {
    const omitted = {
      app: "demo",
      servicesDestroyed: ["web"],
      volumesRemoved: false,
      snapshotsRemoved: 0,
    };
    expect(roundTrip(DestroyAppResult, omitted)).toStrictEqual(omitted);

    for (const outcome of ["destroyed", "unchanged"] as const) {
      const present = { ...omitted, outcome };
      expect(roundTrip(DestroyAppResult, present)).toEqual(present);
    }
  });

  test("rejects excess properties", () => {
    expect(
      Result.isFailure(
        decode(DestroyAppResult, {
          app: "demo",
          servicesDestroyed: [],
          volumesRemoved: false,
          snapshotsRemoved: 0,
          extra: true,
        }),
      ),
    ).toBe(true);
  });
});

describe("InfoAppResult", () => {
  test("hostProxy is preserved through encode→decode", () => {
    const hostProxy = {
      runLando: { availability: "unavailable" as const, reason: "provider lacks container targets" },
    };

    const encoded = {
      app: "demo",
      services: [infoService],
      agentEnv: { enabled: true, forwarded: ["SSH_AUTH_SOCK"] },
      hostProxy,
    };
    expect(roundTrip(InfoAppResult, encoded)).toEqual(encoded);
  });

  test("rejects excess properties", () => {
    expect(
      Result.isFailure(decode(InfoAppResult, { app: "demo", services: [infoService], unexpected: true })),
    ).toBe(true);
  });
});

describe("ShareStopAppResult", () => {
  test("round-trips session acknowledgement without a redundant status", () => {
    const withProvider = { sessionId: "sess-1", provider: "ngrok" };
    expect(roundTrip(ShareStopAppResult, withProvider)).toEqual(withProvider);

    expect(Result.isFailure(decode(ShareStopAppResult, { sessionId: "sess-1", status: "ready" }))).toBe(true);
    expect(Result.isFailure(decode(ShareStopAppResult, { sessionId: "sess-1", status: "starting" }))).toBe(
      true,
    expect(Result.isFailure(decode(ShareStopAppResult, { sessionId: "sess-1", status: "stopped" }))).toBe(
      true,
    );
    );
  });

  test("rejects excess properties", () => {
    expect(Result.isFailure(decode(ShareStopAppResult, { sessionId: "sess-1", extra: 1 }))).toBe(true);
  });
});

describe("AppRemoteEntry and AppRemoteMutationResult", () => {
  test("preserve provider custom nested keys per RemoteConfig", () => {
    const config = {
      source: "pantheon",
      site: "site-id",
      nested: { token: "opaque", region: "us" },
      flags: ["a", "b"],
    };

    const entry = { name: "pantheon", config };
    expect(roundTrip(AppRemoteEntry, entry)).toEqual(entry);

    const mutation = {
      app: "demo",
      remote: "pantheon",
      file: "/tmp/demo/.lando.yml",
      config,
    };
    expect(roundTrip(AppRemoteMutationResult, mutation)).toEqual(mutation);
  });

  test("rejects excess top-level properties", () => {
    expect(
      Result.isFailure(decode(AppRemoteEntry, { name: "pantheon", config: { source: "x" }, extra: true })),
    ).toBe(true);
    expect(
      Result.isFailure(
        decode(AppRemoteMutationResult, {
          app: "demo",
          remote: "pantheon",
          file: "/tmp/x",
          config: { source: "x" },
          extra: true,
        }),
      ),
    ).toBe(true);
  });
});
