import type { ProviderError } from "@lando/sdk/services";
import { Deferred, Effect, Schema, Stream } from "effect";
import {
  type DataPlaneApiClient,
  type DataPlaneHttpRequest,
  type DataPlaneHttpResponse,
  dataHelperImage,
  volumeWitnessImage,
} from "../../src/data-plane.ts";
import { FakeAssets } from "./fake-engine-assets.ts";
import { FakeContainers } from "./fake-engine-containers.ts";
import {
  type ContainerConfig,
  FakeEngineContractError,
  type HelperBehavior,
  json,
  missing,
} from "./fake-engine-state.ts";

import { Filters, type Operation, route } from "./fake-engine-routes.ts";
export type { Operation } from "./fake-engine-routes.ts";
export class FakeEngine implements DataPlaneApiClient {
  readonly containers = new FakeContainers();
  readonly assets = new FakeAssets();
  readonly requests: { readonly operation: Operation; readonly method: string; readonly path: string }[] = [];
  readonly httpRequests: DataPlaneHttpRequest[] = [];
  onRequest: (input: DataPlaneHttpRequest) => void = () => {};
  private readonly injections = new Map<Operation, Effect.Effect<DataPlaneHttpResponse, ProviderError>[]>();
  readonly observers = new Map<Operation, (input: DataPlaneHttpRequest) => void>();
  readonly feeds = new Map<Operation, Stream.Stream<Uint8Array, ProviderError>>();
  readonly api: DataPlaneApiClient = {
    request: (input) => this.request(input),
    stream: (input) => this.stream(input),
  };

  constructor(behavior: HelperBehavior = {}) {
    this.containers.behavior = behavior;
    for (const ref of ["alpine:3.20", "fixture", "test", dataHelperImage.ref, volumeWitnessImage.ref]) {
      this.assets.images.set(ref, { Id: "sha256:image", Size: 1, RepoDigests: [ref] });
    }
  }

  seedContainer(name: string, config: typeof ContainerConfig.Type = { Image: "fixture" }) {
    const path = `/containers/create?name=${encodeURIComponent(name)}` as const;
    this.containers.create({ method: "POST", path, body: config }, new URL(path, "http://fake-engine"));
    return this;
  }

  fail(operation: Operation, failure: ProviderError | DataPlaneHttpResponse) {
    return this.inject(operation, "status" in failure ? Effect.succeed(failure) : Effect.fail(failure));
  }

  inject(operation: Operation, effect: Effect.Effect<DataPlaneHttpResponse, ProviderError>) {
    const queue = this.injections.get(operation) ?? [];
    queue.push(effect);
    this.injections.set(operation, queue);
    return this;
  }

  hang(operation: Operation, entered?: Deferred.Deferred<void>) {
    return this.inject(
      operation,
      entered === undefined
        ? Effect.never
        : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    );
  }

  private begin(input: DataPlaneHttpRequest) {
    const result = route(input);
    this.requests.push({ operation: result.operation, method: input.method, path: input.path });
    this.httpRequests.push(input);
    this.onRequest(input);
    this.observers.get(result.operation)?.(input);
    const injection = this.injections.get(result.operation)?.shift();
    return { ...result, injection };
  }

