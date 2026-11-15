import { makeTestStateStore } from "@lando/engine/testing/state-store";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect, Redacted } from "effect";
import pem from "./router-certificates.json";

export const routerCertificateAuthority = {
  id: "router-fixture",
  setup: () => Effect.void,
  root: Effect.succeed({ certificate: pem.root, trusted: true }),
  issueCert: () =>
    Effect.succeed({
      certificate: pem.certificate,
      privateKey: Redacted.make(pem.privateKey),
      root: { certificate: pem.root, trusted: true },
    }),
};
export const observeRouterTlsPeer = () => Effect.succeed(pem.certificate);

export const makeRouterStateStore = (): PluginStateStore => {
  const store = makeTestStateStore().service;
  return {
    withLock: store.withLock,
    open: (spec) => store.open({ ...spec, root: { path: AbsolutePath.make("/test/router-state") } }),
  };
};
