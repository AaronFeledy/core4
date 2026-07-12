import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import {
  buildLandoVolumeFilters,
  buildVolumePruneRequest,
  parseVolumePruneResult,
  pruneVolumes,
  volumeMatchesFilters,
} from "@lando/provider-lando";
import type { PodmanApiClient, VolumeFilterMap } from "@lando/provider-lando";

const decodeFilters = (path: string): Record<string, ReadonlyArray<string>> => {
  const match = path.match(/[?&]filters=([^&]+)/);
  if (match === null) throw new Error(`no filters query in ${path}`);
  return JSON.parse(decodeURIComponent(match[1])) as Record<string, ReadonlyArray<string>>;
};

const requestClient = (response: { status: number; body: string }): PodmanApiClient & {
  readonly captured: { path?: string; method?: string };
} => {
  const captured: { path?: string; method?: string } = {};
  return {
    captured,
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) => {
      captured.path = request.path;
      captured.method = request.method;
      return Effect.succeed(response);
    },
  };
};

describe("buildLandoVolumeFilters", () => {
  test("uses a single ownership-complete data selector so Podman label OR cannot broaden prune", () => {
    const filters = buildLandoVolumeFilters("myapp", { providerId: "lando", volumeClasses: ["data"] });
    expect(filters.label).toEqual(["dev.lando.volume-selector=lando:myapp:data"]);
  });

  test("can include scope inside the ownership-complete selector when needed", () => {
    const filters = buildLandoVolumeFilters("myapp", {
      providerId: "lando",
      volumeClasses: ["data"],
      scope: "app",
    });
    expect(filters.label).toEqual(["dev.lando.volume-selector=lando:myapp:data:app"]);
    expect(filters["label!"]).toBeUndefined();
  });

  test("adds a positive cache label for cache-only prune filters", () => {
    const filters = buildLandoVolumeFilters("myapp", { providerId: "lando", volumeClasses: ["cache"] });
    expect(filters.label).toEqual(["dev.lando.volume-selector=lando:myapp:cache"]);
    expect(filters["label!"]).toBeUndefined();
  });

  test("ORs only fully ownership-scoped selectors when pruning cache and data together", () => {
    const filters = buildLandoVolumeFilters("myapp", {
      providerId: "lando",
      volumeClasses: ["cache", "data"],
    });
    expect(filters.label).toEqual([
      "dev.lando.volume-selector=lando:myapp:cache",
      "dev.lando.volume-selector=lando:myapp:data",
    ]);
  });
});

describe("volumeMatchesFilters", () => {
  const filters: VolumeFilterMap = { label: ["dev.lando.volume-selector=lando:myapp:data"] };

  test("matches a volume owned by the current app", () => {
    expect(volumeMatchesFilters({ "dev.lando.volume-selector": "lando:myapp:data" }, filters)).toBe(true);
  });

  test("rejects a volume owned by another app (AND label semantics)", () => {
    expect(volumeMatchesFilters({ "dev.lando.volume-selector": "lando:otherapp:data" }, filters)).toBe(false);
  });

  test("rejects an unlabeled volume so global/unrelated volumes are never selected", () => {
    expect(volumeMatchesFilters({}, filters)).toBe(false);
  });

  test("rejects a current-app volume without the provider ownership label", () => {
    expect(volumeMatchesFilters({ "dev.lando.app": "myapp" }, buildLandoVolumeFilters("myapp"))).toBe(false);
  });

  test("rejects a cache volume of the same app via label! negation", () => {
    expect(volumeMatchesFilters({ "dev.lando.volume-selector": "lando:myapp:cache" }, filters)).toBe(false);
  });

  test("supports bare label key presence and exact key=value equality", () => {
    expect(volumeMatchesFilters({ "dev.lando.app": "myapp" }, { label: ["dev.lando.app"] })).toBe(true);
    expect(volumeMatchesFilters({ "dev.lando.app": "myapp" }, { label: ["dev.lando.app=other"] })).toBe(
      false,
    );
  });
});

