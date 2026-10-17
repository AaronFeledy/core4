import { posix, win32 } from "node:path";

import { FileNotFoundError } from "@lando/sdk/errors";
import { type MountPlan, type ServicePlan, parseContainerDestination } from "@lando/sdk/schema";
import type { FileSystem, FileSystemError } from "@lando/sdk/services";
import { type Context, Effect, Schema } from "effect";

/** Host mount sources and the container paths git resolves from the same gitfile strings. */
const GitDirectories = Schema.Struct({
  gitDir: Schema.String,
  commonDir: Schema.String,
  containerGitDir: Schema.String,
  containerCommonDir: Schema.String,
});
type GitDirectories = typeof GitDirectories.Type;

export const GitHostCheck = Schema.Struct({
  /** Host path of the app root's `.git` entry. */
  path: Schema.String,
  /** Container app-mount target that relative gitfile paths resolve from. */
  target: Schema.String,
  directories: Schema.NullOr(GitDirectories),
});
export type GitHostCheck = typeof GitHostCheck.Type;

const metadataPath = (value: string): string | null =>
  value.length === 0 || /[\r\n\0]/u.test(value) || (!value.startsWith("/") && win32.isAbsolute(value))
    ? null
    : value;

export const readGitDirectories = Effect.fnUntraced(
  function* (
    path: string,
    target: string,
    fileSystem: Context.Service.Shape<typeof FileSystem> | undefined,
  ): Effect.fn.Return<GitDirectories | null, FileSystemError> {
    if (fileSystem === undefined || !path.startsWith("/") || !target.startsWith("/")) return null;
    if (!(yield* fileSystem.stat(path)).isFile) return null;
    const content = yield* fileSystem.readText(path);
    if (!content.startsWith("gitdir:")) return null;
    const gitPath = metadataPath(content.slice("gitdir:".length).trim());
    if (gitPath === null) return null;
    const gitDir = posix.resolve(posix.dirname(path), gitPath);
    const containerGitDir = posix.resolve(target, gitPath);
    const commonText = yield* fileSystem.readText(posix.join(gitDir, "commondir")).pipe(
      Effect.catchIf(
        (error) => error instanceof FileNotFoundError,
        () => Effect.succeed(null),
      ),
    );
    const common = commonText === null ? null : metadataPath(commonText.trim());
    if (commonText !== null && common === null) return null;
    const commonDir = common === null ? gitDir : posix.resolve(gitDir, common);
    const containerCommonDir = common === null ? containerGitDir : posix.resolve(containerGitDir, common);
    for (const destination of [gitDir, commonDir, containerGitDir, containerCommonDir]) {
      if (!parseContainerDestination(destination).ok) return null;
    }
    // Only real Git directories are mounted; `gitdir: /etc` must not expose arbitrary host paths.
    if (!(yield* fileSystem.stat(posix.join(gitDir, "HEAD"))).isFile) return null;
    if (!(yield* fileSystem.stat(posix.join(commonDir, "HEAD"))).isFile) return null;
    return { gitDir, commonDir, containerGitDir, containerCommonDir };
  },
  Effect.catch(() => Effect.succeed(null)),
);

export const sameGitDirectories = (left: GitDirectories | null, right: GitDirectories | null): boolean =>
  left === null || right === null
    ? left === right
    : left.gitDir === right.gitDir &&
      left.commonDir === right.commonDir &&
      left.containerGitDir === right.containerGitDir &&
      left.containerCommonDir === right.containerCommonDir;

export const worktreeGitMounts = (
  service: ServicePlan,
  directories: GitHostCheck["directories"],
): readonly MountPlan[] => {
  const appMount = service.appMount;
  if (directories === null || appMount === undefined) return [];
  const gitTarget = parseContainerDestination(`${appMount.target}/.git`);
  if (gitTarget.ok && service.storage.some((mount) => mount.target === gitTarget.value)) return [];
  const { gitDir, commonDir, containerGitDir, containerCommonDir } = directories;
  const pairs: ReadonlyArray<readonly [source: string, target: string]> =
    containerGitDir === containerCommonDir || containerGitDir.startsWith(`${containerCommonDir}/`)
      ? [[commonDir, containerCommonDir]]
      : [
          [commonDir, containerCommonDir],
          [gitDir, containerGitDir],
        ];
  return pairs.flatMap(([source, destination]): MountPlan[] => {
    const target = parseContainerDestination(destination);
    if (!target.ok) return [];
    // Authored mounts and storage at the destination always win over derived Git support.
    if (
      service.mounts.some((mount) => mount.target === target.value) ||
      service.storage.some((mount) => mount.target === target.value)
    )
      return [];
    return [
      {
        type: "bind",
        source,
        target: target.value,
        readOnly: appMount.readOnly,
        createHostPath: false,
        realization: "passthrough",
      },
    ];
  });
};
