import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { DuplicateAgentDirError } from "./agent-dirs.js";
import {
  applyConfigEnvVars,
  captureConfigReadEnvMutation,
  cloneEnvWithPlatformSemantics,
  createConfigRuntimeEnvBase,
  snapshotEnv,
  withConfigReadEnvChanges,
} from "./config-env-vars.js";
import { createConfigIO, restoreEnvChangesIfUnchanged } from "./io.js";
import { getConfigResolutionFacts } from "./resolution-facts.js";
import { withTempHome, writeOpenClawConfig, writeStateDirDotEnv } from "./test-helpers.js";
import { withConfigWriteLock } from "./write-lock.js";

function configIO(home: string, env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, homedir: () => home, logger: { warn: () => {}, error: () => {} } });
}

describe("restoreEnvChangesIfUnchanged", () => {
  it("restores external ownership when rejected config replaced equal lower-precedence bytes", () => {
    const env = { KEY: "same" };
    const cfg = { env: { vars: { KEY: "same" } } };
    const before = snapshotEnv(env);
    applyConfigEnvVars(cfg, env, { lowerPrecedenceEnv: { KEY: "same" } });
    const after = snapshotEnv(env);
    expect(createConfigRuntimeEnvBase(cfg, env).KEY).toBeUndefined();

    restoreEnvChangesIfUnchanged({ env, before, after });

    expect(env.KEY).toBe("same");
    expect(createConfigRuntimeEnvBase(cfg, env).KEY).toBe("same");
  });

  it("preserves a later ownership change even when environment bytes are unchanged", () => {
    const env: NodeJS.ProcessEnv = {};
    const before = snapshotEnv(env);
    applyConfigEnvVars({ env: { vars: { KEY: "value" } } }, env);
    const after = snapshotEnv(env);
    applyConfigEnvVars({}, env);

    restoreEnvChangesIfUnchanged({ env, before, after });

    expect(env.KEY).toBe("value");
  });

  it("restores earlier config ownership with its value after a rejected replacement", () => {
    const env: NodeJS.ProcessEnv = {};
    const cfg = { env: { vars: { KEY: "old" } } };
    applyConfigEnvVars(cfg, env);
    const before = snapshotEnv(env);
    applyConfigEnvVars({ env: { vars: { KEY: "new" } } }, env, {
      lowerPrecedenceEnv: { KEY: "old" },
    });
    const after = snapshotEnv(env);

    restoreEnvChangesIfUnchanged({ env, before, after });

    expect(env.KEY).toBe("old");
    expect(createConfigRuntimeEnvBase(cfg, env).KEY).toBeUndefined();
  });

  it.each([
    {
      name: "restores an overwritten key back to its before value",
      before: { KEY: "original" },
      after: { KEY: "new-value" },
      current: "new-value",
      expected: "original",
    },
    {
      name: "preserves an externally modified key even when different from before",
      before: {},
      after: { KEY: "config-set" },
      current: "external-change",
      expected: "external-change",
    },
  ])("$name", ({ before, after, current, expected }) => {
    const env: NodeJS.ProcessEnv = { HOME: "/tmp/test", KEY: current };
    restoreEnvChangesIfUnchanged({
      env,
      before: { HOME: "/tmp/test", ...before },
      after: { HOME: "/tmp/test", ...after },
    });
    expect(env.KEY).toBe(expected);
  });
});

describe("loadConfig env restoration", () => {
  it("returns resolution facts with a valid synchronous load", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      });
      const config = configIO(home, { HOME: home }).loadConfig();

      expect([...(getConfigResolutionFacts(config) ?? [])]).toEqual(["gateway.auth.token"]);
    });
  });

  it("restores env changes after non-INVALID_CONFIG error (DuplicateAgentDirError)", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { DUP_DIR_TEST_VAR: "injected-value" } },
        agents: {
          list: [
            { id: "agent-a", agentDir: "/tmp/dup-agent-dir" },
            { id: "agent-b", agentDir: "/tmp/dup-agent-dir" },
          ],
        },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = configIO(home, env);

      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
      expect(() => io.loadConfig()).toThrow(DuplicateAgentDirError);
      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
    });
  });
});

