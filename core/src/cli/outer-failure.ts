const UNREDACTABLE = "Lando failed. Failure details could not be safely redacted.";

const describe = (error: unknown): string => {
  try {
    return String(error);
  } catch {
    return UNREDACTABLE;
  }
};

export const safeOuterFailure = async (
  error: unknown,
  loadRedaction = () => import("@lando/redaction/service"),
): Promise<string> => {
  let redaction: Awaited<ReturnType<typeof loadRedaction>>;
  try {
    redaction = await loadRedaction();
  } catch {
    // Registered values live in the redaction module, so a process that cannot load it has
    // registered none. Keep the failure diagnosable: this is how broken installs surface.
    return describe(error);
  }
  try {
    return redaction.createStandaloneRedactor("secrets").redactString(String(error));
  } catch {
    return UNREDACTABLE;
  }
};
