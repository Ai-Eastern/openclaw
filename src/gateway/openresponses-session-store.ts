import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import {
  isIncognitoResponseSession,
  type ResponseSessionLookup,
  type ResponseSessionWrite,
} from "./openresponses-session-store.types.js";

type Options = Pick<OpenClawStateDatabaseOptions, "path" | "env">;

export async function hashResponseSessionBearer(
  bearer: string,
  options: Options = {},
): Promise<string> {
  return executeOpenClawStateWorker(captureOpenClawStateWorkerContext(options), {
    type: "openResponses.hashBearer",
    input: { bearer },
  });
}

export async function lookupResponseSession(
  input: ResponseSessionLookup,
  options: Options = {},
): Promise<string | undefined> {
  const result = await executeExistingOpenClawStateRead(options, {
    type: "openResponses.lookup",
    input,
  });
  if (result === undefined) {
    return undefined;
  }
  if (result.ok && result.type === "openResponses.lookup") {
    return result.sessionKey;
  }
  throw new Error("Unexpected OpenResponses session lookup result");
}

export async function rememberResponseSession(
  input: ResponseSessionWrite,
  assertCurrent: () => void,
  options: Options = {},
): Promise<void> {
  if (isIncognitoResponseSession(input)) {
    return;
  }
  const context = captureOpenClawStateWorkerContext(options);
  const assertWriteCurrent = () => {
    context.admission.assertCurrent();
    assertCurrent();
  };
  const captured = { ...input };
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "openResponses.remember", input: captured }),
    {
      assertCurrent: assertWriteCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertWriteCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
  assertCurrent();
}

export async function pruneResponseSessions(nowMs: number, options: Options = {}): Promise<void> {
  await runOpenClawStateWorkerOperation(
    captureOpenClawStateWorkerContext(options),
    (scope) => scope.execute({ type: "openResponses.prune", input: { nowMs } }),
    { existingOnly: true },
  );
}
