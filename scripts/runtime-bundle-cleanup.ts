/**
 * Runs `work`, then starts every cleanup that `cleanup` returns and waits for all of them.
 * A `work` failure is rethrown as-is (even `undefined`) after cleanup; a cleanup failure
 * surfaces only when `work` succeeded.
 */
export const runWithCleanup = async <A>(
  work: () => Promise<A>,
  cleanup: () => ReadonlyArray<Promise<unknown>>,
): Promise<A> => {
  let outcome: { readonly ok: true; readonly value: A } | { readonly ok: false; readonly cause: unknown };
  try {
    outcome = { ok: true, value: await work() };
  } catch (cause) {
    outcome = { ok: false, cause };
  }
  const results = await Promise.allSettled(cleanup());
  if (!outcome.ok) throw outcome.cause;
  const cleanupFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (cleanupFailure !== undefined) throw cleanupFailure.reason;
  return outcome.value;
};
