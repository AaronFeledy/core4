import { readFile } from "node:fs/promises";
import {
  BunShellScriptEmptyError,
  BunShellScriptFrontMatterError,
  NotImplementedError,
  causeMessage,
} from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import type {
  BunShellScriptDiscoveryError,
  BunShellScriptProblem,
  DiscoveredBunShellScript,
} from "./bun-sh-discovery.ts";
import { bunShellFrontMatterCoordinates, inspectBunShellScriptFrontMatter } from "./bun-sh-frontmatter.ts";
import { canonicalIdFromRelativePath } from "./bun-sh-identity.ts";
import { normalizeBunShellScript } from "./bun-sh-metadata.ts";

export const inspectScriptContent = Effect.fnUntraced(function* (
  scriptPath: string,
  relativePath: string,
  content: string,
): Effect.fn.Return<{
  readonly script?: DiscoveredBunShellScript;
  readonly problems: readonly BunShellScriptProblem[];
}> {
  const problem = (error: BunShellScriptDiscoveryError): BunShellScriptProblem => ({
    file: scriptPath,
    path: [],
    message: error.message,
    suggestion: error.remediation,
    error,
  });
  if (content.trim() === "")
    return {
      problems: [
        problem(
          new BunShellScriptEmptyError({
            message: `.bun.sh script at ${scriptPath} is empty.`,
            path: scriptPath,
            remediation: "Add a `# ---` front-matter block and a script body, or delete the file.",
          }),
        ),
      ],
    };
  const inspected = yield* inspectBunShellScriptFrontMatter(scriptPath, content);
  const { frontMatter } = inspected;
  if (frontMatter === undefined || inspected.problems.length > 0) return { problems: inspected.problems };
  const canonical = canonicalIdFromRelativePath(relativePath);
  if (canonical === null)
    return {
      problems: [
        problem(
          new BunShellScriptFrontMatterError({
            message: `.bun.sh script at ${scriptPath} has no usable canonical name (relative path "${relativePath}").`,
            path: scriptPath,
            remediation:
              "Rename the file or directory so each path segment matches [a-z0-9_-]+ after lower-casing.",
          }),
        ),
      ],
    };
  const script: DiscoveredBunShellScript = {
    id: canonical.id,
    name: canonical.name,
    path: scriptPath,
    relativePath,
    service: frontMatter.service ?? ":host",
    summary: frontMatter.description ?? frontMatter.desc ?? frontMatter.summary ?? "",
    frontMatter,
  };
  const normalized = normalizeBunShellScript(script);
  if (Result.isFailure(normalized))
    return {
      problems: (normalized.failure.issues ?? []).map((issue) => ({
        ...problem(normalized.failure),
        ...issue,
        ...bunShellFrontMatterCoordinates(content, issue.path),
      })),
    };
  return { script, problems: [] };
});

export const scriptServiceProblem = (
  script: DiscoveredBunShellScript,
  content: string,
): BunShellScriptProblem | undefined => {
  if (script.service === ":host") return undefined;
  const error = new NotImplementedError({
    message: `.bun.sh script "${script.id}" at ${script.path} declares service "${script.service}"; service-targeted .bun.sh scripts are not supported.`,
    commandId: "tooling.run",
    remediation:
      "Remove the service field or set it to :host, or use a Landofile tooling task for service execution.",
  });
  return {
    file: script.path,
    path: ["service"],
    message: error.message,
    suggestion: error.remediation,
    error,
    id: script.id,
    ...bunShellFrontMatterCoordinates(content, ["service"]),
  };
};

export const readScriptContent = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf-8"),
    catch: (cause) =>
      new BunShellScriptFrontMatterError({
        message: `Failed to read .bun.sh script at ${path}: ${causeMessage(cause)}`,
        path,
        remediation: "Ensure the script is readable by the current user.",
        cause,
      }),
  });

export const parseScriptFile = Effect.fnUntraced(function* (
  scriptPath: string,
  relativePath: string,
): Effect.fn.Return<DiscoveredBunShellScript, BunShellScriptDiscoveryError> {
  const inspected = yield* inspectScriptContent(
    scriptPath,
    relativePath,
    yield* readScriptContent(scriptPath),
  );
  const first = inspected.problems[0];
  if (first !== undefined) return yield* Effect.fail(first.error);
  if (inspected.script !== undefined) return inspected.script;
  return yield* Effect.die("Script inspection returned neither a script nor problems.");
});
