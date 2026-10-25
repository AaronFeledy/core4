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
    return describe(error);
  }
  try {
    return redaction.createStandaloneRedactor("secrets").redactString(String(error));
  } catch {
    return UNREDACTABLE;
  }
};
