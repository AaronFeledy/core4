/**
 * Default Landofile basenames.
 *
 * Custom file basenames and pre/post lists live in global config, not in
 * Landofiles. Overlay merge itself lives in `@lando/sdk/landofile`.
 */

export const DEFAULT_PRE_LANDOFILES = [".lando.base.yml", ".lando.dist.yml", ".lando.upstream.yml"] as const;

export const DEFAULT_LANDOFILE = ".lando.yml" as const;

export const DEFAULT_POST_LANDOFILES = [".lando.local.yml", ".lando.user.yml"] as const;
