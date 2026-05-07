/**
 * `LandofileService` Live Layer.
 *
 * Discovery:
 * - Walks upward from CWD; first matching directory becomes the *app root*.
 * - Bounded by filesystem root (`/`), `.lando.stop` sentinel, and configurable
 *   `discovery.maxDepth` (default `8`).
 * - Uses `FileSystem.readdir` and is cached per-CWD for the lifetime of a
 *   CLI invocation.
 *
 * Status: stub.
 */
export { LandofileService } from "@lando/sdk/services";
