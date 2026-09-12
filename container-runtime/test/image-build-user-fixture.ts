import {
  type ContainerBuildHttpRequest,
  type ContainerBuildHttpResponse,
  buildContainerArtifact,
} from "@lando/container-runtime/image-build";
import { AbsolutePath, AppId, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";

const providerId = ProviderId.make("docker");
const appId = AppId.make("user-build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-01T00:00:00Z"),
  source: "image-build-user-switching.test.ts",
  runtime: 4 as const,
};

export const runBuild = (input: {
  readonly artifact: NonNullable<ServicePlan["artifact"]>;
  readonly steps: readonly Readonly<Record<string, unknown>>[];
  readonly request: (request: ContainerBuildHttpRequest) => Effect.Effect<ContainerBuildHttpResponse>;
  readonly user?: string;
}) => {
  const service: ServicePlan = {
    name: serviceName,
    type: "node",
    provider: providerId,
    primary: true,
    artifact: input.artifact,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: { "@lando/core/service-features": { buildSteps: input.steps } },
    ...(input.user === undefined ? {} : { user: input.user }),
  };
  return buildContainerArtifact(
    {
      app: appId,
      service: serviceName,
      buildKey: "user-key",
      plan: {
        id: appId,
        name: "User Build App",
        slug: "user-build-app",
        root: AbsolutePath.make("/tmp/user-build-app"),
        provider: providerId,
        services: { [serviceName]: service },
        routes: [],
        networks: [],
        stores: [],
        fileSync: [],
        metadata,
        extensions: {},
      },
    },
    { providerId, api: { request: input.request } },
  );
};

export const dockerfileFrom = async (request: ContainerBuildHttpRequest): Promise<string> => {
  const chunks: Uint8Array[] = [];
  if (request.stdin !== undefined) for await (const chunk of request.stdin) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  const sizeText = new TextDecoder().decode(archive.subarray(124, 136)).replace(/\0.*$/u, "").trim();
  const size = Number.parseInt(sizeText || "0", 8);
  return new TextDecoder().decode(archive.subarray(512, 512 + size));
};

export const recordingRequest = (user: string | undefined) => {
  const requests: ContainerBuildHttpRequest[] = [];
  return {
    requests,
    request: (entry: ContainerBuildHttpRequest) => {
      requests.push(entry);
      return Effect.succeed({
        status: 200,
        body: JSON.stringify({ Config: user === undefined ? {} : { User: user } }),
      });
    },
    dockerfiles: () => Promise.all(requests.filter((entry) => entry.method === "POST").map(dockerfileFrom)),
  };
};
