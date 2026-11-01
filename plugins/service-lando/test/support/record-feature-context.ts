import type { ServiceFeatureContext } from "@lando/sdk/services";

export const recordFeatureContext = (
  input: Pick<ServiceFeatureContext, "serviceType" | "normalizedConfig" | "config" | "connection">,
) => {
  const calls: unknown[][] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push([method, ...args]);
    };
  const ctx: ServiceFeatureContext = {
    serviceName: "web",
    base: "lando",
    primary: true,
    appRoot: "/srv/apps/myapp",
    ...input,
    addEnv: record("addEnv"),
    addMount: record("addMount"),
    setAppMount: record("setAppMount"),
    addBuildStep: record("addBuildStep"),
    addExtension: record("addExtension"),
    addStorage: record("addStorage"),
    addDependency: record("addDependency"),
    addHostAlias: record("addHostAlias"),
    setHealthcheck: record("setHealthcheck"),
    setReadiness: record("setReadiness"),
    setStartupFailureHint: record("setStartupFailureHint"),
    setCerts: record("setCerts"),
    setEntrypoint: record("setEntrypoint"),
    setCommand: record("setCommand"),
    setInit: record("setInit"),
    setArtifact: record("setArtifact"),
    setUser: record("setUser"),
    setWorkingDirectory: record("setWorkingDirectory"),
  };
  return { ctx, calls };
};