describe.each(["loadConfig", "readConfigFileSnapshot"] as const)(
  "%s env restoration after invalid config",
  (read) => {
    it.each([
      { key: "TEST_VAR", original: undefined, injected: "injected-value" },
      { key: "PRE_EXISTING", original: "original-value", injected: "new-value" },
    ])("restores $key to $original", async ({ key, original, injected }) => {
      await withTempHome(async (home) => {
        await writeOpenClawConfig(home, {
          env: { vars: { [key]: injected } },
          gateway: { port: "invalid" },
        });
        const env: NodeJS.ProcessEnv = { HOME: home };
        if (original !== undefined) {
          env[key] = original;
        }
        const io = configIO(home, env);

        expect(env[key]).toBe(original);
        if (read === "loadConfig") {
          expect(() => io.loadConfig()).toThrow(
            expect.objectContaining({ code: "INVALID_CONFIG" }),
          );
        } else {
          expect((await io.readConfigFileSnapshot()).valid).toBe(false);
        }
        expect(env[key]).toBe(original);
      });
    });
  },
);

it.each(
  (["snapshot", "for-write"] as const).flatMap((entry) =>
    (["unchanged", "replaced", "deleted"] as const).map((change) => ({ entry, change })),
  ),
)(
  "preserves foreign env changes during invalid $entry validation (owned=$change)",
  async ({ entry, change }) => {
    await withTempHome(async (home) => {
      const ownedKey = "OPENCLAW_TEST_READER_OWNED";
      const addedKey = "OPENCLAW_TEST_READER_ADDED";
      const deletedKey = "OPENCLAW_TEST_READER_DELETED";
      const configPath = await writeOpenClawConfig(home, {
        env: { vars: { [ownedKey]: "candidate" } },
        gateway: { port: "invalid" },
      });
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        [ownedKey]: "lower-precedence",
        [deletedKey]: "previous-owner",
      };
      let reachedBoundary = false;
      let producedValue: string | undefined;
      const io = createConfigIO({
        configPath,
        env,
        lowerPrecedenceEnv: { [ownedKey]: "lower-precedence" },
        observe: false,
        pluginValidation: "skip",
        measure: async (name, run) => {
          const result = await run();
          if (name === "config.snapshot.read.legacy-issues") {
            reachedBoundary = true;
            producedValue = env[ownedKey];
            env[addedKey] = "new-owner";
            delete env[deletedKey];
            if (change === "replaced") {
              env[ownedKey] = "replacement-owner";
            } else if (change === "deleted") {
              delete env[ownedKey];
            }
          }
          return result;
        },
      });
      const snapshot =
        entry === "for-write"
          ? (await io.readConfigFileSnapshotForWrite()).snapshot
          : await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);
      expect(reachedBoundary).toBe(true);
      expect(producedValue).toBe("candidate");
      expect(env[ownedKey]).toBe(
        change === "unchanged"
          ? "lower-precedence"
          : change === "replaced"
            ? "replacement-owner"
            : undefined,
      );
      expect(env[addedKey]).toBe("new-owner");
      expect(env[deletedKey]).toBeUndefined();
    });
  },
);

