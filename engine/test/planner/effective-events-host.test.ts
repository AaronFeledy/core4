import { describe, expect, test } from "bun:test";

import { LANDO_HOST_EVENT_ENV } from "@lando/sdk/schema";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { DateTime } from "effect";
import {
  attachEffectiveEvents,
  canonicalEventStepKey,
  compileEffectiveEvents,
  compiledEventsForPlan,
  effectiveEventsForPlan,
  hostEventStatusesForApp,
} from "../../src/planner/effective-events.ts";

const plan = (): AppPlan => ({
  id: AppId.make("host-events"),
  name: "host-events",
  slug: "host-events",
  root: AbsolutePath.make("/tmp/host-events"),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-09T00:00:00Z"), source: ".lando.yml", runtime: 4 },
  extensions: {},
});

describe("compileEffectiveEvents host steps", () => {
  test("returns host steps first and drops a canonical host duplicate", () => {
    const compiled = compileEffectiveEvents({
      landofile: { events: { "post-start": [{ cmd: "echo hi" }] } },
      hostEvents: { "post-start": ["echo hi", { cmd: "echo host", service: ":host" }] },
      services: { web: { primary: true } },
    });
    const steps = compiled["post-start"] ?? [];
    expect(steps.map((step) => [step.source, step.status, canonicalEventStepKey(step.step, "web")])).toEqual([
      ["host", "deduped", "cmd:echo hi:service:web"],
      ["host", "active", "cmd:echo host:service::host"],
      ["project", "active", "cmd:echo hi:service:web"],
    ]);
    expect(effectiveEventsForPlan(attachEffectiveEvents(plan(), compiled))?.["post-start"]).toEqual([
      { cmd: "echo host", service: ":host" },
      { cmd: "echo hi" },
    ]);
  });

  test("canonical match treats an omitted service as the primary and keeps :host distinct", () => {
    const compiled = compileEffectiveEvents({
      landofile: { events: { "pre-stop": [{ cmd: "echo x", service: "web" }] } },
      hostEvents: {
        "pre-stop": ["echo x", { cmd: "echo x", service: ":host" }],
      },
      services: { web: { primary: true } },
    });
    expect((compiled["pre-stop"] ?? []).map((step) => step.status)).toEqual(["deduped", "active", "active"]);
  });

  test("skips a host step whose service is missing from the plan", () => {
    const compiled = compileEffectiveEvents({
      landofile: { events: {} },
      hostEvents: { "post-start": [{ cmd: "echo db", service: "db" }, { cmd: "echo web" }] },
      services: { web: { primary: true } },
    });
    const statuses = hostEventStatusesForApp(compiled);
    expect(statuses).toEqual([
      {
        event: "post-start",
        index: 0,
        step: { cmd: "echo db", service: "db" },
        status: "skipped",
        reason: "service db is not in the plan",
      },
      { event: "post-start", index: 1, step: { cmd: "echo web" }, status: "active" },
    ]);
  });

  test("does not treat an unmarked web service as the primary", () => {
    const compiled = compileEffectiveEvents({
      landofile: { events: {} },
      hostEvents: { "post-start": [{ cmd: "echo web" }] },
      services: { web: {} },
    });
    expect(compiled["post-start"]?.[0]).toMatchObject({
      status: "skipped",
      skipReason: "no primary service",
    });
  });

  test("never skips a :host step and marks LANDO_HOST_EVENT skips", () => {
    const compiled = compileEffectiveEvents({
      landofile: { events: {} },
      hostEvents: { "pre-start": [{ cmd: "echo host", service: ":host" }] },
      services: {},
      skipHostEvents: true,
    });
    expect(compiled["pre-start"]?.[0]).toMatchObject({
      source: "host",
      status: "skipped",
      skipReason: `${LANDO_HOST_EVENT_ENV}=1`,
    });
  });

  test("reattaching compiled events keeps provenance on both cache-shaped paths", () => {
    const compiled = compileEffectiveEvents({
      landofile: { events: { "pre-stop": ["echo project"] } },
      hostEvents: { "pre-stop": [{ cmd: "echo host", service: ":host" }] },
      services: { web: { primary: true } },
    });
    const fresh = attachEffectiveEvents(plan(), compiled);
    const cached = attachEffectiveEvents(
      { ...plan(), id: AppId.make("adopted") },
      compiledEventsForPlan(fresh) ?? {},
    );
    expect(compiledEventsForPlan(fresh)?.["pre-stop"]?.[0]).toMatchObject({
      source: "host",
      sourceIndex: 0,
      status: "active",
    });
    expect(compiledEventsForPlan(cached)?.["pre-stop"]?.[0]).toMatchObject({
      source: "host",
      sourceIndex: 0,
      status: "active",
    });
  });
});
