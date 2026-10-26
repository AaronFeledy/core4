import { DataTransferError, SqlCommandFailedError } from "@lando/sdk/errors";
import { Option, Schema } from "effect";

const decodeWireFailure = Schema.decodeUnknownOption(
  Schema.Union([SqlCommandFailedError, DataTransferError]),
);

export const normalizeCommandFailure = (failure: unknown) =>
  failure instanceof SqlCommandFailedError || failure instanceof DataTransferError
    ? Option.some(failure)
    : decodeWireFailure(failure);
