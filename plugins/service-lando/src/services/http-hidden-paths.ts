/** Match hidden segments in the server-decoded path, except the well-known segment. */
const HIDDEN_PATH_REGEX = String.raw`/\.(?!well-known(?:/|$))`;

export const nginxHiddenPathConfigLines = (): ReadonlyArray<string> => [
  `  location ~ ${HIDDEN_PATH_REGEX} {`,
  "    return 403;",
  "  }",
];

export const apacheHiddenPathDirectives = (): ReadonlyArray<string> => [
  `<LocationMatch "${HIDDEN_PATH_REGEX}">`,
  "Require all denied",
  "</LocationMatch>",
];

/**
 * Caddy's segment-wise matchers for hidden paths.
 *
 * `path` with wildcards on both sides is a substring match, so it catches
 * a path containing `/.`, including nested and URL-decoded dot segments.
 * Only the segment exactly named `.well-known` is exempt, so a path that
 * merely mentions it elsewhere still loses any other hidden segment.
 * `error` keeps the shared status page and its response code.
 */
export const caddyHiddenPathConfigLines = (): ReadonlyArray<string> => [
  "\t@hidden {",
  "\t\tpath */.*",
  "\t\tnot path */.well-known/* */.well-known",
  "\t}",
  "\t@hiddenInWellKnown {",
  "\t\tpath */.well-known/* */.well-known",
  "\t\texpression `{path}.split('/').exists(segment, segment.startsWith('.') && segment != '.well-known')`",
  "\t}",
  "\terror @hidden 403",
  "\terror @hiddenInWellKnown 403",
];
