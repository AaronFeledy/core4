import { afterAll, beforeAll, expect, test } from "bun:test";
import exceptions from "./lando3-corpus-expectations.json";
import { makeCorpusHarness, readCorpusSets } from "./lando3-corpus-fixture.ts";

const sets = await readCorpusSets();
let harness: Awaited<ReturnType<typeof makeCorpusHarness>>;
beforeAll(async () => {
  harness = await makeCorpusHarness();
});
afterAll(async () => {
  await harness.dispose();
});

test.each(sets)("lints $id using production recipe ports and the bundled catalog", async (set) => {
  // Given
  const exception = exceptions.find((entry) => entry.fixture === set.id);
  // When
  const outcome = await harness.run(set);
  // Then: unsupported skips carry their exact blocking diagnostics, never a blind skip.
  if (outcome.stage === "valid") expect(exception).toBeUndefined();
  else expect<unknown>(outcome).toEqual(exception?.outcome);
});

test("keeps every corpus exception attached to a tested document set", () => {
  // Given
  const ids = new Set(sets.map(({ id }) => id));
  // When
  const fixtures = exceptions.map((entry) => entry.fixture);
  // Then
  expect(new Set(fixtures).size).toBe(fixtures.length);
  for (const fixture of fixtures) expect(ids.has(fixture)).toBe(true);
});
