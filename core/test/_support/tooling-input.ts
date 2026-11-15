import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { Result } from "effect";

export const emptyToolingInput = () =>
  Result.getOrThrowWith(normalizeToolingInput("fixture", {}), (error) => error);
