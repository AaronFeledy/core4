export const OCCUPANCY_HOLDER_KINDS = [
  "ddev",
  "lando3",
  "docksal",
  "apache",
  "nginx",
  "caddy",
  "iis",
  "unknown",
] as const;

export type OccupancyHolderKind = (typeof OCCUPANCY_HOLDER_KINDS)[number];

export type OccupancySolution = {
  readonly kind: "manual";
  readonly description: string;
  readonly command?: string;
};

export type OccupancyHolderInput = {
  readonly comm?: string;
  readonly cmdline?: string;
};

export type OccupancyHolderIdentity = {
  readonly comm?: string;
  readonly pid?: number;
};

const assertNever = (value: never): never => {
  throw new Error(`unexpected occupancy holder kind: ${String(value)}`);
};

const haystackOf = (input: OccupancyHolderInput): string =>
  `${input.comm ?? ""} ${input.cmdline ?? ""}`.toLowerCase();

const includesAny = (haystack: string, needles: ReadonlyArray<string>): boolean =>
  needles.some((needle) => haystack.includes(needle));

/**
 * Ordered substring classification of a process occupying preferred host ports.
 * Concatenates comm + cmdline and matches case-insensitively.
 */
export const classifyOccupancyHolder = (input: OccupancyHolderInput): OccupancyHolderKind => {
  const haystack = haystackOf(input);

  // ddev: ddev-router, ddev, or (traefik AND ddev) — any haystack containing "ddev"
  if (haystack.includes("ddev")) {
    return "ddev";
  }

  // lando3: landoproxyhyperion / landoproxy — not bare "lando"
  if (includesAny(haystack, ["landoproxyhyperion", "landoproxy"])) {
    return "lando3";
  }

  if (includesAny(haystack, ["docksal-vhost-proxy", "fin"])) {
    return "docksal";
  }

  if (includesAny(haystack, ["apache2", "httpd"])) {
    return "apache";
  }

  if (haystack.includes("nginx")) {
    return "nginx";
  }

  if (haystack.includes("caddy")) {
    return "caddy";
  }

  if (includesAny(haystack, ["w3wp", "iisexpress", "iis", "http.sys"])) {
    return "iis";
  }

  return "unknown";
};

export const solutionsForOccupancyHolder = (
  kind: OccupancyHolderKind,
  identity?: OccupancyHolderIdentity,
): ReadonlyArray<OccupancySolution> => {
  switch (kind) {
    case "ddev":
      return [
        {
          kind: "manual",
          description: "Power off DDEV so it releases ports 80 and 443.",
          command: "ddev poweroff",
        },
        {
          kind: "manual",
          description: "Move the DDEV router off 80/443 onto 8080/8443.",
          command: "ddev config global --router-http-port=8080 --router-https-port=8443",
        },
        {
          kind: "manual",
          description: "Restart DDEV after changing router ports so the new bind takes effect.",
          command: "ddev restart",
        },
      ];
    case "lando3":
      return [
        {
          kind: "manual",
          description: "Power off Lando v3 in that install so landoproxy releases 80/443.",
          command: "lando poweroff",
        },
      ];
    case "docksal":
      return [
        {
          kind: "manual",
          description: "Stop the Docksal proxy (docksal-vhost-proxy) so it releases 80/443.",
          command: "fin stop",
        },
      ];
    case "apache":
      return [
        {
          kind: "manual",
          description: "Stop the system Apache service so it no longer binds 80/443.",
        },
      ];
    case "nginx":
      return [
        {
          kind: "manual",
          description: "Stop the system nginx service so it no longer binds 80/443.",
        },
      ];
    case "caddy":
      return [
        {
          kind: "manual",
          description: "Stop Caddy so it no longer binds 80/443.",
        },
      ];
    case "iis":
      return [
        {
          kind: "manual",
          description: "Stop the IIS site or HTTP.sys binding on ports 80/443.",
        },
      ];
    case "unknown": {
      const comm = identity?.comm;
      const pid = identity?.pid;
      const hasComm = comm !== undefined && comm.length > 0;
      const hasPid = pid !== undefined;
      const whoLabel =
        hasComm && hasPid
          ? `process "${comm}" (pid ${String(pid)})`
          : hasComm
            ? `process "${comm}"`
            : hasPid
              ? `pid ${String(pid)}`
              : "the process holding the port";
      return [
        {
          kind: "manual",
          description: `Stop ${whoLabel}, or change router.httpPort / router.httpsPort so Lando uses free ports.`,
        },
      ];
    }
    default:
      return assertNever(kind);
  }
};
