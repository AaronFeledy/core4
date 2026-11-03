import { committedSensitiveLiterals } from "@lando/landofile/authored-literal";
import { sha256Hex } from "@lando/sdk/digest";
import type { AppPlan, LoadScopedLandofile } from "@lando/sdk/schema";

export const withCommittedLiteralDigests = <Plan extends AppPlan>(
  plan: Plan,
  landofile: LoadScopedLandofile,
): Omit<Plan, "committedLiteralDigests"> & Pick<AppPlan, "committedLiteralDigests"> => {
  const committedLiteralDigests = [...committedSensitiveLiterals(landofile.document)].map(sha256Hex).sort();
  const { committedLiteralDigests: _previous, ...current } = plan;
  return { ...current, ...(committedLiteralDigests.length === 0 ? {} : { committedLiteralDigests }) };
};
