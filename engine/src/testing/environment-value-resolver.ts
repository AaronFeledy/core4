import { RedactionService } from "@lando/redaction/service";
import { Layer } from "effect";
import * as EnvironmentResolver from "../services/environment-value-resolver.ts";

/** Real environment resolution with runtime redaction; tests supply their SecretStore. */
export const layer = EnvironmentResolver.layer.pipe(Layer.provide(RedactionService.layer));
