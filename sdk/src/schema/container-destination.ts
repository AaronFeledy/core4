/**
 * Canonical container mount destinations.
 *
 * A destination is where a mount lands *inside* a container, so it is always a
 * POSIX path regardless of the host Lando runs on. Two spellings of the same
 * directory must compare equal, otherwise a plan stacks a second store on top
 * of a destination it already covers. Canonicalization therefore happens once,
 * when a destination is written onto a plan, and every later comparison is
 * plain equality on the canonical form.
 *
 * The policy is deliberately narrow:
 *
 * - `.` segments, `..` segments, and repeated separators resolve away, so
 *   `/home/./other/../node` and `/home//node` are both `/home/node`.
 * - A trailing separator is dropped, so `/home/node/` is `/home/node`.
 * - `..` above the top of the path clamps at root, which is how POSIX resolves
 *   an absolute path: `/a/../../b` is `/b`. Nothing escapes upward, so this is
 *   resolution, not traversal.
 * - A relative destination (`.`, `..`, `app/data`, the empty string) is
 *   refused, because it would be resolved against a working directory Lando
 *   does not control.
 * - Root is refused as a destination. Container engines reject a mount whose
 *   destination is `/`, so accepting it here would only move the failure to the
 *   provider, after Lando had already promised the mount.
 *
 * Colons are deliberately allowed. A colon is legal in a POSIX path, and the
 * only reason to refuse one would be the provider's short mount syntax
 * (`source:target:mode`), which cannot carry a colon in its target. That is an
 * encoding limit, not a limit on the destination, so the emitters switch such a
 * destination to long mount syntax instead of rejecting the path.
 */
import { posix } from "node:path";

import { PortablePath } from "./primitives.ts";

/** The canonical POSIX spelling of a container destination. */
const canonical = (target: string): string => {
  const normalized = posix.normalize(target);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
};

/** Why a destination cannot be used, phrased for the author who wrote it. */
export type ContainerDestinationRefusal = "not-absolute" | "root";

/**
 * Canonicalizes a destination, or names why it cannot be one.
 */
export const parseContainerDestination = (
  target: string,
):
  | { readonly ok: true; readonly value: PortablePath }
  | { readonly ok: false; readonly reason: ContainerDestinationRefusal } => {
  if (!target.startsWith("/")) return { ok: false, reason: "not-absolute" };
  const value = canonical(target);
  if (value === "/") return { ok: false, reason: "root" };
  return { ok: true, value: PortablePath.make(value) };
};

/** Human-readable reason text, reused by every surface that refuses a destination. */
export const containerDestinationRefusalMessage = (
  reason: ContainerDestinationRefusal,
  target: string,
): string =>
  reason === "not-absolute"
    ? `Container destination ${JSON.stringify(target)} must be an absolute path starting with "/".`
    : `Container destination ${JSON.stringify(target)} resolves to "/", and a container engine cannot mount over the filesystem root.`;
