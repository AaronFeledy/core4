import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { scratchLabelsForPlan as dockerScratchLabelsForPlan } from "@lando/provider-docker";
import { scratchLabelsForPlan as landoScratchLabelsForPlan } from "@lando/provider-lando";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";

const plan = (id: string, extensionId: string | undefined): AppPlan => ({
  id: AppId.make(id),
  name: id,
  slug: id,
  root: AbsolutePath.make(`/tmp/${id}`),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
    source: "scratch-labels.test",
    runtime: 4,
  },
  extensions: extensionId === undefined ? {} : { "@lando/core/scratch": { id: extensionId } },
});

describe("provider scratch labels", () => {
  test("docker and lando providers emit scratch labels only when the marker matches the plan id", () => {
    const matching = {
      "dev.lando.scratch": "TRUE",
      "dev.lando.scratch-id": "scratch-app-000001",
    };

    expect(dockerScratchLabelsForPlan(plan("scratch-app-000001", "scratch-app-000001"))).toEqual(matching);
    expect(landoScratchLabelsForPlan(plan("scratch-app-000001", "scratch-app-000001"))).toEqual(matching);
    expect(dockerScratchLabelsForPlan(plan("scratch-app-000001", "other"))).toEqual({});
    expect(landoScratchLabelsForPlan(plan("scratch-app-000001", "other"))).toEqual({});
    expect(dockerScratchLabelsForPlan(plan("scratch-app-000001", undefined))).toEqual({});
    expect(landoScratchLabelsForPlan(plan("scratch-app-000001", undefined))).toEqual({});
  });
});
