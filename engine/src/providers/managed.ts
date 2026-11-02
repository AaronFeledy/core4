export const taggedErrorRemediation = (cause: unknown): string | undefined => {
  if (cause === null || typeof cause !== "object") return undefined;
  const remediation = Reflect.get(cause, "remediation");
  return typeof remediation === "string" && remediation.length > 0 ? remediation : undefined;
};
