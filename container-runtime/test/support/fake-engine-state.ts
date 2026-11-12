import { type Deferred, Schema } from "effect";

const Mount = Schema.Struct({
  Type: Schema.String,
  Source: Schema.String,
  Target: Schema.String,
  ReadOnly: Schema.optionalKey(Schema.Boolean),
  VolumeOptions: Schema.optionalKey(Schema.Struct({ Subpath: Schema.String })),
});
export const ContainerConfig = Schema.Struct({
  Image: Schema.String,
  Cmd: Schema.optionalKey(Schema.Array(Schema.String)),
  Env: Schema.optionalKey(Schema.Array(Schema.String)),
  Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  OpenStdin: Schema.optionalKey(Schema.Boolean),
  AttachStdin: Schema.optionalKey(Schema.Boolean),
  StdinOnce: Schema.optionalKey(Schema.Boolean),
  HostConfig: Schema.optionalKey(
    Schema.Struct({
      Binds: Schema.optionalKey(Schema.Array(Schema.String)),
      Mounts: Schema.optionalKey(Schema.Array(Mount)),
      VolumesFrom: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
export const VolumeConfig = Schema.Struct({
  Name: Schema.String,
  Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type HelperBehavior = {
  readonly exitCode?: number;
  readonly stdout?: Uint8Array;
  readonly stderr?: Uint8Array;
  readonly stderrChunks?: readonly Uint8Array[];
  readonly frameSize?: number;
  readonly logLimit?: number;
};
export type FakeContainer = {
  readonly id: string;
  readonly name: string;
  readonly config: typeof ContainerConfig.Type;
  readonly behavior: HelperBehavior;
  readonly started: Deferred.Deferred<void>;
  readonly stdinClosed: Deferred.Deferred<void>;
  readonly mounts: readonly { Type: string; Name: string; Destination: string }[];
  status: "created" | "running" | "exited";
  stdin: Uint8Array;
  readonly archives: Map<string, Uint8Array>;
};
export type FakeVolume = typeof VolumeConfig.Type & {
  readonly Driver?: string;
  readonly Options?: Readonly<Record<string, string>>;
};
export type FakeImage = {
  readonly Id: string;
  readonly Size: number;
  readonly RepoDigests?: readonly string[];
  readonly Config?: { readonly Labels: Readonly<Record<string, string>> };
  readonly Labels?: Readonly<Record<string, string>> | null;
  readonly RepoTags?: readonly string[];
  readonly Created?: number;
  readonly archive?: Uint8Array;
};
export class FakeEngineContractError extends Error {
  constructor(readonly request: string) {
    super(`Fake engine does not implement ${request}`);
    this.name = "FakeEngineContractError";
  }
}
export const json = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) });
export const missing = (name: string) => json(404, { message: `No such object: ${name}` });
export const concat = (chunks: readonly Uint8Array[]) => new Uint8Array(Buffer.concat(chunks));
export const frame = (kind: 1 | 2, payload: Uint8Array) => {
  const result = new Uint8Array(8 + payload.length);
  result[0] = kind;
  new DataView(result.buffer).setUint32(4, payload.length, false);
  result.set(payload, 8);
  return result;
};
