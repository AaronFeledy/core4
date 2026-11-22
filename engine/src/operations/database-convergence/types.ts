import type { SqlCredentialApplyError, SqlCredentialMember } from "@lando/sdk/errors";
import type { DatabaseClientCheckState, DatabaseConnection, ServiceName } from "@lando/sdk/schema";
import type { Effect } from "effect";

export interface ClientRequest {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface ClientResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly state: DatabaseClientCheckState;
}

export interface AdminCredential {
  readonly user: string;
  readonly password: string;
  readonly explicit?: boolean;
}

export interface CredentialStep {
  readonly members: readonly SqlCredentialMember[];
  readonly request: ClientRequest;
}

export interface AdapterContext {
  readonly family: DatabaseConnection["family"];
  readonly port: number;
  readonly host: string;
  readonly desired: {
    readonly user: string;
    readonly database: string;
    readonly password: string;
    readonly rootPassword?: string;
  };
  readonly applied: {
    readonly user: string;
    readonly password?: string;
    readonly rootPassword?: string;
  };
  readonly service: ServiceName;
  readonly run: (request: ClientRequest) => Effect.Effect<ClientResult, SqlCredentialApplyError>;
  readonly failure: (message: string, exitCode?: number, kind?: "transient") => SqlCredentialApplyError;
}

export interface CredentialAdapter {
  readonly listSiblings?: (
    admin: AdminCredential,
  ) => Effect.Effect<readonly string[], SqlCredentialApplyError>;
  readonly managed?: {
    readonly prove: (candidate: AdminCredential) => Effect.Effect<boolean, SqlCredentialApplyError>;
    readonly adoption: (
      admin: AdminCredential,
      managed: AdminCredential,
    ) => Effect.Effect<ClientRequest, SqlCredentialApplyError>;
  };
  readonly admin: (
    candidate: AdminCredential,
  ) => Effect.Effect<"accepted" | "rejected" | "insufficient-privilege", SqlCredentialApplyError>;
  readonly delta: (
    admin: AdminCredential,
  ) => Effect.Effect<readonly CredentialStep[], SqlCredentialApplyError>;
}