describe("buildVolumePruneRequest", () => {
  test("targets the libpod prune endpoint with anonymous-only default (no all key, no dryrun)", () => {
    const request = buildVolumePruneRequest({ filters: buildLandoVolumeFilters("myapp") });
    expect(request.method).toBe("POST");
    expect(request.path.startsWith("/libpod/volumes/prune")).toBe(true);
    expect(request.path).not.toContain("dryrun=true");
    const filters = decodeFilters(request.path);
    expect(filters.all).toBeUndefined();
    expect(filters.label).toEqual(["dev.lando.volume-selector=lando:myapp:data"]);
  });

  test("opts into named-volume cleanup only when all=true is explicitly requested", () => {
    const request = buildVolumePruneRequest({ filters: buildLandoVolumeFilters("myapp"), all: true });
    const filters = decodeFilters(request.path);
    expect(request.path).toContain("all=true");
    expect(filters.all).toBeUndefined();
    expect(filters.label).toEqual(["dev.lando.volume-selector=lando:myapp:data"]);
  });

  test("marks the request as a dry run so destructive deletion is previewable", () => {
    const request = buildVolumePruneRequest({
      filters: buildLandoVolumeFilters("myapp"),
      all: true,
      dryRun: true,
    });
    expect(request.path).toContain("all=true");
    expect(request.path).toContain("dryrun=true");
    expect(decodeFilters(request.path).all).toBeUndefined();
  });
});

describe("parseVolumePruneResult", () => {
  test("maps the libpod prune array into pruned volumes, errors, and reclaimed space", () => {
    const report = parseVolumePruneResult(
      '[{"Id":"v1","Size":100},{"Id":"v2","Size":50},{"Id":"v3","Err":"volume is in use"}]',
    );
    expect(report.pruned).toEqual([
      { id: "v1", size: 100 },
      { id: "v2", size: 50 },
    ]);
    expect(report.errors).toEqual([{ id: "v3", message: "volume is in use" }]);
    expect(report.spaceReclaimed).toBe(150);
  });

  test("tolerates the docker-compat prune response shape", () => {
    const report = parseVolumePruneResult('{"VolumesDeleted":["v1","v2"],"SpaceReclaimed":42}');
    expect(report.pruned).toEqual([{ id: "v1" }, { id: "v2" }]);
    expect(report.errors).toEqual([]);
    expect(report.spaceReclaimed).toBe(42);
  });

  test("returns an empty report for malformed or empty output", () => {
    expect(parseVolumePruneResult("not json")).toEqual({ pruned: [], errors: [], spaceReclaimed: 0 });
    expect(parseVolumePruneResult("[]")).toEqual({ pruned: [], errors: [], spaceReclaimed: 0 });
  });
});

describe("pruneVolumes", () => {
  test("prunes and returns a stamped report on success", async () => {
    const api = requestClient({ status: 200, body: '[{"Id":"v1","Size":10}]' });
    const exit = await Effect.runPromiseExit(
      pruneVolumes(api, { filters: buildLandoVolumeFilters("myapp") }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.pruned).toEqual([{ id: "v1", size: 10 }]);
      expect(exit.value.dryRun).toBe(false);
      expect(exit.value.spaceReclaimed).toBe(10);
    }
    expect(api.captured.method).toBe("POST");
    expect(api.captured.path?.startsWith("/libpod/volumes/prune")).toBe(true);
  });

  test("stamps dryRun and forwards dryrun=true when previewing", async () => {
    const api = requestClient({ status: 200, body: "[]" });
    const exit = await Effect.runPromiseExit(
      pruneVolumes(api, { filters: buildLandoVolumeFilters("myapp"), all: true, dryRun: true }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.dryRun).toBe(true);
    expect(api.captured.path).toContain("dryrun=true");
  });

  test("fails with a typed ProviderUnavailableError on a non-2xx response", async () => {
    const api = requestClient({ status: 500, body: '{"message":"internal server error"}' });
    const error = await Effect.runPromise(
      pruneVolumes(api, { filters: buildLandoVolumeFilters("myapp") }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.operation).toBe("pruneVolumes");
  });

  test("fails with a typed ProviderInternalError when the client cannot make requests", async () => {
    const api: PodmanApiClient = { info: Effect.succeed({}), ping: Effect.succeed(undefined) };
    const error = await Effect.runPromise(
      pruneVolumes(api, { filters: buildLandoVolumeFilters("myapp") }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(ProviderInternalError);
  });
});
