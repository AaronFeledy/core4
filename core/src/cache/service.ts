/**
 * `CacheService` Live Layer.
 *
 * Atomic write semantics:
 *
 * ```ts
 * const path = "<...>/plan.bin";
 * yield* fs.writeAtomic(path, encoded);  // write to <path>.tmp, fsync, rename
 * ```
 *
 * Read-then-write patterns use Effect's `Ref` for in-memory consistency
 * before the atomic write.
 *
 * Hot-path read budget: reading the command + app-plan caches at bootstrap
 * level `tooling` MUST complete in under 30ms on a warm filesystem. The
 * schema encoding choice and the lack of any provider contact at this level
 * make this achievable.
 *
 * Status: stub.
 */
export { CacheService } from "@lando/sdk/services";
