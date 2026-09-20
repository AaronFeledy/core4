/**
 * Process-cwd handling for tests that have to run from a temporary directory.
 *
 * `process.cwd()` is process-global, so a helper that moves it is shared
 * mutable state between tests in the same file. Bun does not cancel the body
 * of a test that exceeds its time budget - it records the failure and starts
 * the next test while that body keeps running - so such a helper's teardown
 * routinely lands in the middle of a later test.
 *
 * Three rules keep that teardown harmless, and each is load-bearing:
 *
 * 1. The call holding the cwd restores a directory the suite never removes,
 *    never whatever cwd happened to be current on entry. An ambient cwd is
 *    frequently an earlier test's temp root, removed before the restore runs.
 * 2. A call that no longer holds the cwd leaves it alone, so its teardown
 *    cannot move a live test.
 * 3. Unless the live test is standing inside a root the exiting call's caller
 *    is about to remove. A body that chdirs back into its own root on the way
 *    out puts the cwd there long after losing it, and the removal that follows
 *    would leave the live test with no working directory at all.
 *
 * Rule 1 means the cwd is handed to the anchor rather than to an enclosing
 * call: these fixtures overlap in time without nesting lexically, and the two
 * are indistinguishable from a plain stack.
 *
 * The same three rules apply to process-global env vars such as
 * `LANDO_USER_CACHE_ROOT`: restoring the ambient value captured on entry lets
 * an outlived call wipe a later test's root and then delete the directory the
 * abandoned body is still reading.
 */
import { sep } from "node:path";

/** Captured at module load, before any test runs, so no test can remove it. */
const anchor = process.cwd();

interface Frame {
  readonly token: symbol;
  readonly dir: string;
  readonly roots: ReadonlyArray<string>;
}

const frames: Frame[] = [];

/** `process.cwd()` throws once the directory it names has been removed. */
const currentDir = (): string | undefined => {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
};

const isInside = (dir: string, root: string): boolean =>
  dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * Runs `body` with the process cwd set to `dir`.
 *
 * `roots` names every temporary directory the caller removes once this call
 * settles; it defaults to `dir` and must list both roots for a fixture that
 * creates two.
 */
export const withCwd = async <T>(
  dir: string,
  body: () => Promise<T>,
  roots: ReadonlyArray<string> = [dir],
): Promise<T> => {
  const token = Symbol("lando-test-cwd");
  frames.push({ token, dir, roots });
  process.chdir(dir);
  try {
    return await body();
  } finally {
    const index = frames.findIndex((frame) => frame.token === token);
    if (index >= 0) {
      const holdsCwd = index === frames.length - 1;
      frames.splice(index, 1);
      const here = currentDir();
      if (holdsCwd) process.chdir(anchor);
      else if (here === undefined || roots.some((root) => isInside(here, root))) {
        process.chdir(frames.at(-1)?.dir ?? anchor);
      }
    }
  }
};

const envAnchors = new Map<string, string | undefined>();
const envFrames = new Map<string, Array<{ readonly token: symbol; readonly value: string }>>();

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) process.env[name] = undefined;
  else process.env[name] = value;
};

/**
 * Sets `process.env[name]` for `body`. Unlike {@link withCwd}, a later owner
 * that exits while an earlier call remains restores that earlier value rather
 * than the module-load anchor: the earlier cache directory still exists, and
 * unsetting the variable sends the abandoned body into the host cache.
 */
export const withEnvVar = async <T>(name: string, value: string, body: () => Promise<T>): Promise<T> => {
  if (!envAnchors.has(name)) envAnchors.set(name, process.env[name]);
  const stack = envFrames.get(name) ?? [];
  envFrames.set(name, stack);
  const token = Symbol(name);
  stack.push({ token, value });
  process.env[name] = value;
  try {
    return await body();
  } finally {
    const index = stack.findIndex((frame) => frame.token === token);
    if (index >= 0) {
      const holdsEnv = index === stack.length - 1;
      stack.splice(index, 1);
      if (holdsEnv) restoreEnv(name, stack.at(-1)?.value ?? envAnchors.get(name));
      else if (process.env[name] === value) restoreEnv(name, stack.at(-1)?.value ?? envAnchors.get(name));
    }
  }
};
