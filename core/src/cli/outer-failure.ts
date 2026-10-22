export const safeOuterFailure = async (
  error: unknown,
  loadRedaction = () => import("@lando/redaction/service"),
): Promise<string> => {
  try {
    const { createStandaloneRedactor } = await loadRedaction();
    return createStandaloneRedactor("secrets").redactString(String(error));
  } catch {
    return "Lando failed. Failure details could not be safely redacted.";
  }
};
