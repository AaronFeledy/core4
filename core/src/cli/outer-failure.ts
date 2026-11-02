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
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> => {
  const environment = { ...sourceEnv };
  let redaction: Awaited<ReturnType<typeof loadRedaction>>;
  try {
    redaction = await loadRedaction();
  } catch {
    return UNREDACTABLE;
  }
  try {
    return redaction
      .createStandaloneRedactor("secrets", { sourceEnv: environment })
      .redactString(describe(error));
  } catch {
    return UNREDACTABLE;
  }
};