describe("config read producer receipts", () => {
  it("restores equal-byte lower-precedence ownership after a rejected real snapshot", async () => {
    await withTempHome(async (home) => {
      const cfg = { env: { vars: { KEY: "same" } }, gateway: { port: "invalid" } };
      const configPath = await writeOpenClawConfig(home, cfg);
      const env = { HOME: home, KEY: "same" };
      const io = createConfigIO({
        configPath,
        env,
        lowerPrecedenceEnv: { KEY: "same" },
        observe: false,
        pluginValidation: "skip",
      });
      expect((await io.readConfigFileSnapshot()).valid).toBe(false);
      expect(env.KEY).toBe("same");
      expect(createConfigRuntimeEnvBase({ env: cfg.env }, env).KEY).toBe("same");
    });
  });

  it("preserves a later ownership change with unchanged bytes", async () => {
    const env: NodeJS.ProcessEnv = {};
    await withConfigReadEnvChanges(env, async (restore) => {
      captureConfigReadEnvMutation(env, () =>
        applyConfigEnvVars({ env: { vars: { KEY: "value" } } }, env),
      );
      await Promise.resolve();
      applyConfigEnvVars({}, env);
      restore();
      expect(env.KEY).toBe("value");
    });
  });

  it("shares a one-time receipt between snapshot rejection and containing compensation", async () => {
    const env: NodeJS.ProcessEnv = {};
    await withConfigReadEnvChanges(env, async (restore) => {
      let rejectSnapshot = () => {};
      captureConfigReadEnvMutation(
        env,
        () => {
          env.KEY = "candidate";
        },
        (receipt) => {
          rejectSnapshot = receipt;
        },
      );
      rejectSnapshot();
      env.KEY = "candidate";
      restore();
      expect(env.KEY).toBe("candidate");
    });
  });

  it.each(["plain", "alias"] as const)("retains Windows %s key semantics", async (kind) => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const env: NodeJS.ProcessEnv =
        kind === "alias"
          ? cloneEnvWithPlatformSemantics({ key: "old" })
          : { key: "old", KEY: "separate" };
      await withConfigReadEnvChanges(env, async (restore) => {
        captureConfigReadEnvMutation(env, () => {
          delete env.key;
          env.KEY = "candidate";
        });
        await Promise.resolve();
        env.UNRELATED = "foreign";
        restore();
        expect(env.key).toBe("old");
        expect(env.KEY).toBe(kind === "alias" ? "old" : "separate");
        expect(env.UNRELATED).toBe("foreign");
      });
    } finally {
      platform.mockRestore();
    }
  });

  it.each(["plain", "alias"] as const)(
    "restores ownership-only changes with Windows %s key spelling",
    async (kind) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        const env: NodeJS.ProcessEnv =
          kind === "alias" ? cloneEnvWithPlatformSemantics({ key: "" }) : { key: "" };
        const config = { env: { vars: { KEY: "value" } } };
        applyConfigEnvVars(config, env);
        expect(Object.keys(env)).toEqual(kind === "alias" ? ["key"] : ["key", "KEY"]);
        await withConfigReadEnvChanges(env, async (restore) => {
          captureConfigReadEnvMutation(env, () => applyConfigEnvVars({}, env));
          await Promise.resolve();
          restore();
        });
        expect(env.KEY).toBe("value");
        expect(Object.entries(createConfigRuntimeEnvBase(config, env))).toEqual(
          kind === "plain" ? [["key", ""]] : [],
        );
        if (kind === "plain") {
          expect(env.key).toBe("");
        }
      } finally {
        platform.mockRestore();
      }
    },
  );

  it("restores partial synchronous producer writes without taking a later foreign write", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        env: { vars: { FIRST: "candidate", BLOCKED: "candidate" } },
      });
      const failure = new Error("producer refused second assignment");
      const env = new Proxy<NodeJS.ProcessEnv>(
        { HOME: home },
        {
          set(target, key, value) {
            if (key === "BLOCKED") {
              throw failure;
            }
            return Reflect.set(target, key, value);
          },
        },
      );
      const io = createConfigIO({
        configPath,
        env,
        observe: false,
        pluginValidation: "skip",
        logger: { warn: () => {}, error: () => {} },
        measure: async (name, run) => {
          try {
            return await run();
          } catch (error) {
            if (name === "config.snapshot.read.env") {
              env.FOREIGN = "preserved";
            }
            throw error;
          }
        },
      });
      expect((await io.readConfigFileSnapshot()).valid).toBe(false);
      expect(env.FIRST).toBeUndefined();
      expect(env.BLOCKED).toBeUndefined();
      expect(env.FOREIGN).toBe("preserved");
    });
  });
});

