import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { causeMessage } from "@lando/sdk/errors";
import {
  type FragmentResult,
  type NormalizedInclude,
  type ResolveContext,
  requiredPorts,
} from "./include-context.ts";
import { assertUnderRoot, includeError } from "./include-guard.ts";

export const fileExists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );
export const readText = async (path: string, source: string): Promise<string> => {
  try {
    return await Bun.file(path).text();
  } catch (cause) {
    throw includeError({
      message: `Could not read include fragment ${source} at ${path}: ${causeMessage(cause)}`,
      source,
      kind: "fetch-failed",
    });
  }
};
const userIncludeSubpath = (source: string): string => {
  const subpath = source.slice("user:".length);
  const slashPath = subpath.replace(/\\/gu, "/");
  if (
    subpath.trim() === "" ||
    slashPath.startsWith("/") ||
    /^[A-Za-z]:\//u.test(slashPath) ||
    !/\.ya?ml$/iu.test(slashPath)
  ) {
    throw includeError({
      message: `User include source must be a nonempty relative .yml or .yaml path: ${source}`,
      source,
      kind: "subpath-invalid",
      remediation: "Use user:<relative-profile.yml> below the user includes directory.",
    });
  }
  return slashPath;
};
const assertUserIncludeLexicalPath = (root: string, candidate: string, source: string): void => {
  const subpath = relative(root, candidate).replace(/\\/gu, "/");
  if (subpath === ".." || subpath.startsWith("../") || isAbsolute(subpath))
    throw includeError({
      message: `Include ${source} resolves outside the user includes root.`,
      source,
      kind: "outside-root",
      remediation: "Use an include path that stays inside the user includes root.",
    });
};
export const fetchLocal = async (entry: NormalizedInclude, ctx: ResolveContext): Promise<FragmentResult> => {
  const source = ctx.userOwned ? userIncludeSubpath(`user:${entry.source}`) : entry.source;
  const candidate = isAbsolute(source) ? source : resolve(ctx.sourceRoot, source);
  const root = ctx.userOwned ? requiredPorts(ctx).resolveUserIncludesDir() : ctx.appRoot;
  if (ctx.userOwned) assertUserIncludeLexicalPath(root, candidate, entry.source);
  const filePath = await assertUnderRoot(
    root,
    candidate,
    entry.source,
    ctx.userOwned ? "user includes root" : "app root",
  );
  const userId = `user:${relative(root, filePath).replace(/\\/gu, "/")}`;
  return {
    sourceId: ctx.userOwned ? userId : filePath,
    inventoryId: ctx.userOwned ? userId : `local:${relative(root, filePath).replace(/\\/gu, "/")}`,
    authoredSource: entry.source,
    content: await readText(filePath, entry.source),
    filePath,
    root: dirname(filePath),
    userOwned: ctx.userOwned,
    locked: false,
  };
};
export const fetchUser = async (entry: NormalizedInclude, ctx: ResolveContext): Promise<FragmentResult> => {
  const root = requiredPorts(ctx).resolveUserIncludesDir();
  const candidate = resolve(root, userIncludeSubpath(entry.source));
  assertUserIncludeLexicalPath(root, candidate, entry.source);
  const filePath = await assertUnderRoot(root, candidate, entry.source, "user includes root");
  return {
    sourceId: entry.source,
    inventoryId: entry.source,
    authoredSource: entry.source,
    content: await readText(filePath, entry.source),
    filePath,
    root: dirname(filePath),
    userOwned: true,
    locked: false,
  };
};
