import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { LandoEvent } from "../../src/events/index.ts";
import {
  DatasetApplyResult,
  DatasetArtifactFormat,
  DatasetKind,
  PluginManifest,
  RemoteCapabilities,
  RemoteConfig,
  RemoteEnvironment,
  RemoteLocator,
  SyncResult,
} from "../../src/schema/index.ts";

describe("remote-sync SDK schemas", () => {
  test("decodes remote source, dataset, sync result, event, and manifest contribution shapes", () => {
    const capabilities = Schema.decodeUnknownSync(RemoteCapabilities)({
      environments: true,
      push: true,
      datasets: ["database", "files"],
      auth: "token",
      tool: "terminus",
      protectedByDefault: ["live"],
    });

    expect(capabilities.datasets).toEqual(["database", "files"]);
    expect(Schema.decodeUnknownSync(RemoteConfig)({ source: "pantheon", site: "site-id" })).toEqual({
      source: "pantheon",
      site: "site-id",
    });
    expect(Schema.decodeUnknownSync(RemoteEnvironment)({ id: "dev", label: "Development" }).id).toBe("dev");
    expect(
      Schema.decodeUnknownSync(RemoteLocator)({
        remote: "pantheon",
        env: "dev",
        dataset: "database",
        endpoint: "https://example.test/export.sql.gz",
      }).dataset,
    ).toBe("database");
    expect(Schema.decodeUnknownSync(DatasetKind)("blob")).toBe("blob");
    expect(
      Schema.decodeUnknownSync(DatasetApplyResult)({
        changed: true,
        localStore: { app: "my-app", store: "db" },
        snapshot: { id: "snap-1", store: { app: "my-app", store: "db" } },
      }).changed,
    ).toBe(true);
    expect(
      Schema.decodeUnknownSync(SyncResult)({
        direction: "pull",
        remote: "pantheon",
        env: "dev",
        datasets: ["database"],
        changed: true,
      }).direction,
    ).toBe("pull");
    expect(
      Schema.decodeUnknownSync(LandoEvent)({
        _tag: "pre-pull",
        eventName: "pre-pull",
        remote: "pantheon",
        env: "dev",
        datasets: ["database"],
        timestamp: "2026-06-14T00:00:00.000Z",
      }).eventName,
    ).toBe("pre-pull");
    expect(
      Schema.decodeUnknownSync(PluginManifest)({
        name: "@lando/remote-pantheon",
        version: "1.0.0",
        api: 4,
        contributes: {
          remoteSources: [{ id: "pantheon", module: "./remote.ts", capabilities }],
          datasets: [{ id: "database", module: "./dataset.ts", kind: "database" }],
        },
      }).contributes?.remoteSources?.[0]?.id,
    ).toBe("pantheon");
  });

  test("rejects invalid dataset kinds and incomplete sync results", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(DatasetKind)("code"))).toBe(true);
    expect(Either.isLeft(Schema.decodeUnknownEither(DatasetArtifactFormat)({ endpoint: "artifact" }))).toBe(
      true,
    );
    expect(Either.isLeft(Schema.decodeUnknownEither(SyncResult)({ direction: "pull" }))).toBe(true);
  });
});
