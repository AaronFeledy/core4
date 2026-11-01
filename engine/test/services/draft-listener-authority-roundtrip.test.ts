import { expect, test } from "bun:test";
import { ServiceFeatureError } from "@lando/sdk/errors";
import { type ListenerAuthority, PortNumber, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeResolution } from "@lando/sdk/services";
import { DateTime } from "effect";
import { servicePlanFromDraft, toAppFeatureDraft } from "../../src/planner/extensions.ts";
import {
  type DraftServicePlan,
  makeDraft,
  pickDraftOptionalServicePlanFields,
} from "../../src/services/draft.ts";
import { finalizeDraft } from "../../src/services/finalize-service.ts";

const provider = ProviderId.make("lando");
const name = ServiceName.make("database");
const authority: ListenerAuthority = {
  owner: "launcher",
  daemon: "MongoDB",
  port: PortNumber.make(27018),
  setting: "--port 27018",
};
const metadata = {
  resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00Z"),
  source: "draft-listener-authority-roundtrip",
  runtime: 4 as const,
};

const baseDraft = (): DraftServicePlan => {
  const draft = makeDraft({
    name,
    type: "mongodb",
    serviceTypeId: "mongodb",
    provider,
    primary: true,
    defaultFeatures: [],
  });
  draft.listenerAuthority = authority;
  draft.user = "mongodb";
  draft.workingDirectory = PortablePath.make("/app");
  draft.readinessSource = "contributed";
  draft.certs = { cn: "database.lndo.site", sans: ["database.lndo.site"], caId: "lando" };
  draft.provenance = { selected: "mongodb" };
  return draft;
};

test("finalizeDraft preserves listenerAuthority and shared optional pass-through fields", () => {
  const draft = baseDraft();
  const plan = finalizeDraft(draft);
  expect(plan).not.toBeInstanceOf(ServiceFeatureError);
  if (plan instanceof ServiceFeatureError) return;
  expect(plan.listenerAuthority).toEqual(authority);
  expect(pickDraftOptionalServicePlanFields(plan)).toMatchObject({
    serviceTypeId: "mongodb",
    listenerAuthority: authority,
    user: "mongodb",
    workingDirectory: PortablePath.make("/app"),
    readinessSource: "contributed",
    certs: { cn: "database.lndo.site", sans: ["database.lndo.site"], caId: "lando" },
    provenance: { selected: "mongodb" },
  });
});

test("servicePlanFromDraft and toAppFeatureDraft round-trip listenerAuthority", () => {
  const draft = baseDraft();
  const plan = servicePlanFromDraft(draft, [], metadata, {});
  expect(plan.listenerAuthority).toEqual(authority);

  const resolution = {
    base: "lando" as const,
    normalizedConfig: { type: "mongodb" },
    features: [],
    metadata: { selected: "mongodb" },
  } satisfies ServiceTypeResolution;

  const appDraft = toAppFeatureDraft(String(name), plan, resolution, []);
  expect(appDraft.listenerAuthority).toEqual(authority);
  expect(appDraft.user).toBe("mongodb");
  expect(appDraft.provenance).toEqual({ selected: "mongodb" });

  const restored = servicePlanFromDraft(appDraft, plan.routes, plan.metadata, plan.extensions);
  expect(restored.listenerAuthority).toEqual(authority);
  expect(restored.user).toBe("mongodb");
});
