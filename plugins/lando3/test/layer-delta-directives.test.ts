import { expect, test } from "bun:test";
import { decodeLandofileLayer, mergeLandofiles, override, reset } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { replayDecodedDeltas } from "../src/layer-delta-replay.ts";
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

test("decoded replay rejects an invalid desired prefix rather than proving raw replay", () => {
  const desired = { services: { db: { creds: { user: "only-user" } } } };
  expect(() =>
    Effect.runSync(
      replayDecodedDeltas(
        [{ layer: "dist", sourceIds: [], desired }],
        [{ layer: "dist", fragment: desired }],
      ),
    ),
  ).toThrow();
});

test("decoded replay widens a partial credential delta to its nearest valid containing override", () => {
  const first = { services: { db: { creds: { user: "app", password: "old", database: "app" } } } };
  const second = { services: { db: { creds: { user: "app", password: "new", database: "app" } } } };
  const prefixes = [
    { layer: "dist" as const, sourceIds: [], desired: first },
    { layer: "canonical" as const, sourceIds: [], desired: second },
  ];
  const layers = Effect.runSync(replayDecodedDeltas(prefixes, planLayerDeltas(prefixes).emitted));
  expect(layers[1]?.fragment).toEqual({ services: { db: { creds: override(second.services.db.creds) } } });
  let effective = {};
  for (const [index, layer] of layers.entries()) {
    effective = mergeLandofiles([
      effective,
      Effect.runSync(decodeLandofileLayer(layer.layer, layer.fragment)),
    ]);
    expect<unknown>(effective).toEqual(prefixes[index]?.desired);
  }
});
