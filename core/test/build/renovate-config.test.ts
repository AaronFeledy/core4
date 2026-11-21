import { expect, test } from "bun:test";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";

const repoRoot = resolve(import.meta.dirname, "../../..");

const RenovateConfig = Schema.Struct({
  constraints: Schema.Struct({ bun: Schema.String }),
  customManagers: Schema.Array(
    Schema.Struct({ depNameTemplate: Schema.String, matchStrings: Schema.Array(Schema.String) }),
  ),
});

test("Renovate updates bun.lock with the Bun in .bun-version and can move that constraint with it", async () => {
  const [configText, bunVersion] = await Promise.all([
    Bun.file(resolve(repoRoot, ".github/renovate.json")).text(),
    Bun.file(resolve(repoRoot, ".bun-version")).text(),
  ]);
  const config = Schema.decodeUnknownSync(RenovateConfig)(JSON.parse(configText));
  const bunManager = config.customManagers.find((manager) => manager.depNameTemplate === "bun");

  expect(config.constraints.bun).toBe(bunVersion.trim());
  expect(
    bunManager?.matchStrings.map((pattern) => new RegExp(pattern).exec(configText)?.groups?.currentValue),
  ).toEqual([bunVersion.trim()]);
});
