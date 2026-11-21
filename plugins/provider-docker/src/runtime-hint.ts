import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";

export type DockerRuntimeHintId =
  | "colima"
  | "lima"
  | "orbstack"
  | "rancher-desktop"
  | "docker-desktop"
  | "linux-engine"
  | "rootless";

export interface DockerRuntimeHint {
  readonly id: DockerRuntimeHintId;
  readonly runtime: string;
  readonly startCommand?: string;
  readonly vmMediated: boolean;
}

const endpointPath = (endpoint: string): string => {
  const raw = endpoint.startsWith("unix://") ? endpoint.slice("unix://".length) : endpoint;
  return raw.replaceAll("\\", "/");
};

const hint = (
  id: DockerRuntimeHintId,
  runtime: string,
  vmMediated: boolean,
  startCommand?: string,
): DockerRuntimeHint => ({
  id,
  runtime,
  vmMediated,
  ...(startCommand === undefined ? {} : { startCommand }),
});

/**
 * Classify a Docker endpoint path as a known local runtime.
 * Unrecognized endpoints return `undefined`; callers must not invent a fallback runtime.
 */
export const runtimeHintForEndpoint = (endpoint: string): DockerRuntimeHint | undefined => {
  const path = endpointPath(endpoint);

  const colima = path.match(/(?:^|\/)\.colima\/([^/]+)\/docker\.sock$/u);
  const colimaProfile = colima?.[1];
  if (colimaProfile !== undefined) {
    return hint(
      "colima",
      "Colima",
      true,
      colimaProfile === "default" ? "colima start" : `colima start --profile ${colimaProfile}`,
    );
  }

  const lima = path.match(/(?:^|\/)\.lima\/([^/]+)\/sock\/docker\.sock$/u);
  const limaInstance = lima?.[1];
  if (limaInstance !== undefined) {
    return hint("lima", "Lima", true, `limactl start ${limaInstance}`);
  }

  if (/(?:^|\/)\.orbstack\/run\/docker\.sock$/u.test(path)) {
    return hint("orbstack", "OrbStack", true, "orb start");
  }

  if (/(?:^|\/)\.rd\/docker\.sock$/u.test(path)) {
    return hint("rancher-desktop", "Rancher Desktop", true);
  }

  if (/(?:^|\/)\.docker\/(?:run|desktop)(?:\/|$)/u.test(path)) {
    return hint("docker-desktop", "Docker Desktop", true);
  }

  if (/(?:^|\/)run\/user\/\d+\/docker\.sock$/u.test(path)) {
    return hint("rootless", "rootless Docker", false, "systemctl --user start docker");
  }

  if (path === "/var/run/docker.sock") {
    return hint("linux-engine", "Docker Engine", false, "sudo systemctl start docker");
  }

  return undefined;
};

const DOCTOR_POINTER =
  "Run `lando doctor --provider=docker` to inspect the Docker provider, then retry `lando start`.";

const hintAppliesOnPlatform = (hint: DockerRuntimeHint, platform: HostPlatform): boolean => {
  const family = hostPlatformFamily(platform);
  if (hint.id === "linux-engine" || hint.id === "rootless") return family === "linux";
  return true;
};

export const unreachableDockerRemediation = (endpoint: string, platform: HostPlatform): string => {
  const classified = runtimeHintForEndpoint(endpoint);
  const hint =
    classified !== undefined && hintAppliesOnPlatform(classified, platform) ? classified : undefined;
  const start =
    hint === undefined
      ? "Start Docker Desktop or Docker Engine"
      : hint.startCommand === undefined
        ? `Start ${hint.runtime}`
        : `Start ${hint.runtime} (\`${hint.startCommand}\`)`;
  return `${start}, verify access to the configured Docker socket, then retry the command. ${DOCTOR_POINTER}`;
};
