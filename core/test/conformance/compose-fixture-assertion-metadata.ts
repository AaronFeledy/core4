export type ComposePlanAssertion =
  | "artifact-build"
  | "artifact-ref"
  | "dependencies"
  | "direct"
  | "environment"
  | "healthcheck"
  | "internal-endpoints"
  | "published-endpoints"
  | "tmpfs"
  | "volumes";

export interface ComposeFixtureAssertionMetadata {
  readonly assertion: ComposePlanAssertion;
  readonly configTarget?: string;
}

export const COMPOSE_FIXTURE_ASSERTIONS: Readonly<Record<string, ComposeFixtureAssertionMetadata>> = {
  build: { assertion: "artifact-build" },
  command: { assertion: "direct" },
  depends_on: { assertion: "dependencies", configTarget: "dependsOn" },
  entrypoint: { assertion: "direct" },
  env_file: { assertion: "environment", configTarget: "envFile" },
  environment: { assertion: "environment" },
  expose: { assertion: "internal-endpoints" },
  healthcheck: { assertion: "healthcheck" },
  image: { assertion: "artifact-ref" },
  ports: { assertion: "published-endpoints" },
  tmpfs: { assertion: "tmpfs" },
  user: { assertion: "direct" },
  volumes: { assertion: "volumes" },
  working_dir: { assertion: "direct", configTarget: "workingDirectory" },
};