describe("snapshot source authority", () => {
  it.each([false, true])(
    "checks the source owner before loading dotenv (revoked=%s)",
    async (revoked) => {
      await withTempHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
        });
        const envKey = "OPENCLAW_TEST_SNAPSHOT_DOTENV";
        await writeStateDirDotEnv(`${envKey}=dotenv-value\n`, {
          stateDir: path.dirname(configPath),
        });
        await withEnvAsync(
          {
            [envKey]: undefined,
            OPENCLAW_STATE_DIR: path.dirname(configPath),
            OPENCLAW_CONFIG_PATH: configPath,
          },
          async () => {
            const io = createConfigIO({
              configPath,
              env: process.env,
              observe: false,
              pluginValidation: "skip",
            });
            const refusal = new Error("snapshot source owner changed");
            let current = true;
            await withConfigWriteLock(
              configPath,
              async () => {
                current = !revoked;
                const read = io.readConfigFileSnapshot();
                if (revoked) {
                  await expect(read).rejects.toBe(refusal);
                } else {
                  await expect(read).resolves.toMatchObject({ valid: true });
                }
              },
              process.env,
              () => {
                if (!current) {
                  throw refusal;
                }
              },
            );
            expect(process.env[envKey]).toBe(revoked ? undefined : "dotenv-value");
          },
        );
      });
    },
  );

  it.each(
    (["snapshot", "for-write"] as const).flatMap((entry) =>
      (["env", "invalid-restore"] as const).flatMap((boundary) =>
        [false, true].map((revoked) => ({ entry, boundary, revoked })),
      ),
    ),
  )(
    "preserves $entry reader authority at $boundary (revoked=$revoked)",
    async ({ entry, boundary, revoked }) => {
      await withTempHome(async (home) => {
        const envKey = "OPENCLAW_TEST_SNAPSHOT_ENV";
        const configPath = await writeOpenClawConfig(home, {
          env: { vars: { [envKey]: "config-value" } },
          gateway: { mode: "local", port: boundary === "env" ? 18789 : "invalid" },
        });
        const env: NodeJS.ProcessEnv = { HOME: home };
        const refusal = { reason: "snapshot-source-changed" };
        let current = true;
        let reachedBoundary = false;
        let valueAtBoundary: string | undefined;
        const io = createConfigIO({
          configPath,
          env,
          observe: false,
          pluginValidation: "skip",
          measure: async (name, run) => {
            if (boundary === "env" && name === "config.snapshot.read.env") {
              await Promise.resolve();
              reachedBoundary = true;
              valueAtBoundary = env[envKey];
              current = !revoked;
              try {
                return await run();
              } catch (error) {
                throw new Error("measurement replaced the authority refusal", { cause: error });
              }
            }
            const result = await run();
            if (boundary === "invalid-restore" && name === "config.snapshot.read.legacy-issues") {
              reachedBoundary = true;
              valueAtBoundary = env[envKey];
              if (revoked) {
                env[envKey] = "replacement-owner";
                current = false;
              }
            }
            return result;
          },
        });
        const read = withConfigWriteLock(
          configPath,
          async () =>
            entry === "for-write"
              ? (await io.readConfigFileSnapshotForWrite()).snapshot
              : await io.readConfigFileSnapshot(),
          env,
          () => {
            if (!current) {
              // oxlint-disable-next-line typescript/only-throw-error -- Authority callbacks may throw non-Error values; preserve the exact synchronous refusal.
              throw refusal;
            }
          },
        );
        if (revoked) {
          await expect(read).rejects.toBe(refusal);
        } else {
          await expect(read).resolves.toMatchObject({ valid: boundary === "env" });
        }
        expect(reachedBoundary).toBe(true);
        expect(valueAtBoundary).toBe(boundary === "env" ? undefined : "config-value");
        expect(env[envKey]).toBe(
          boundary === "env"
            ? revoked
              ? undefined
              : "config-value"
            : revoked
              ? "replacement-owner"
              : undefined,
        );
      });
    },
  );
});
