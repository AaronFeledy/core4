import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";

/** A local Docker runtime recognized by the socket path it publishes. */
export interface DockerRuntime {
  readonly name: string;
  readonly vmMediated: boolean;
  readonly startCommand?: string;
}

const socketPath = (endpoint: string): string =>
  (endpoint.startsWith("unix://") ? endpoint.slice("unix://".length) : endpoint).replaceAll("\\", "/");

/** Returns undefined for an endpoint no known runtime publishes; callers must not guess one. */
export const dockerRuntimeForEndpoint = (
  endpoint: string,
  platform: HostPlatform,
): DockerRuntime | undefined => {
  const path = socketPath(endpoint);
  const colimaProfile = /(?:^|\/)\.colima\/([^/]+)\/docker\.sock$/u.exec(path)?.[1];
  if (colimaProfile !== undefined) {
    return {
      name: "Colima",
      vmMediated: true,
      startCommand: colimaProfile === "default" ? "colima start" : `colima start --profile ${colimaProfile}`,
    };
  }
  const limaInstance = /(?:^|\/)\.lima\/([^/]+)\/sock\/docker\.sock$/u.exec(path)?.[1];
  if (limaInstance !== undefined) {
    return { name: "Lima", vmMediated: true, startCommand: `limactl start ${limaInstance}` };
  }
  if (/(?:^|\/)\.orbstack\/run\/docker\.sock$/u.test(path)) {
    return { name: "OrbStack", vmMediated: true, startCommand: "orb start" };
  }
  if (/(?:^|\/)\.rd\/docker\.sock$/u.test(path)) return { name: "Rancher Desktop", vmMediated: true };
  if (/(?:^|\/)\.docker\/(?:run|desktop)\//u.test(path)) return { name: "Docker Desktop", vmMediated: true };
  if (hostPlatformFamily(platform) === "linux" && /^\/run\/user\/\d+\/docker\.sock$/u.test(path)) {
    return { name: "rootless Docker", vmMediated: false, startCommand: "systemctl --user start docker" };
  }
  // On WSL this socket may be Docker Desktop's integration, so only native Linux names the engine.
  if (platform === "linux" && (path === "/var/run/docker.sock" || path === "/run/docker.sock")) {
    return { name: "Docker Engine", vmMediated: false, startCommand: "sudo systemctl start docker" };
  }
  return undefined;
};

export const unreachableDockerRemediation = (endpoint: string, platform: HostPlatform): string => {
  const runtime = dockerRuntimeForEndpoint(endpoint, platform);
  const start =
    runtime === undefined
      ? "Start Docker Desktop or Docker Engine"
      : runtime.startCommand === undefined
        ? `Start ${runtime.name}`
        : `Start ${runtime.name} (\`${runtime.startCommand}\`)`;
  // The endpoint stays out of this text: a DOCKER_HOST or context URL can carry credentials.
  return `${start}, then retry. Run \`lando doctor --provider=docker\` to see which endpoint Lando resolved and why.`;
};
