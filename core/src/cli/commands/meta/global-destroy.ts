import type { GlobalDestroyResult } from "@lando/engine/operations/global-destroy";
import { teardownLine, volumesTrailer } from "../service-summary";

export const renderGlobalDestroyResult = (result: GlobalDestroyResult): string =>
  teardownLine(result.outcome, result.app, result.servicesDestroyed, volumesTrailer(result.volumesRemoved));
