import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  captureOpenClawStateWorkerContext,
  prepareOpenClawStateReadSource,
} from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { openSharedStateSqliteWorkerStore } from "./sqlite-worker-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function readAppVersion(databasePath: string) {
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get()
      ?.app_version;
  } finally {
    db.close();
  }
}

describe("existing-schema shared-state workers", () => {
  it.each(["ordinary", "managed"] as const)(
    "preserves installed release metadata when a new %s scope replaces a completed managed scope",
    async (nextScope) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("worker-existing-schema-") };
      const database = openOpenClawStateDatabase({ env });
      const databasePath = database.path;
      database.db
        .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
        .run("synthetic-installed-runtime");
      await closeOpenClawStateDatabaseAsync();

      await withExistingOpenClawStateSchema({ path: databasePath }, async () => {
        const captured = captureOpenClawStateWorkerContext({ path: databasePath, env });
        for (const ownerKey of ["agent:main:first", "agent:main:second"]) {
          expect(
            await executeOpenClawStateWorker(captured, { type: "flows.list", input: { ownerKey } }),
          ).toEqual([]);
          expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
        }
      });

      const readInNewScope = async () => {
        const current = captureOpenClawStateWorkerContext({ path: databasePath, env });
        if (nextScope === "ordinary") {
          await expect(
            openSharedStateSqliteWorkerStore(
              {
                moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
                databasePath,
              },
              current,
            ),
          ).rejects.toThrow("schema policy changed");
        }
        expect(
          await executeOpenClawStateWorker(current, {
            type: "flows.list",
            input: { ownerKey: "agent:main:replacement" },
          }),
        ).toEqual([]);
        expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
      };
      if (nextScope === "managed") {
        await withExistingOpenClawStateSchema({ path: databasePath }, readInNewScope);
      } else {
        await readInNewScope();
      }
    },
  );

  it("admits queued checks only while their captured existing-schema scope remains active", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("worker-expired-schema-") };
    const database = openOpenClawStateDatabase({ env });
    const databasePath = database.path;
    database.db
      .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
      .run("synthetic-installed-runtime");
    await closeOpenClawStateDatabaseAsync();
    const outsideScope = AsyncLocalStorage.snapshot();
    const captured = await withExistingOpenClawStateSchema({ path: databasePath }, async () => {
      const context = captureOpenClawStateWorkerContext({ env });
      expect(() => outsideScope(context.admission.assertCurrent)).not.toThrow();
      expect(
        await outsideScope(() =>
          executeOpenClawStateWorker(context, {
            type: "flows.list",
            input: { ownerKey: "agent:main:queued" },
          }),
        ),
      ).toEqual([]);
      expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
      return { context, source: prepareOpenClawStateReadSource({ path: databasePath, env }) };
    });

    await expect(
      executeOpenClawStateWorker(captured.context, {
        type: "flows.list",
        input: { ownerKey: "agent:main:expired" },
      }),
    ).rejects.toThrow("schema admission has ended");
    for (const read of [
      () => captured.source.current(),
      () => captured.source.workerContext(),
      () => captured.source.withCurrent(() => "must not be admitted"),
    ]) {
      expect(read).toThrow("schema admission has ended");
    }
    expect(readAppVersion(databasePath)).toBe("synthetic-installed-runtime");
  });
});
