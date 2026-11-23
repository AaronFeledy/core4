import { type PathInputs, makeLandoPaths } from "@lando/paths";
import { type LandoPaths, PathsService } from "@lando/sdk/services";
import { Layer } from "effect";

/** PathsService values from the test-preload roots (or optional overrides). */
export const testPaths = (overrides: PathInputs = {}): LandoPaths => makeLandoPaths(overrides);

/**
 * Layer that satisfies required PathsService for AppPlanner and other engine layers.
 * Built with Layer.sync so process.env root overrides are read at layer build time,
 * not when the helper is first referenced from a module-level const.
 */
export const pathsServiceLayer = (overrides: PathInputs = {}) =>
  Layer.sync(PathsService, () => testPaths(overrides));
