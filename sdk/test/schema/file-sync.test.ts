import { describe, expect, test } from "bun:test";

import { Either, JSONSchema, Schema } from "effect";

import {
  type AppRef,
  FileSyncEngineCapabilities,
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

describe("FileSyncEngineCapabilities (§10.6.1)", () => {
  test("decodes the canonical Mutagen capability matrix", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncEngineCapabilities)({
      modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"],
      remoteAgentDeployment: "auto",
      exclusionPatterns: true,
      conflictReporting: true,
      progressReporting: true,
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.modes).toEqual([
        "two-way-safe",
        "two-way-resolved",
        "one-way-safe",
        "one-way-replica",
      ]);
      expect(decoded.right.remoteAgentDeployment).toBe("auto");
    }
  });

  test("rejects an unknown sync mode literal", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncEngineCapabilities)({
      modes: ["lol-unknown-mode"],
      remoteAgentDeployment: "auto",
      exclusionPatterns: false,
      conflictReporting: false,
      progressReporting: false,
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects an unknown remoteAgentDeployment literal", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncEngineCapabilities)({
      modes: ["two-way-safe"],
      remoteAgentDeployment: "wishful",
      exclusionPatterns: true,
      conflictReporting: true,
      progressReporting: true,
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("produces stable JSON Schema output for the snapshot gate", () => {
    const jsonSchema = JSONSchema.make(FileSyncEngineCapabilities);
    expect(jsonSchema).toBeDefined();
    const fromRegistry = getJsonSchema("FileSyncEngineCapabilities");
    expect(fromRegistry).toBeDefined();
    expect(fromRegistry.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});

describe("FileSyncSessionSpec (§10.6.1)", () => {
  test("decodes a volume-target session spec round-trip", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSessionSpec)({
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      source: "/srv/apps/myapp",
      target: { _tag: "volume", name: "lando-sync-myapp-web-abcd", path: "/app" },
      mode: "two-way-safe",
      excludes: ["node_modules", "vendor"],
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.mountKey).toBe("app-root");
      expect(decoded.right.mode).toBe("two-way-safe");
      expect(decoded.right.excludes).toEqual(["node_modules", "vendor"]);
      expect(decoded.right.target._tag).toBe("volume");
    }
  });

  test("decodes a service-target session spec with optional permissions", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSessionSpec)({
      app: APP_REF,
      service: "web",
      mountKey: "vendor",
      source: "/srv/apps/myapp/vendor",
      target: { _tag: "service", service: "app", path: "/app/vendor" },
      mode: "one-way-replica",
      excludes: [],
      permissions: { owner: "www-data", mode: "0755" },
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.target._tag).toBe("service");
      expect(decoded.right.permissions?.owner).toBe("www-data");
      expect(decoded.right.permissions?.mode).toBe("0755");
    }
  });

  test("rejects an unknown sync mode", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSessionSpec)({
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      source: "/srv/apps/myapp",
      target: { _tag: "volume", name: "x", path: "/app" },
      mode: "not-a-real-mode",
      excludes: [],
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects an unknown target tag", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSessionSpec)({
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      source: "/srv/apps/myapp",
      target: { _tag: "imaginary", path: "/app" },
      mode: "two-way-safe",
      excludes: [],
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("produces stable JSON Schema output for the snapshot gate", () => {
    const fromRegistry = getJsonSchema("FileSyncSessionSpec");
    expect(fromRegistry).toBeDefined();
    expect(fromRegistry.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});

describe("FileSyncSessionRef", () => {
  test("is a branded string that round-trips through encode/decode", () => {
    const ref = FileSyncSessionRef.make("myapp-web-app-root");
    expect(ref).toBe("myapp-web-app-root");

    const decoded = Schema.decodeUnknownEither(FileSyncSessionRef)("myapp-web-app-root");
    expect(Either.isRight(decoded)).toBe(true);
  });
});

describe("FileSyncSessionInfo", () => {
  test("decodes a paused session snapshot", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSessionInfo)({
      ref: "myapp-web-app-root",
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      status: "paused",
      lastUpdatedAt: "2026-05-28T18:51:00Z",
    });

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.status).toBe("paused");
      expect(decoded.right.ref).toBe("myapp-web-app-root");
      expect(decoded.right.service).toBe(ServiceName.make("web"));
    }
  });

  test("rejects an unknown session status literal", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSessionInfo)({
      ref: "x",
      app: APP_REF,
      service: "web",
      mountKey: "app-root",
      status: "unknown",
      lastUpdatedAt: "2026-05-28T18:51:00Z",
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });
});

describe("FileSyncSessionFilter", () => {
  test("decodes empty filter", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSessionFilter)({});
    expect(Either.isRight(decoded)).toBe(true);
  });

  test("decodes filter narrowed by app and service", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSessionFilter)({
      app: APP_REF,
      service: "web",
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.service).toBe(ServiceName.make("web"));
    }
  });
});

describe("FileSyncSetupOptions", () => {
  test("decodes a force=false setup invocation", () => {
    const decoded = Schema.decodeUnknownEither(FileSyncSetupOptions)({ force: false });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.force).toBe(false);
    }
  });
});
