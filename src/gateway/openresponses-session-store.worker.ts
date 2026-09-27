// Only the shared-state read and write workers execute these connection-bound operations.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema.js";
import { hashGatewayResponseSessionBearer } from "./config-revision-token.js";
import {
  MAX_RESPONSE_SESSION_ENTRIES,
  isIncognitoResponseSession,
  RESPONSE_SESSION_RETENTION_MS,
  type ResponseSessionLookup,
  type ResponseSessionWrite,
  type ResponseSessionWorkerOperations,
} from "./openresponses-session-store.types.js";

const TABLE = "openresponses_sessions";
const ensureSchema = createOpenClawStateSchemaEnsurer({
  table: TABLE,
  endMarker: "ON openresponses_sessions(expires_at_ms, response_id);",
  operationLabel: "openresponses.schema",
});

type ResponseSessionCommand = {
  [Key in keyof ResponseSessionWorkerOperations]: {
    type: Key;
    input: ResponseSessionWorkerOperations[Key]["input"];
  };
}[keyof ResponseSessionWorkerOperations];

export function isResponseSessionCommand(command: {
  type: string;
}): command is ResponseSessionCommand {
  return (
    command.type === "openResponses.hashBearer" ||
    command.type === "openResponses.remember" ||
    command.type === "openResponses.prune"
  );
}

export function executeResponseSessionCommand(
  command: ResponseSessionCommand,
  options: OpenClawStateDatabaseOptions,
): string | void {
  switch (command.type) {
    case "openResponses.hashBearer":
      return hashGatewayResponseSessionBearer(command.input.bearer, options);
    case "openResponses.remember":
      return rememberResponseSessionInDatabase(command.input, options);
    case "openResponses.prune":
      return pruneResponseSessionsInDatabase(command.input.nowMs, options);
  }
}

export function lookupResponseSessionInDatabase(
  db: DatabaseSync,
  input: ResponseSessionLookup,
): string | undefined {
  if (!getAdmittedSqliteSchemaFacts(db)?.tables.has(TABLE)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom(TABLE)
      .select("session_key")
      .where("response_id", "=", input.responseId)
      .where("auth_subject", "=", input.authSubject)
      .where("agent_id", "=", input.agentId)
      .where(
        "requested_session_key",
        input.requestedSessionKey ? "=" : "is",
        input.requestedSessionKey ?? null,
      )
      .where("expires_at_ms", ">", input.nowMs),
  );
  return row?.session_key;
}

function pruneInDatabase(db: DatabaseSync, nowMs: number): void {
  const query = getNodeSqliteKysely<DB>(db);
  executeSqliteQuerySync(db, query.deleteFrom(TABLE).where("expires_at_ms", "<=", nowMs));
  executeSqliteQuerySync(
    db,
    query
      .deleteFrom(TABLE)
      .where(
        "response_id",
        "in",
        query
          .selectFrom(TABLE)
          .select("response_id")
          .orderBy("expires_at_ms", "desc")
          .orderBy("response_id", "desc")
          .limit(-1)
          .offset(MAX_RESPONSE_SESSION_ENTRIES),
      ),
  );
}

function rememberResponseSessionInDatabase(
  input: ResponseSessionWrite,
  options: OpenClawStateDatabaseOptions,
): void {
  if (isIncognitoResponseSession(input)) {
    return;
  }
  ensureSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .insertInto(TABLE)
          .values({
            response_id: input.responseId,
            session_key: input.sessionKey,
            auth_subject: input.authSubject,
            agent_id: input.agentId,
            requested_session_key: input.requestedSessionKey ?? null,
            created_at_ms: input.nowMs,
            expires_at_ms: input.nowMs + RESPONSE_SESSION_RETENTION_MS,
          }),
      );
      pruneInDatabase(db, input.nowMs);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    },
    options,
    { operationLabel: "openresponses.remember" },
  );
}

function pruneResponseSessionsInDatabase(
  nowMs: number,
  options: OpenClawStateDatabaseOptions,
): void {
  const { db } = openOpenClawStateDatabase(options);
  if (!getAdmittedSqliteSchemaFacts(db)?.tables.has(TABLE)) {
    return;
  }
  runOpenClawStateWriteTransaction((writer) => pruneInDatabase(writer.db, nowMs), options, {
    operationLabel: "openresponses.prune",
  });
}
