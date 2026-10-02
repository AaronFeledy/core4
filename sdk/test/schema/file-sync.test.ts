import { describe, expect, test } from "bun:test";

import { Result, JSONSchema, Schema } from "effect";

import {
  type AppRef,
  FileSyncEngineCapabilities,
  FileSyncEventChunk,
  FileSyncSessionFilter,
  FileSyncSessionInfo,
  FileSyncSessionRef,
  FileSyncSessionSpec,
  FileSyncSetupOptions,
  ServiceName,
  getJsonSchema,
} from "@lando/sdk/schema";

const APP_REF: typeof AppRef.Encoded = {
  kind: "user",
  id: "myapp",
  root: "/srv/apps/myapp",
};

describe("FileSyncEngineCapabilities", () => {
  test("decodes the canonical Mutagen capability matrix", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncEngineCapabilities)({
      modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"],
      remoteAgentDeployment: "auto",
      exclusionPatterns: true,
      conflictReporting: true,
      progressReporting: true,
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.modes).toEqual([
        "two-way-safe",
        "two-way-resolved",
        "one-way-safe",
        "one-way-replica",
      ]);
      expect(decoded.success.remoteAgentDeployment).toBe("auto");
    }
  });

  test("rejects an unknown sync mode literal", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncEngineCapabilities)({
      modes: ["lol-unknown-mode"],
      remoteAgentDeployment: "auto",
      exclusionPatterns: false,
      conflictReporting: false,
      progressReporting: false,
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });

  test("rejects an empty mode list", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncEngineCapabilities)({
      modes: [],
      remoteAgentDeployment: "auto",
      exclusionPatterns: true,
      conflictReporting: true,
      progressReporting: true,
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });

  test("rejects an unknown remoteAgentDeployment literal", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncEngineCapabilities)({
      modes: ["two-way-safe"],
      remoteAgentDeployment: "wishful",
      exclusionPatterns: true,
      conflictReporting: true,
      progressReporting: true,
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });

  test("produces stable JSON Schema output for the snapshot gate", () => {
    const jsonSchema = JSONSchema.make(FileSyncEngineCapabilities);
    expect(jsonSchema).toBeDefined();
    const fromRegistry = getJsonSchema("FileSyncEngineCapabilities");
    expect(fromRegistry).toBeDefined();
    if (typeof fromRegistry !== "object" || fromRegistry === null || !("$schema" in fromRegistry)) {
      throw new Error("missing FileSyncEngineCapabilities schema");
    }
    expect(fromRegistry.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});

describe("FileSyncSessionSpec", () => {
  test("decodes a volume-target session spec round-trip", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSessionSpec)({
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      source: "/srv/apps/myapp",
      target: { _tag: "volume", name: "lando-sync-myapp-web-abcd", path: "/app" },
      mode: "two-way-safe",
      excludes: ["node_modules", "vendor"],
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.mountKey).toBe("app-root");
      expect(decoded.success.mode).toBe("two-way-safe");
      expect(decoded.success.excludes).toEqual(["node_modules", "vendor"]);
      expect(decoded.success.target._tag).toBe("volume");
    }
  });

  test("decodes a service-target session spec with optional permissions", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSessionSpec)({
      app: APP_REF,
      service: "web",
      mountKey: "vendor",
      source: "/srv/apps/myapp/vendor",
      target: { _tag: "service", service: "app", path: "/app/vendor" },
      mode: "one-way-replica",
      excludes: [],
      permissions: { owner: "www-data", mode: "0755" },
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.target._tag).toBe("service");
      expect(decoded.success.permissions?.owner).toBe("www-data");
      expect(decoded.success.permissions?.mode).toBe("0755");
    }
  });

  test("rejects an unknown sync mode", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSessionSpec)({
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      source: "/srv/apps/myapp",
      target: { _tag: "volume", name: "x", path: "/app" },
      mode: "not-a-real-mode",
      excludes: [],
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });

  test("rejects an unknown target tag", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSessionSpec)({
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      source: "/srv/apps/myapp",
      target: { _tag: "imaginary", path: "/app" },
      mode: "two-way-safe",
      excludes: [],
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });

  test("produces stable JSON Schema output for the snapshot gate", () => {
    const fromRegistry = getJsonSchema("FileSyncSessionSpec");
    expect(fromRegistry).toBeDefined();
    if (typeof fromRegistry !== "object" || fromRegistry === null || !("$schema" in fromRegistry)) {
      throw new Error("missing FileSyncSessionSpec schema");
    }
    expect(fromRegistry.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});

describe("FileSyncSessionRef", () => {
  test("is a branded string that round-trips through encode/decode", () => {
    const ref = FileSyncSessionRef.make("myapp-web-app-root");
    expect(ref).toBe(FileSyncSessionRef.make("myapp-web-app-root"));

    const decoded = Schema.decodeUnknownResult(FileSyncSessionRef)("myapp-web-app-root");
    expect(Result.isSuccess(decoded)).toBe(true);
  });
});

describe("FileSyncSessionInfo", () => {
  test("decodes a paused session snapshot", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSessionInfo)({
      ref: "myapp-web-app-root",
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      spec: {
        app: APP_REF,
        service: "web",
        mountKey: "app-root",
        source: "/srv/apps/myapp",
        target: { _tag: "volume", name: "lando-sync-myapp-web-abcd", path: "/app" },
        mode: "two-way-safe",
        excludes: ["node_modules"],
      },
      status: "paused",
      lastUpdatedAt: "2026-05-28T18:51:00Z",
    });

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.status).toBe("paused");
      expect(decoded.success.ref).toBe(FileSyncSessionRef.make("myapp-web-app-root"));
      expect(decoded.success.service).toBe(ServiceName.make("web"));
      expect(decoded.success.spec.source).toBe(FileSyncSessionSpec.fields.source.make("/srv/apps/myapp"));
    }
  });

  test("rejects an unknown session status literal", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSessionInfo)({
      ref: "x",
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      status: "unknown",
      lastUpdatedAt: "2026-05-28T18:51:00Z",
    });
    expect(Result.isFailure(decoded)).toBe(true);
  });
});

describe("FileSyncSessionFilter", () => {
  test("decodes empty filter", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSessionFilter)({});
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  test("decodes filter narrowed by app and service", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSessionFilter)({
      app: APP_REF,
      service: "web",
    });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.service).toBe(ServiceName.make("web"));
    }
  });
});

describe("FileSyncSetupOptions", () => {
  test("decodes a force=false setup invocation", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncSetupOptions)({ force: false });
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.force).toBe(false);
    }
  });
});

describe("FileSyncEventChunk", () => {
  test("decodes progress, conflict, and info chunks", () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(FileSyncEventChunk)({
          _tag: "progress",
          sessionRef: "myapp-web-app-root",
          phase: "watching",
          completed: 0.5,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(FileSyncEventChunk)({
          _tag: "conflict",
          sessionRef: "myapp-web-app-root",
          conflictedPaths: ["README.md"],
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(FileSyncEventChunk)({
          _tag: "info",
          sessionRef: "myapp-web-app-root",
          message: "ready",
        }),
      ),
    ).toBe(true);
  });

  test("rejects out-of-range progress completion", () => {
    const decoded = Schema.decodeUnknownResult(FileSyncEventChunk)({
      _tag: "progress",
      sessionRef: "myapp-web-app-root",
      phase: "watching",
      completed: 1.5,
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });
});
