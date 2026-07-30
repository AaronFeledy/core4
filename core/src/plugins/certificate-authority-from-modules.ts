import { Either, Layer } from "effect";

import type { LandoPluginModule } from "@lando/sdk/plugins";

import { CertificateAuthorityUnavailableLive } from "../subsystems/certs/api.ts";
import { BUNDLED_PLUGIN_MODULES } from "./generated/bundled.ts";
import { makePluginCapabilityIndex } from "./module-set.ts";

export const makeBundledCertificateAuthorityLive = (
  modules: ReadonlyArray<LandoPluginModule> = BUNDLED_PLUGIN_MODULES,
) => {
  const index = makePluginCapabilityIndex(modules);
  if (Either.isLeft(index)) return Layer.die(index.left);
  const layers = [...index.right.certificateAuthorities.values()];
  if (layers.length === 0) return CertificateAuthorityUnavailableLive;
  if (layers.length === 1) return layers[0] ?? CertificateAuthorityUnavailableLive;
  return Layer.die(
    new Error(
      `Multiple bundled certificate authorities are installed (${[...index.right.certificateAuthorities.keys()].join(", ")}); configure an explicit authority before planning certificates.`,
    ),
  );
};

export const BundledCertificateAuthorityLive = makeBundledCertificateAuthorityLive();
