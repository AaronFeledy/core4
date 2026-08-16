export const firstEndpointPort = (plan: { readonly endpoints: ReadonlyArray<unknown> }): number => {
  const endpoint = plan.endpoints.find(
    (candidate): candidate is { readonly port: number } =>
      typeof candidate === "object" && candidate !== null && "port" in candidate,
  );
  if (endpoint === undefined) throw new Error("endpoint missing");
  return endpoint.port;
};