  request = (input: DataPlaneHttpRequest): Effect.Effect<DataPlaneHttpResponse, ProviderError> =>
    Effect.suspend(() => {
      const { operation, url, name, injection } = this.begin(input);
      if (injection !== undefined) return injection;
      const filters = () => Schema.decodeUnknownSync(Filters)(url.searchParams.get("filters") ?? "{}");
      switch (operation) {
        case "engine.info":
          return Effect.succeed(json(200, { ID: "fake-engine" }));
        case "container.create": {
          const image = Schema.decodeUnknownSync(Schema.Struct({ Image: Schema.String }))(input.body).Image;
          if (!this.assets.images.has(image)) return Effect.succeed(missing(image));
          const response = this.containers.create(input, url);
          if (response.status === 201) {
            for (const mount of this.containers.history.at(-1)?.mounts ?? []) {
              if (!this.assets.volumes.has(mount.Name))
                this.assets.volumes.set(mount.Name, { Name: mount.Name });
            }
          }
          return Effect.succeed(response);
        }
        case "container.start":
          return this.containers.start(name);
        case "container.wait":
          return this.containers.wait(name);
        case "container.inspect":
          return Effect.sync(() => this.containers.inspect(name));
        case "container.delete":
          return Effect.sync(() => this.containers.remove(name));
        case "container.list":
          return Effect.succeed(this.containers.list(filters()));
        case "volume.create":
          return Effect.sync(() => this.assets.createVolume(input));
        case "volume.inspect":
          return Effect.succeed(this.assets.inspectVolume(name));
        case "volume.list":
          return Effect.succeed(this.assets.listVolumes(filters().label ?? []));
        case "volume.delete":
          return Effect.sync(() => this.assets.removeVolume(name, this.containers));
        case "image.commit":
          return Effect.sync(() => this.assets.commit(input, url, this.containers));
        case "image.inspect":
          return Effect.succeed(
            this.assets.images.has(name) ? json(200, this.assets.images.get(name)) : missing(name),
          );
        case "image.delete":
          return Effect.sync(() => (this.assets.images.delete(name) ? json(200, []) : missing(name)));
        case "image.list": {
          const references = filters().reference ?? [];
          const images = [...this.assets.images.entries()]
            .map(([ref, image]) => ({
              Created: 0,
              RepoTags: [ref],
              Labels: image.Config?.Labels ?? {},
              ...image,
            }))
            .filter(
              (image) =>
                references.length === 0 ||
                references.some((pattern) =>
                  image.RepoTags.some((tag) => tag.startsWith(pattern.replace(/\*$/u, ""))),
                ),
            );
          return Effect.succeed(json(200, images));
        }
        case "image.load":
          return this.assets.load(input);
        case "archive.put": {
          const container = this.containers.get(name);
          if (container === undefined) return Effect.succeed(missing(name));
          return this.assets.upload(input).pipe(
            Effect.map((archive) => {
              const directory = (url.searchParams.get("path") ?? "/").replace(/\/$/u, "");
              const file = new TextDecoder().decode(archive.subarray(0, 100)).split("\0")[0] ?? "";
              container.archives.set(`${directory}/${file}`, archive);
              return json(200, {});
            }),
          );
        }
        default:
          throw new FakeEngineContractError(`request ${operation}`);
      }
    });

  stream = (input: DataPlaneHttpRequest): Stream.Stream<Uint8Array, ProviderError> =>
    Stream.unwrap(
      Effect.suspend(() => {
        const { operation, name, url, injection } = this.begin(input);
        if (injection !== undefined)
          return injection.pipe(
            Effect.map((response) => Stream.make(new TextEncoder().encode(response.body))),
          );
        const feed = this.feeds.get(operation);
        if (feed !== undefined) {
          input.onResponseHead?.();
          return Effect.succeed(feed);
        }
        switch (operation) {
          case "container.attach":
            return Effect.succeed(this.containers.attach(input, name, url));
          case "container.logs":
            return Effect.succeed(this.containers.logs(name, url));
          case "archive.get": {
            const archive = this.containers.get(name)?.archives.get(url.searchParams.get("path") ?? "/");
            if (archive === undefined) throw new FakeEngineContractError(`missing archive ${name}`);
            return Effect.succeed(Stream.make(archive));
          }
          case "image.get": {
            const archive = this.assets.images.get(name)?.archive;
            if (archive === undefined) throw new FakeEngineContractError(`missing image archive ${name}`);
            return Effect.succeed(Stream.make(archive));
          }
          case "image.pull": {
            const repo = url.searchParams.get("fromImage") ?? "";
            const tag = url.searchParams.get("tag") ?? "latest";
            const ref = `${repo}${tag.startsWith("sha256:") ? "@" : ":"}${tag}`;
            const entry = [...this.assets.registry.entries()].find(
              ([candidate]) => candidate.replace(/:[^/:@]+(?=@)/u, "") === ref,
            );
            if (entry === undefined) throw new FakeEngineContractError(`missing registry image ${ref}`);
            const [registered, image] = entry;
            this.assets.images.set(registered, image);
            return Effect.succeed(Stream.make(new TextEncoder().encode('{"status":"Pull complete"}\n')));
          }
          default:
            throw new FakeEngineContractError(`stream ${operation}`);
        }
      }),
    );
}
