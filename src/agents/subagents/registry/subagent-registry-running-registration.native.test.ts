import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve fixture setup before importing the registry's owners.
// oxfmt-ignore
import { useSubagentPersistenceFixture } from "./subagent-registry.persistence-fixture.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import * as workerCpu from "../../../infra/worker-cpu.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import * as detachedTaskRuntime from "../../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../../tasks/detached-task-runtime.test-support.js";
import { findTaskByRunIdAsync } from "../../../tasks/task-registry-query.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { holdStateDatabaseWriteTransaction } from "../../../test-utils/state-database-contention.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as registryState from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  readSubagentSessionStore,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { releaseSubagentRun, testing } from "./subagent-registry.test-helpers.js";
import type { SubagentRegistrationScope } from "./subagent-registry.types.js";

const fixture = useSubagentPersistenceFixture();

it("keeps ordinary subagent registration responsive while a SQLite writer is held", async () => {
  await fixture.allocateStateDir();
  vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
  openOpenClawStateDatabase();
  const context = captureOpenClawStateWorkerContext();
  expect(context.admission.databasePath.startsWith(fixture.stateDir)).toBe(true);
  const runId = "contended-registration";
  const childSessionKey = "agent:main:subagent:contended-registration";
  // Observe native entry/return without changing SQLite's lock wait or worker protocol.
  const nativeBegin = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const counts = new Int32Array(workerData.testRegistrationBegin);
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql !== "BEGIN IMMEDIATE" || this.location() !== workerData.testRegistrationPath ||
          Atomics.load(counts, 0) === 0) {
        return exec.call(this, sql);
      }
      Atomics.add(counts, 1, 1);
      Atomics.notify(counts, 1);
      try { return exec.call(this, sql); }
      finally { Atomics.add(counts, 2, 1); }
    };
  `;
  const createWorker = workerCpu.createCpuTrackedWorker;
  const observeWorker = vi
    .spyOn(workerCpu, "createCpuTrackedWorker")
    .mockImplementation((filename, options) =>
      createWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          testRegistrationPath: context.admission.databasePath,
          testRegistrationBegin: nativeBegin.buffer,
        },
      }),
    );
  let holder: ReturnType<typeof holdStateDatabaseWriteTransaction> | undefined;
  let registration: Promise<void> | undefined;
  let registrationSettled = false;
  const failures: unknown[] = [];
  try {
    // Warm the real worker before the independent holder starts its existing release deadline.
    await registryState.persistSubagentRunsToDiskAsyncOrThrow(new Map(), [], { context });
    holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 1_000);
    await holder.ready;
    Atomics.store(nativeBegin, 0, 1);
    registration = Promise.resolve(
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "Register while a foreign SQLite writer holds its transaction",
        cleanup: "keep",
        expectsCompletionMessage: false,
        taskRowOwnership: "gateway_best_effort",
      }),
    );
    const settlement = registration.finally(() => {
      registrationSettled = true;
    });
    await Promise.race([Atomics.waitAsync(nativeBegin, 1, 0).value, settlement, holder.joined]);
    await setImmediate();
    await setImmediate();
    expect(
      Atomics.load(holder.released, 0),
      "registration must let the event loop run before the SQLite writer releases",
    ).toBe(0);
    expect(Atomics.load(nativeBegin, 1)).toBeGreaterThan(0);
    expect(Atomics.load(nativeBegin, 2)).toBe(0);
    expect(registrationSettled).toBe(false);
    expect(subagentRuns.has(runId)).toBe(false);
  } catch (error) {
    failures.push(error);
  } finally {
    Atomics.store(nativeBegin, 0, 0);
    Atomics.notify(nativeBegin, 1);
    holder?.release();
    for (const result of await Promise.allSettled([registration, holder?.joined])) {
      if (result.status === "rejected" && !failures.includes(result.reason)) {
        failures.push(result.reason);
      }
    }
    observeWorker.mockRestore();
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Registration responsiveness or worker settlement failed");
  }
  const durable = loadSubagentRegistryFromSqlite().get(runId);
  expect(durable).toMatchObject({ runId, childSessionKey, execution: { status: "running" } });
  expect(subagentRuns.get(runId)).toEqual(durable);
  await fixture.settle();
});

it.each(["none", "before rollback commit", "after rollback commit"] as const)(
  "keeps rollback session authority current with successor timing: %s",
  async (successorTiming) => {
    const hasSuccessor = successorTiming !== "none";
    await fixture.allocateStateDir();
    vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      const createTask = createDeferred();
      let holder: ReturnType<typeof holdStateDatabaseWriteTransaction> | undefined;
      let older: Promise<unknown> | undefined;
      let newer: Promise<unknown> | undefined;
      let restoreWrites: (() => void) | undefined;
      let restoreWorkerOperation: (() => void) | undefined;
      const failures: unknown[] = [];
      try {
        const noTask = vi.fn(() => null);
        setDetachedTaskLifecycleRuntime({
          ...detachedTaskRuntime.getDetachedTaskLifecycleRuntime(),
          createRunningTaskRun: noTask,
        });
        let lifecycleHandler: Parameters<typeof onAgentEvent>[0] | undefined;
        vi.mocked(onAgentEvent).mockImplementation((handler) => {
          lifecycleHandler = handler;
          return () => {};
        });
        await registerSubagentRun({
          runId: "listener-registration",
          childSessionKey: "agent:main:subagent:listener-registration",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "install the ordinary lifecycle listener",
          cleanup: "keep",
          expectsCompletionMessage: false,
          taskRowOwnership: "gateway_best_effort",
        });
        releaseSubagentRun("listener-registration");
        const childSessionKey = "agent:main:subagent:rollback-owner";
        const now = Date.now();
        const storePath = await writeSubagentSessionEntry({
          stateDir: fixture.stateDir,
          agentId: "main",
          sessionKey: childSessionKey,
          sessionId: "rollback-owned-session",
          defaultSessionId: "rollback-owned-session",
          updatedAt: now,
        });
        const before = (await readSubagentSessionStore(storePath))[childSessionKey];
        const predecessor = createSubagentRunRecord({
          runId: "killed-predecessor",
          childSessionKey,
          generation: 1,
          createdAt: now - 10_000,
          execution: {
            status: "terminal",
            lifecycleGeneration: "test-generation",
            startedAt: now - 9_000,
            endedAt: now - 1_000,
            outcome: { status: "error", error: "provisional kill" },
          },
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          killReconciliation: { killedAt: now - 1_000 },
          expectsCompletionMessage: false,
          completion: { required: false },
          delivery: { status: "not_required" },
        });
        subagentRuns.set(predecessor.runId, predecessor);
        const context = captureOpenClawStateWorkerContext();
        await registryState.persistSubagentRunsToDiskAsyncOrThrow(
          subagentRuns,
          [predecessor.runId],
          { context },
        );
        const initialWrite = createDeferred();
        const rollbackWrite = createDeferred();
        let initialCommitted = false;
        let rollbackQueued = false;
        let checkedAfterSuccessor = false;
        const olderId = "failed-registration";
        const newerId = "accepted-successor";
        let afterCommitSuccessorCount = 0;
        let rollbackCommittedIds: readonly string[] | undefined;
        const cacheReaders = [
          registryState.getSubagentRunsSnapshotForRead,
          registryState.getSubagentSessionListRunsSnapshotForRead,
          registryState.getSubagentMaintenanceRunsSnapshotForRead,
        ];
        const persist = registryState.persistSubagentRunsToDiskAsyncOrThrow;
        const observeWrites = vi
          .spyOn(registryState, "persistSubagentRunsToDiskAsyncOrThrow")
          .mockImplementation(async (runs, ids, options) => {
            const olderWrite = ids.includes(olderId);
            const rollback = olderWrite && !runs.has(olderId);
            const writing = persist(runs, ids, {
              ...options,
              assertCurrent: () => {
                if (rollback && subagentRuns.has(newerId)) {
                  checkedAfterSuccessor = true;
                }
                options.assertCurrent?.();
              },
              onCommitted: (committedIds) => {
                if (rollback) {
                  rollbackCommittedIds = [...committedIds];
                }
                options.onCommitted?.(committedIds);
              },
            });
            if (rollback) {
              rollbackQueued = true;
              rollbackWrite.resolve();
            }
            await writing;
            if (olderWrite && !rollback) {
              initialCommitted = true;
              initialWrite.resolve();
              // Its write is real and settled; hold only the caller's next task-creation step.
              await createTask.promise;
            }
          });
        restoreWrites = () => observeWrites.mockRestore();
        older = Promise.resolve(
          registerSubagentRun({
            runId: olderId,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "required task creation returns no row",
            cleanup: "keep",
            expectsCompletionMessage: false,
            taskRowOwnership: "required",
          }),
        ).catch((error: unknown) => error);
        await Promise.race([initialWrite.promise, older]);
        expect(initialCommitted).toBe(true);
        const marker = predecessor.killReconciliation?.supersededAt;
        expect(marker).toBeTypeOf("number");
        if (successorTiming === "none") {
          predecessor.label = "Updated while successor task creation is pending";
          await registryState.persistSubagentRunsToDiskAsyncOrThrow(
            subagentRuns,
            [predecessor.runId],
            { context },
          );
        }
        if (successorTiming === "after rollback commit") {
          await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
            await registryState.prepareSubagentSessionListReadCache();
            for (const read of cacheReaders) {
              expect(read(new Map()).has(olderId)).toBe(true);
            }
          });
        }
        expect(context.admission.databasePath.startsWith(fixture.stateDir)).toBe(true);
        holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 1_000);
        await holder.ready;
        if (successorTiming === "after rollback commit") {
          const runOperation = stateWorker.runOpenClawStateWorkerOperation;
          const observeOperation = vi
            .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
            .mockImplementationOnce((workerContext, operation, options) =>
              runOperation(
                workerContext,
                (scope) => {
                  const execute: typeof scope.execute = async (command, executeOptions) => {
                    const receipt = await scope.execute(command, executeOptions);
                    if (command.type === "subagents.persistChanges") {
                      // Native rollback committed; its real receipt has not reached publication.
                      const registration = registerSubagentRun({
                        runId: newerId,
                        childSessionKey,
                        requesterSessionKey: "agent:main:main",
                        requesterDisplayKey: "main",
                        task: "retain a synchronous successor after rollback commit",
                        cleanup: "keep",
                        expectsCompletionMessage: false,
                        queued: true,
                        taskRowOwnership: "gateway_best_effort",
                      });
                      newer = Promise.resolve(registration).catch((error: unknown) => error);
                      expect(registration).toBeUndefined();
                      afterCommitSuccessorCount += 1;
                    }
                    return receipt;
                  };
                  return operation({ ...scope, execute });
                },
                options,
              ),
            );
          restoreWorkerOperation = () => observeOperation.mockRestore();
        }
        if (successorTiming === "before rollback commit") {
          newer = Promise.resolve(
            registerSubagentRun({
              runId: newerId,
              childSessionKey,
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: "retain accepted successor ownership",
              cleanup: "keep",
              expectsCompletionMessage: false,
              taskRowOwnership: "gateway_best_effort",
            }),
          ).catch((error: unknown) => error);
        }
        createTask.resolve();
        await Promise.race([rollbackWrite.promise, older, holder.joined]);
        expect(rollbackQueued).toBe(true);
        expect(Atomics.load(holder.released, 0)).toBe(0);
        holder.release();
        expect(await newer).toBeUndefined();
        expect(await older).toBeInstanceOf(Error);
        expect(noTask).toHaveBeenCalledOnce();
        expect(checkedAfterSuccessor).toBe(successorTiming === "before rollback commit");
        expect(afterCommitSuccessorCount).toBe(successorTiming === "after rollback commit" ? 1 : 0);
        const durable = loadSubagentRegistryFromSqlite();
        const durableMarker = durable.get(predecessor.runId)?.killReconciliation?.supersededAt;
        if (successorTiming === "none") {
          expect(predecessor.label).toBe("Updated while successor task creation is pending");
          expect(durable.get(predecessor.runId)?.label).toBe(
            "Updated while successor task creation is pending",
          );
          expect(durableMarker).toBeUndefined();
        }
        if (successorTiming === "after rollback commit") {
          expect(rollbackCommittedIds).toEqual([olderId]);
          expect(subagentRuns.has(olderId)).toBe(false);
          expect(durable.has(olderId)).toBe(false);
          expect(subagentRuns.get(predecessor.runId)?.killReconciliation?.supersededAt).toBe(
            marker,
          );
          expect(durableMarker).toBe(marker);
          expect(subagentRuns.get(newerId)).toMatchObject({
            runId: newerId,
            childSessionKey,
            execution: { status: "queued" },
          });
          expect(durable.get(newerId)).toEqual(subagentRuns.get(newerId));
          await withEnvAsync({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, async () => {
            for (const read of cacheReaders) {
              const observed = read(new Map());
              expect(observed.has(olderId)).toBe(false);
              expect(observed.get(predecessor.runId)).toMatchObject({
                runId: predecessor.runId,
                childSessionKey,
              });
              expect(observed.get(newerId)).toMatchObject({
                runId: newerId,
                childSessionKey,
                execution: { status: "queued" },
              });
            }
            for (const read of [
              registryState.getSubagentRunsSnapshotForRead,
              registryState.getSubagentMaintenanceRunsSnapshotForRead,
            ]) {
              expect(read(new Map()).get(predecessor.runId)?.killReconciliation?.supersededAt).toBe(
                marker,
              );
            }
          });
        }

        // Remove both newer rows through their owner so the marker is the only remaining fence.
        releaseSubagentRun(olderId);
        releaseSubagentRun(newerId);
        expect([...subagentRuns.keys()]).toEqual([predecessor.runId]);
        if (!lifecycleHandler) {
          throw new Error("Registration did not install the lifecycle listener");
        }
        lifecycleHandler({
          runId: predecessor.runId,
          seq: 1,
          stream: "lifecycle",
          ts: now,
          lifecycleGeneration: "test-generation",
          data: { phase: "end", startedAt: now - 9_000, endedAt: now },
        });
        await fixture.settle();
        const after = (await readSubagentSessionStore(storePath))[childSessionKey];
        if (hasSuccessor) {
          expect(after, "superseded rollback must not restore predecessor session effects").toEqual(
            before,
          );
          expect(durableMarker).toBe(marker);
        } else {
          expect(after?.status).toBe("done");
          expect(after?.endedAt).toBe(now);
          expect(durableMarker).toBeUndefined();
        }
      } catch (error) {
        failures.push(error);
      } finally {
        createTask.resolve();
        holder?.release();
        for (const result of await Promise.allSettled([older, newer, holder?.joined])) {
          if (result.status === "rejected" && !failures.includes(result.reason)) {
            failures.push(result.reason);
          }
        }
        restoreWrites?.();
        restoreWorkerOperation?.();
        try {
          await fixture.settle();
        } catch (error) {
          failures.push(error);
        }
        if (getActiveGatewayRootWorkCount() === 0) {
          resetDetachedTaskLifecycleRuntimeForTests();
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Rollback authority or worker settlement failed");
      }
    });
  },
);

it.each(["after rejection", "before rejection"] as const)(
  "recovers the first required registration after a lost task receipt and terminal %s",
  async (terminalTiming) => {
    await fixture.allocateStateDir();
    vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      const runId = "receiptless-first-registration";
      const childSessionKey = "agent:main:subagent:receiptless-first-registration";
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        sessionId: "receiptless-session",
        defaultSessionId: "receiptless-session",
        lifecycleRevision: "receiptless-lifecycle",
      });
      expect(subagentRuns.size).toBe(0);
      const listeners = new Set<Parameters<typeof onAgentEvent>[0]>();
      vi.mocked(onAgentEvent).mockImplementation((listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      });
      const created = createDeferred();
      const rejectReceipt = createDeferred();
      const lostReceipt = new Error("Running task committed but its creation reply was lost");
      let createdTaskId: string | undefined;
      let registrationScope: SubagentRegistrationScope | undefined;
      let registration: Promise<unknown> | undefined;
      const prepareRunningTaskRun = detachedTaskRuntime.prepareRunningTaskRun;
      const prepare = vi
        .spyOn(detachedTaskRuntime, "prepareRunningTaskRun")
        .mockImplementation((...args) => {
          const prepared = prepareRunningTaskRun(...args);
          if (prepared.kind !== "receipt") {
            throw new Error("Receipt-loss fixture requires the real core task writer");
          }
          return {
            kind: "receipt",
            async create() {
              const receipt = expectDefined(await prepared.create(), "committed task receipt");
              createdTaskId = receipt.task.taskId;
              receipt.release();
              created.resolve();
              await rejectReceipt.promise;
              throw lostReceipt;
            },
          };
        });
      try {
        registration = Promise.resolve(
          registerSubagentRun(
            {
              runId,
              childSessionKey,
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: "Retain terminal recovery after the first task receipt is lost",
              cleanup: "keep",
              expectsCompletionMessage: false,
              taskRowOwnership: "required",
            },
            {
              retainOwnership: (scope) => {
                registrationScope = scope;
              },
            },
          ),
        ).catch((error: unknown) => error);
        await Promise.race([created.promise, registration]);
        const taskId = expectDefined(createdTaskId, "real committed task id");
        const scope = expectDefined(registrationScope, "retained registration scope");
        const entry = expectDefined(subagentRuns.get(runId), "acknowledged running entry");
        expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
          runId,
          childSessionKey,
          execution: { status: "running" },
        });
        expect(await findTaskByRunIdAsync(runId)).toMatchObject({
          taskId,
          runId,
          status: "running",
        });
        expect(scope.canLaunch()).toBe(false);
        const endedAt = Date.now();
        const emitTerminal = () => {
          const currentListeners = [...listeners];
          for (const listener of currentListeners) {
            listener({
              runId,
              sessionKey: childSessionKey,
              seq: 1,
              stream: "lifecycle",
              ts: endedAt,
              lifecycleGeneration: "test-generation",
              data: {
                phase: "end",
                startedAt: entry.execution.startedAt,
                endedAt,
                aborted: true,
                stopReason: "aborted",
              },
            });
          }
        };
        if (terminalTiming === "before rejection") {
          const session = expectDefined(
            loadSessionEntry({ agentId: "main", storePath, sessionKey: childSessionKey }),
            "retained child session",
          );
          await replaceSessionEntry(
            { agentId: "main", storePath, sessionKey: childSessionKey },
            {
              ...session,
              status: "killed",
              lifecycleRunId: runId,
              startedAt: entry.execution.startedAt,
              endedAt,
              updatedAt: endedAt,
            },
          );
          emitTerminal();
          expect(entry.execution.status).toBe("running");
        }
        rejectReceipt.resolve();
        expect(await registration).toBe(lostReceipt);
        expect(scope.canLaunch()).toBe(false);
        expect(scope.canCleanupSession()).toBe(false);
        await expect(scope.settleFailedLaunch("registration failed")).rejects.toThrow(
          "requires recovery before launch settlement",
        );
        if (terminalTiming === "after rejection") {
          emitTerminal();
        } else {
          // Make the retained run old enough for the normal sweeper recovery path.
          const clock = vi.spyOn(Date, "now").mockReturnValue(endedAt + 60_001);
          try {
            await testing.runSweeperTickForTests();
          } finally {
            clock.mockRestore();
          }
        }
        await fixture.settle();
        expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
          runId,
          childSessionKey,
          execution: { status: "terminal", endedAt },
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
        });
        expect(await findTaskByRunIdAsync(runId)).toMatchObject({
          taskId,
          runId,
          status: "cancelled",
        });
        expect((await readSubagentSessionStore(storePath))[childSessionKey]).toMatchObject({
          sessionId: "receiptless-session",
          lifecycleRevision: "receiptless-lifecycle",
        });
        expect(scope.canLaunch()).toBe(false);
        expect(prepare).toHaveBeenCalledOnce();
        expect(
          vi
            .mocked(callGateway)
            .mock.calls.some(
              ([request]) => request.method === "agent" || request.method === "agent.wait",
            ),
        ).toBe(false);
      } finally {
        rejectReceipt.resolve();
        await Promise.allSettled([registration]);
        prepare.mockRestore();
        await fixture.settle();
      }
    });
  },
);
