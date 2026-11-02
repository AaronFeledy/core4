import type { Schema } from "effect";

export type NamedContractAccepted = {
  readonly name: string;
  readonly input: unknown;
  readonly expected?: unknown;
};

export type NamedContractRejected = {
  readonly name: string;
  readonly input: unknown;
  readonly expectedErrorFragment: string;
};

/**
 * Sync-decodable/encodable schema at the named-contract fixture boundary.
 * Concrete Effect schemas assign here without casts; service requirements are
 * pinned to `never` so decodeUnknownSync/encodeUnknownSync remain usable.
 */
export type NamedContractSchema = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

export type NamedContractTable = {
  readonly name: string;
  readonly schema: NamedContractSchema;
  readonly accepted: ReadonlyArray<NamedContractAccepted>;
  readonly rejected: ReadonlyArray<NamedContractRejected>;
};
