import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { selectDefaultImage, selectImageCandidate, selectWorkloadImage } from "../src/pins.ts";

const failed = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  Effect.runSync(Effect.flip(effect));

describe("private runner image candidates", () => {
  test("selects explicit Linux x64 and arm64 immutable child manifests", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const image = Effect.runSync(
        selectImageCandidate({ id: `actions-runner-2.338.1-linux-${arch}`, os: "linux", arch }),
      );
      expect(image.image).toBe(`ghcr.io/actions/actions-runner@${image.manifestDigest}`);
      expect(image.providerAcceptance).toBe("unverified");
      expect(image.buildProvenance).toBe("unverified");
      expect(image.runnerSourceConformanceCommit).toBe("e78522a9a7b01c3bcd7ac0da6e3a9bb6cd513a76");
      expect(image.arch).toBe(arch);
      expect(image.libc).toBe("glibc");
    }
  });

  test("fails workload admission and defaults with fixed safe reasons", () => {
    expect(failed(selectDefaultImage()).reason).toBe("no-reviewed-default");
    for (const arch of ["x64", "arm64"] as const) {
      expect(
        failed(selectWorkloadImage({ id: `actions-runner-2.338.1-linux-${arch}`, os: "linux", arch })).reason,
      ).toBe("provider-acceptance-unverified");
    }
  });

  test("rejects mutable tags, job labels, attestation platforms and caller acceptance overrides", () => {
    const request = { id: "actions-runner-2.338.1-linux-x64", os: "linux", arch: "x64" };
    for (const input of [
      undefined,
      {},
      { ...request, id: "latest" },
      { ...request, id: "ubuntu-latest" },
      { ...request, id: "ubuntu-24.04" },
      { ...request, arch: "arm64" },
      { ...request, arch: "unknown" },
      { ...request, os: "unknown" },
      { ...request, os: "win32" },
      { ...request, providerAcceptance: "accepted" },
      { ...request, image: "secret" },
      { ...request, id: "secret".repeat(10000) },
    ]) {
      const error = failed(selectImageCandidate(input));
      expect(error.reason).toBe("unsupported-image");
      expect(JSON.stringify(error)).not.toContain("secret");
    }
  });
});
