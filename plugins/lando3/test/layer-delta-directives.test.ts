import { expect, test } from "bun:test";
import { decodeLandofileLayer, mergeLandofiles, override, reset } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { planLayerDeltas } from "../src/layer-delta.ts";

test("mapping removals preserve every decoded prefix without relocation", () => {
  const desired = [
    { services: { web: { environment: { OLD: "old", KEEP: "yes" } }, cache: { image: "redis" } } },
    { services: { web: { environment: { KEEP: "yes" } } } },
  ];
  const plan = planLayerDeltas(
    desired.map((value, index) => ({ layer: index === 0 ? "dist" : "local", sourceIds: [], desired: value })),
  );
  expect(plan.emitted[1]?.fragment).toEqual({
    services: { cache: reset(), web: { environment: { OLD: reset() } } },
  });
  let effective = {};
  for (const [index, layer] of plan.emitted.entries()) {
    effective = mergeLandofiles([
      effective,
      Effect.runSync(decodeLandofileLayer("fragment.yml", layer.fragment)),
    ]);
    expect(effective).toEqual(desired[index] ?? {});
  }
});

test("keyed collection removal becomes a native override", () => {
  const plan = planLayerDeltas([
    { layer: "dist", sourceIds: [], desired: { services: { web: { routes: ["a.test", "b.test"] } } } },
    { layer: "local", sourceIds: [], desired: { services: { web: { routes: ["b.test"] } } } },
  ]);
  expect(plan.emitted[1]?.fragment).toEqual({ services: { web: { routes: override(["b.test"]) } } });
});
