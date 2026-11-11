import { join, resolve } from "node:path";
import { Schema } from "effect";

const repoRoot = resolve(import.meta.dirname, "../../..");
export const goldenPath = join(repoRoot, "landofile/test/fixtures/golden-corpus-digests.json");

const Valid = Schema.Struct({ digest: Schema.String });
const Invalid = Schema.Struct({
  invalid: Schema.Struct({ status: Schema.Literal("invalid"), tag: Schema.String }),
});
const Outcome = Schema.Union([Valid, Invalid]);
export const Golden = Schema.Struct({
  fixtures: Schema.Array(
    Schema.Union([
      Schema.Struct({ fixture: Schema.String, ...Valid.fields }),
      Schema.Struct({ fixture: Schema.String, ...Invalid.fields }),
    ]),
  ),
  intended: Schema.Record(
    Schema.String,
    Schema.Struct({
      before: Outcome,
      after: Outcome,
      reason: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
});
export type GoldenOutcome = typeof Outcome.Type;

export const readGoldenCorpus = async () =>
  Schema.decodeUnknownSync(Golden)(await Bun.file(goldenPath).json());

/** The load outcome a guide fixture must produce now: an intended change's `after`, else its recorded entry. */
export const expectedGoldenOutcome = (
  golden: typeof Golden.Type,
  fixture: string,
): GoldenOutcome | undefined => {
  const intended = golden.intended[fixture];
  if (intended !== undefined) return intended.after;
  const recorded = golden.fixtures.find((entry) => entry.fixture === fixture);
  if (recorded === undefined) return undefined;
  const { fixture: _fixture, ...outcome } = recorded;
  return outcome;
};
