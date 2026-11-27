import { scratchForkSourceLayer } from "@lando/engine/scratch-app/fork-source";
import { Result } from "effect";
import {
  classifyScratchStart,
  scratchStartOptionsFromInput,
  scratchStartWithSource,
} from "./commands/scratch";

export const prepareNativeScratchStart = (input: unknown, cwd: string) => {
  const options = scratchStartOptionsFromInput(input);
  return Result.map(classifyScratchStart(options), (source) => {
    const layers =
      source.kind === "fork" ? [scratchForkSourceLayer(cwd, source, options.noLocalOverrides === true)] : [];
    return { operation: scratchStartWithSource(options, source), layers };
  });
};
