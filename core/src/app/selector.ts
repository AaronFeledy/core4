import { Either } from "effect";

import type { AppSelector } from "@lando/sdk/app";
import { AppResolveError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";

/**
 * The structurally-validated form of an `AppSelector`, classified by the
 * highest-precedence field present (`id > landofile > root > cwd`). Resolution
 * (`resolveApp`) consumes this and performs the cross-field and existence
 * checks that need filesystem/registry access.
 */
export type NormalizedAppSelector =
  | { readonly kind: "cwd"; readonly cwd?: string }
  | { readonly kind: "root"; readonly root: string; readonly cwd?: string }
  | { readonly kind: "landofile-path"; readonly path: string; readonly root?: string; readonly cwd?: string }
  | {
      readonly kind: "landofile-shape";
      readonly shape: LandofileShape;
      readonly root: string;
      readonly cwd?: string;
    }
  | { readonly kind: "id"; readonly id: string; readonly root?: string; readonly cwd?: string };

const present = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * Structural validation for `AppSelector` (precedence
 * `id > landofile > root > cwd`). Pure: it never touches the filesystem or the
 * app registry, so it is fully unit-testable. Cross-field validation that needs
 * resolution (e.g. an `id` matching the app at `root`) happens in `resolveApp`.
 */
export const normalizeAppSelector = (
  selector?: AppSelector,
): Either.Either<NormalizedAppSelector, AppResolveError> => {
  if (selector === undefined) return Either.right({ kind: "cwd" });

  const candidate = selector as {
    readonly id?: unknown;
    readonly landofile?: unknown;
    readonly root?: unknown;
    readonly cwd?: unknown;
  };
  const hasId = present(candidate.id);
  const hasLandofile = present(candidate.landofile);
  const hasRoot = present(candidate.root);
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd : undefined;
  const root = typeof candidate.root === "string" ? candidate.root : undefined;

  if (hasId && hasLandofile) {
    return Either.left(
      new AppResolveError({
        message: "App selector cannot combine `id` and `landofile`; choose one.",
        reason: "ambiguous",
        detail: "id+landofile",
      }),
    );
  }

  if (hasId) {
    const id = candidate.id as string;
    return Either.right({
      kind: "id",
      id,
      ...(root === undefined ? {} : { root }),
      ...(cwd === undefined ? {} : { cwd }),
    });
  }

  if (hasLandofile) {
    if (typeof candidate.landofile === "string") {
      return Either.right({
        kind: "landofile-path",
        path: candidate.landofile,
        ...(root === undefined ? {} : { root }),
        ...(cwd === undefined ? {} : { cwd }),
      });
    }
    if (root === undefined) {
      return Either.left(
        new AppResolveError({
          message: "A decoded Landofile selector must be paired with an explicit `root`.",
          reason: "missing-root",
          detail: "landofile",
        }),
      );
    }
    return Either.right({
      kind: "landofile-shape",
      shape: candidate.landofile as LandofileShape,
      root,
      ...(cwd === undefined ? {} : { cwd }),
    });
  }

  if (hasRoot && root !== undefined) {
    return Either.right({ kind: "root", root, ...(cwd === undefined ? {} : { cwd }) });
  }

  return Either.right({ kind: "cwd", ...(cwd === undefined ? {} : { cwd }) });
};
