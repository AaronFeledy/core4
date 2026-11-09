import { ArtifactTransferError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";
import type { DataPlaneHttpRequest } from "../../src/data-plane.ts";
import type { FakeContainers } from "./fake-engine-containers.ts";
import { matchesLabels } from "./fake-engine-routes.ts";
import { type FakeImage, type FakeVolume, VolumeConfig, concat, json, missing } from "./fake-engine-state.ts";

export class FakeAssets {
  readonly volumes = new Map<string, FakeVolume>();
  readonly images = new Map<string, FakeImage>();
  readonly registry = new Map<string, FakeImage>();
  readonly uploads: Uint8Array[] = [];
  uploadedBytes = 0;
  uploadChunks = 0;
  retainUploads = true;
  loadRef = "sha256:loaded";
  loadFormat: "aux" | "progress" = "aux";
  volumeListFormat: "docker" | "podman" = "docker";

  createVolume(input: DataPlaneHttpRequest) {
    const volume = Schema.decodeUnknownSync(VolumeConfig)(input.body);
    if (this.volumes.has(volume.Name)) return json(409, { message: "Volume already exists" });
    this.volumes.set(volume.Name, volume);
    return json(201, volume);
  }

  inspectVolume(name: string) {
    const volume = this.volumes.get(name);
    return volume === undefined ? missing(name) : json(200, volume);
  }

  listVolumes(labels: readonly string[]) {
    const volumes = [...this.volumes.values()].filter((volume) => matchesLabels(labels, volume.Labels));
    return json(200, this.volumeListFormat === "podman" ? volumes : { Volumes: volumes });
  }

  removeVolume(name: string, containers: FakeContainers) {
    if (!this.volumes.has(name)) return missing(name);
    const holders = [...containers.entries.values()].filter((container) =>
      container.mounts.some((mount) => mount.Name === name),
    );
    if (holders.length > 0)
      return json(409, {
        message: `volume ${name} is in use by ${holders.map((holder) => holder.id).join(", ")}`,
      });
    this.volumes.delete(name);
    return json(204, {});
  }

  commit(input: DataPlaneHttpRequest, url: URL, containers: FakeContainers) {
    const container = containers.get(url.searchParams.get("container") ?? "");
    if (container === undefined) return missing("commit container");
    const config = Schema.decodeUnknownSync(
      Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
    )(input.body);
    const ref = `${url.searchParams.get("repo")}:${url.searchParams.get("tag")}`;
    const image = { Id: "sha256:native-snapshot", Size: 4096, Config: config };
    this.images.set(ref, image);
    return json(201, { Id: image.Id });
  }

  upload(input: DataPlaneHttpRequest) {
    return Effect.tryPromise({
      try: async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of input.stdin ?? []) {
          this.uploadedBytes += chunk.length;
          this.uploadChunks++;
          if (this.retainUploads) chunks.push(chunk);
        }
        const archive = concat(chunks);
        if (this.retainUploads) this.uploads.push(archive);
        return archive;
      },
      catch: (cause) =>
        new ArtifactTransferError({
          providerId: "test",
          operation: "importArtifact",
          message: "Artifact upload failed.",
          remediation: "Retry the upload.",
          cause,
        }),
    });
  }

  load(input: DataPlaneHttpRequest) {
    return this.upload(input).pipe(
      Effect.map((archive) => {
        this.images.set(this.loadRef, { Id: this.loadRef, Size: this.uploadedBytes, archive });
        const result =
          this.loadFormat === "aux"
            ? { aux: { ID: this.loadRef } }
            : { stream: `Loaded image: ${this.loadRef}\n` };
        return {
          status: 200,
          body: `${JSON.stringify({ stream: "Loading layer 1/1\n" })}\n${JSON.stringify(result)}\n`,
        };
      }),
    );
  }
}
