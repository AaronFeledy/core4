import type { ContainerBringDownReceipt } from "@lando/sdk/schema";

/**
 * Merge per-container stop receipts in action order, one per container. A receipt that found no
 * container yields to one that names a container of the same service.
 */
export const mergeContainerReceipts = (
  ...sources: ReadonlyArray<readonly ContainerBringDownReceipt[] | undefined>
): readonly ContainerBringDownReceipt[] | undefined => {
  let present = false;
  const out: ContainerBringDownReceipt[] = [];
  for (const source of sources) {
    if (source === undefined) continue;
    present = true;
    for (const receipt of source) {
      const duplicate =
        receipt.containerId === undefined
          ? out.some((earlier) => earlier.service === receipt.service)
          : out.some((earlier) => earlier.containerId === receipt.containerId);
      if (!duplicate) out.push(receipt);
    }
  }
  if (!present) return undefined;
  const contained = new Set(
    out.flatMap((receipt) => (receipt.containerId === undefined ? [] : [receipt.service])),
  );
  return out.filter((receipt) => receipt.containerId !== undefined || !contained.has(receipt.service));
};

/** Attach `containers` only when at least one source reported receipts. */
export const withContainerReceipts = <T extends object>(
  result: T,
  ...sources: ReadonlyArray<readonly ContainerBringDownReceipt[] | undefined>
): T & { readonly containers?: readonly ContainerBringDownReceipt[] } => {
  const containers = mergeContainerReceipts(...sources);
  return containers === undefined ? result : { ...result, containers };
};

/** Services whose container this operation took down; already-stopped and absent ones changed nothing. */
export const servicesTakenDown = (receipts: readonly ContainerBringDownReceipt[] | undefined): string[] => [
  ...new Set(
    (receipts ?? []).flatMap((receipt) =>
      receipt.action === "stopped" || receipt.action === "removed" ? [String(receipt.service)] : [],
    ),
  ),
];
