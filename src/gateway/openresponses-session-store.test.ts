import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  FIRST_USE_STATE_TABLES,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db-contract.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  lookupResponseSession,
  rememberResponseSession,
  pruneResponseSessions,
} from "./openresponses-session-store.js";
import {
  MAX_RESPONSE_SESSION_ENTRIES,
  RESPONSE_SESSION_RETENTION_MS,
} from "./openresponses-session-store.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
let stateDir: string;
const databaseOptions = (name: string) => ({
  path: path.join(stateDir, "state", `${name}.sqlite`),
  env: { OPENCLAW_STATE_DIR: stateDir },
});
const scope = {
  authSubject: "synthetic-subject",
  agentId: "main",
  requestedSessionKey: "explicit-session",
};
const nowMs = 1_000_000;
const current = () => {};

beforeAll(() => {
  stateDir = tempDirs.make("openresponses-store-");
});

it("keeps reads and Incognito noncreating, then lazily persists scoped continuity across reopen", async () => {
  const options = databaseOptions("reopen");
  const input = { ...scope, responseId: "resp_reopen", nowMs };
  expect(await lookupResponseSession(input, options)).toBeUndefined();
  await pruneResponseSessions(nowMs, options);
  for (const privateKeys of [
    { sessionKey: "agent:main:dashboard:incognito-private" },
    { sessionKey: "dashboard:incognito-private" },
    { sessionKey: "ordinary", requestedSessionKey: "agent:main:dashboard:incognito-private" },
    { sessionKey: "ordinary", requestedSessionKey: "dashboard:incognito-private" },
  ]) {
    await rememberResponseSession({ ...input, ...privateKeys }, current, options);
  }
  expect(existsSync(options.path)).toBe(false);

  const before = openOpenClawStateDatabase(options);
  expect(
    before.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'openresponses_sessions'").get(),
  ).toBeUndefined();
  const metadata = before.db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all();
  await rememberResponseSession(
    { ...input, sessionKey: "agent:main:openresponses:retained" },
    current,
    options,
  );
  await closeOpenClawStateDatabaseAsync();

  expect(await lookupResponseSession({ ...input, nowMs: nowMs + 24 * 60 * 60_000 }, options)).toBe(
    "agent:main:openresponses:retained",
  );
  for (const mismatch of [
    { responseId: "unknown" },
    { authSubject: "other-subject" },
    { agentId: "other-agent" },
    { requestedSessionKey: "other-session" },
    { requestedSessionKey: undefined },
    { nowMs: nowMs + RESPONSE_SESSION_RETENTION_MS },
  ]) {
    expect(await lookupResponseSession({ ...input, ...mismatch }, options)).toBeUndefined();
  }
  const reopened = openOpenClawStateDatabase(options);
  expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(reopened.db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all()).toEqual(
    metadata,
  );
  // The preceding reader's contract does not know this additive table or its index.
  const olderSchema = OPENCLAW_STATE_SCHEMA_SQL.slice(
    0,
    OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS openresponses_sessions"),
  );
  expect(() =>
    assertSqliteSchemaContains(reopened.db, options.path, olderSchema, {
      allowedMissingTables: FIRST_USE_STATE_TABLES.filter(
        (table) => table !== "openresponses_sessions",
      ),
    }),
  ).not.toThrow();
});

it("atomically evicts the oldest rows at capacity and removes expired metadata", async () => {
  const options = databaseOptions("capacity");
  await rememberResponseSession(
    { ...scope, responseId: "resp_reopen", sessionKey: "oldest-session", nowMs },
    current,
    options,
  );
  const created = nowMs + 100;
  runOpenClawStateWriteTransaction(({ db }) => {
    const query = getNodeSqliteKysely<DB>(db);
    // Seed a realistic full store in one transaction; only the final insert exercises eviction.
    for (let offset = 0; offset < MAX_RESPONSE_SESSION_ENTRIES; offset += 100) {
      executeSqliteQuerySync(
        db,
        query.insertInto("openresponses_sessions").values(
          Array.from({ length: 100 }, (_, index) => ({
            response_id: `resp_capacity_${offset + index}`,
            session_key: `session_${offset + index}`,
            auth_subject: scope.authSubject,
            agent_id: scope.agentId,
            requested_session_key: scope.requestedSessionKey,
            created_at_ms: created + offset + index,
            expires_at_ms: created + offset + index + RESPONSE_SESSION_RETENTION_MS,
          })),
        ),
      );
    }
  }, options);
  const latest = created + MAX_RESPONSE_SESSION_ENTRIES;
  await rememberResponseSession(
    { ...scope, responseId: "resp_newest", sessionKey: "newest-session", nowMs: latest },
    current,
    options,
  );
  const lookup = (responseId: string) =>
    lookupResponseSession({ ...scope, responseId, nowMs: latest }, options);
  expect(await lookup("resp_reopen")).toBeUndefined();
  expect(await lookup("resp_capacity_0")).toBeUndefined();
  expect(await lookup("resp_capacity_1")).toBe("session_1");
  expect(await lookup("resp_newest")).toBe("newest-session");
  const count = () => {
    const { db } = openOpenClawStateDatabase(options);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("openresponses_sessions")
        .select((eb) => eb.fn.countAll<number>().as("count")),
    )?.count;
  };
  expect(count()).toBe(MAX_RESPONSE_SESSION_ENTRIES);
  await pruneResponseSessions(latest + RESPONSE_SESSION_RETENTION_MS, options);
  expect(count()).toBe(0);
});

it("rolls back when caller authority expires before commit", async () => {
  const options = databaseOptions("authority");
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  let authorized = true;
  const spy = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          authorized = false;
        }
        admit(request, grant);
      }, attachment),
    );
  const input = { ...scope, responseId: "resp_revoked", nowMs };
  try {
    await expect(
      rememberResponseSession(
        { ...input, sessionKey: "revoked-session" },
        () => {
          if (!authorized) {
            throw new Error("synthetic requester revoked");
          }
        },
        options,
      ),
    ).rejects.toThrow(/revoked|refused/);
    expect(authorized).toBe(false);
  } finally {
    spy.mockRestore();
  }
  expect(await lookupResponseSession(input, options)).toBeUndefined();
});
