import { describe, expect, test } from "bun:test";

import * as sdk from "@lando/sdk";
import * as landofile from "@lando/sdk/landofile";
import type { LandofileOverlayInput } from "@lando/sdk/landofile";
import * as schema from "@lando/sdk/schema";
import type { LandofileOverride, LandofileReset, LandofileShape } from "@lando/sdk/schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(value: T): T => value;
type Accepts<T> = T extends LandofileOverlayInput ? true : false;
type Rejects<T> = T extends LandofileOverlayInput ? false : true;

describe("Landofile merge directive typing", () => {
  test("helpers return directive wrappers, not their payload or undefined", () => {
    // Given the public helpers; when their return types are inspected under tsc.
    assertType<Equal<ReturnType<typeof landofile.override<number>>, LandofileOverride<number>>>(true);
    assertType<Equal<ReturnType<typeof landofile.reset>, LandofileReset>>(true);
    assertType<LandofileOverride<number> extends number ? false : true>(true);
    assertType<LandofileReset extends undefined ? false : true>(true);
    // Then the runtime values are branded wrappers.
    expect(landofile.isLandofileOverride(landofile.override(1))).toBe(true);
    expect(landofile.isLandofileReset(landofile.reset())).toBe(true);
  });

  test("defineLandofile accepts directives on mapping members", () => {
    // Given an authored layer using both directives.
    const layer = sdk.defineLandofile({
      services: {
        web: {
          environment: { FOO: sdk.reset() },
          routes: sdk.override(["web.test"]),
          image: sdk.override("nginx:stable"),
        },
        cache: sdk.reset(),
      },
    });
    assertType<Accepts<typeof layer>>(true);
    // Then the helper is an identity.
    expect(layer.services.cache).toEqual(sdk.reset());
  });

  test("directive payloads keep their member types", () => {
    // Given wrong payload types; when checked against the authored layer type.
    assertType<Rejects<{ services: { web: { routes: LandofileOverride<number> } } }>>(true);
    assertType<Rejects<{ name: LandofileOverride<number> }>>(true);
    assertType<Rejects<{ services: { web: { image: LandofileOverride<ReadonlyArray<string>> } } }>>(true);
    // Then a document-root directive is not an authored layer either.
    assertType<Rejects<LandofileReset>>(true);
    expect(true).toBe(true);
  });

  test("effective Landofile types stay marker-free", () => {
    // Given directive-bearing values; when checked against the effective shape.
    assertType<{ name: LandofileReset } extends LandofileShape ? false : true>(true);
    assertType<{ name: LandofileOverride<string> } extends LandofileShape ? false : true>(true);
    expect(true).toBe(true);
  });

  test("helpers share one implementation across public entry points", () => {
    // Given every documented entry point; then each exports the same helpers.
    expect(schema.override).toBe(landofile.override);
    expect(schema.reset).toBe(landofile.reset);
    expect(sdk.override).toBe(landofile.override);
    expect(sdk.reset).toBe(landofile.reset);
  });
});
