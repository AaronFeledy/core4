/** Strip setup/removal recipes before writing acquisition state (never replay sudo recipes on start). */
export const noticesForPersistence = (notices: readonly string[]): readonly string[] =>
  notices.filter((notice) => !notice.includes("sudo systemctl") && !notice.includes("sudo rm"));

/**
 * Start/ensure: append at most one foreign-helper clause to the existing fallback notice.
 * Configure keeps full explanation/commands as separate notices for the setup surface.
 */
export const displayAcquisitionNotices = (
  hopNotices: readonly string[],
  helperNotices: readonly string[],
  intent: "configure" | "ensure" | undefined,
): readonly string[] => {
  if (helperNotices.length === 0) return hopNotices;
  if (intent === "configure") {
    return [...helperNotices, ...hopNotices];
  }
  const clause = helperNotices[0]?.trim();
  if (clause === undefined || clause.length === 0) return hopNotices;
  if (hopNotices.length === 0) return [clause];
  const out = [...hopNotices];
  const last = out.length - 1;
  const base = out[last] ?? "";
  // One clause only; do not introduce a second notice or removal recipe.
  out[last] = base.includes(clause) ? base : `${base} ${clause}`;
  return out;
};
