import { Deferred, Effect, Schema, Stream } from "effect";
import type { DataPlaneHttpRequest } from "../../src/data-plane.ts";
import {
  ContainerConfig,
  type FakeContainer,
  type HelperBehavior,
  concat,
  frame,
  json,
  missing,
} from "./fake-engine-state.ts";

export class FakeContainers {
  readonly entries = new Map<string, FakeContainer>();
  readonly history: FakeContainer[] = [];
  behavior: HelperBehavior = {};

  create(input: DataPlaneHttpRequest, url: URL) {
    const config = Schema.decodeUnknownSync(ContainerConfig)(input.body);
    const name = url.searchParams.get("name") ?? `container-${this.history.length + 1}`;
    if (this.get(name) !== undefined) return json(409, { message: "Container name already exists" });
    const mounts = [
      ...(config.HostConfig?.Binds ?? []).map((bind) => {
        const [Name = "", Destination = ""] = bind.split(":");
        return { Type: "volume", Name, Destination };
      }),
      ...(config.HostConfig?.Mounts ?? []).map((mount) => ({
        Type: mount.Type,
        Name: mount.Source,
        Destination: mount.Target,
      })),
      ...(config.HostConfig?.VolumesFrom ?? []).flatMap((source) => {
        const name = source.replace(/:(?:ro|rw)$/u, "");
        const container = this.get(name);
        if (container === undefined) throw new RangeError(`Missing volumes-from container ${name}`);
        return container.mounts;
      }),
    ];
    const container: FakeContainer = {
      id: `fake-container-${this.history.length + 1}`,
      name,
      config,
      behavior: { ...this.behavior },
      mounts,
      started: Deferred.makeUnsafe<void>(),
      stdinClosed: Deferred.makeUnsafe<void>(),
      status: "created",
      stdin: new Uint8Array(),
      archives: new Map(),
    };
    this.entries.set(name, container);
    this.history.push(container);
    return json(201, { Id: container.id, Warnings: [] });
  }

  get(name: string) {
    return this.entries.get(name) ?? [...this.entries.values()].find((value) => value.id === name);
  }

  start(name: string) {
    return Effect.suspend(() => {
      const container = this.get(name);
      if (container === undefined) return Effect.succeed(missing(name));
      container.status = "running";
      return Deferred.succeed(container.started, undefined).pipe(Effect.as(json(204, {})));
    });
  }

  wait(name: string) {
    return Effect.gen({ self: this }, function* () {
      const container = this.get(name);
      if (container === undefined) return missing(name);
      yield* Deferred.await(container.started);
      if (container.config.OpenStdin === true) yield* Deferred.await(container.stdinClosed);
      container.status = "exited";
      return json(200, { StatusCode: container.behavior.exitCode ?? 0 });
    });
  }

  inspect(name: string) {
    const container = this.get(name);
    return container === undefined
      ? missing(name)
      : json(200, {
          Id: container.id,
          Name: `/${container.name}`,
          Config: container.config,
          Mounts: container.mounts,
          State: {
            Status: container.status,
            Running: container.status === "running",
            ExitCode: container.behavior.exitCode ?? 0,
            FinishedAt: container.status === "exited" ? "2026-01-01T00:00:01Z" : "0001-01-01T00:00:00Z",
          },
        });
  }

  remove(name: string) {
    const container = this.get(name);
    if (container === undefined) return missing(name);
    this.entries.delete(container.name);
    return json(204, {});
  }

  list(filters: { readonly volume?: readonly string[]; readonly label?: readonly string[] }) {
    return json(
      200,
      [...this.entries.values()]
        .filter(
          (container) =>
            (filters.volume ?? []).every((name) => container.mounts.some((mount) => mount.Name === name)) &&
            (filters.label ?? []).every((label) => {
              const [key = "", value] = label.split("=");
              return value === undefined
                ? key in (container.config.Labels ?? {})
                : container.config.Labels?.[key] === value;
            }),
        )
        .map((container) => ({
          Id: container.id,
          Names: [`/${container.name}`],
          Labels: container.config.Labels ?? {},
          State: container.status,
          Mounts: container.mounts,
        })),
    );
  }

  output(container: FakeContainer, url: URL) {
    const chunks = [
      ...(url.searchParams.get("stdout") === "true" && container.behavior.stdout !== undefined
        ? [frame(1, container.behavior.stdout)]
        : []),
      ...(url.searchParams.get("stderr") === "true"
        ? (
            container.behavior.stderrChunks ??
            (container.behavior.stderr === undefined ? [] : [container.behavior.stderr])
          ).map((chunk) => frame(2, chunk))
        : []),
    ];
    return chunks.flatMap((chunk) => {
      const size = container.behavior.frameSize ?? chunk.length;
      return Array.from({ length: Math.ceil(chunk.length / size) }, (_, index) =>
        chunk.subarray(index * size, (index + 1) * size),
      );
    });
  }

  attach(input: DataPlaneHttpRequest, name: string, url: URL) {
    return Stream.unwrap(
      Effect.gen({ self: this }, function* () {
        const container = this.get(name);
        if (container === undefined) throw new RangeError(`Missing attach container ${name}`);
        input.onResponseHead?.();
        yield* Deferred.await(container.started);
        if (input.stdin !== undefined) {
          container.stdin = yield* Effect.promise(async () => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of input.stdin ?? []) chunks.push(chunk);
            if (input.signal?.aborted === true)
              throw new DOMException("Socket stream aborted.", "AbortError");
            return concat(chunks);
          });
          yield* Deferred.succeed(container.stdinClosed, undefined);
        }
        return Stream.fromIterable(this.output(container, url));
      }),
    );
  }

  logs(name: string, url: URL) {
    const container = this.get(name);
    if (container === undefined) throw new RangeError(`Missing logs container ${name}`);
    if (container.status !== "exited") throw new RangeError(`Logs requested before ${name} exited`);
    const chunks = this.output(container, url);
    return Stream.fromIterable(
      container.behavior.logLimit === undefined
        ? chunks
        : [concat(chunks).subarray(0, container.behavior.logLimit)],
    );
  }
}
