import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import {
  spawnTerminalPty,
  type TerminalPtyHandle,
  type TerminalPtySpawnParams,
} from "./terminal-pty.js";

const handles: TerminalPtyHandle[] = [];
const descendants: number[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const deadline = { timeout: 2_000, interval: 10 };
const bun = (
  globalThis as typeof globalThis & {
    Bun?: { Terminal?: { prototype: { pause?: () => void } } };
  }
).Bun;
const hasFlowControl = typeof bun?.Terminal?.prototype.pause === "function";

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.kill();
  }
  for (const pid of descendants.splice(0)) {
    killPidIfAlive(pid);
  }
  vi.unstubAllEnvs();
});

async function start(args: string[], overrides: Partial<TerminalPtySpawnParams> = {}) {
  const handle = await spawnTerminalPty({
    file: "/bin/sh",
    args,
    env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
    cols: 80,
    rows: 24,
    ...overrides,
  });
  handles.push(handle);
  const observed: { output: string; exit?: { exitCode: number; signal?: number } } = { output: "" };
  handle.onData((chunk) => {
    observed.output += chunk;
  });
  handle.onExit((event) => {
    observed.exit = event;
  });
  return { handle, observed };
}

describe.runIf(Boolean(process.versions.bun) && process.platform !== "win32")(
  "Bun native terminal PTY",
  () => {
    it("preserves cwd, env, terminal input, resize, Unicode, and final output", async () => {
      const cwd = fs.realpathSync(tempDirs.make("openclaw-bun-pty-"));
      const { handle, observed } = await start(
        [
          "-c",
          'stty -echo; printf "READY\\n"; IFS= read -r input; stty size; printf "%s\\n%s\\n%s\\n%s\\n" "$input" "$PWD" "$TERM" "$PTY_VALUE"; exit 7',
        ],
        { cwd, env: { PATH: "/usr/bin:/bin", TERM: "dumb", PWD: "/wrong", PTY_VALUE: "custom" } },
      );
      await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
      handle.resize(101, 37);
      handle.write(Buffer.from("hello 🦞\r"));
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(7), deadline);
      expect(observed.output).toBe(
        `READY\r\n37 101\r\nhello 🦞\r\n${cwd}\r\nxterm-256color\r\ncustom\r\n`,
      );
    });

    it("inherits env without host multiplexer state and preserves an explicit TERM", async () => {
      vi.stubEnv("TMUX", "host-multiplexer");
      vi.stubEnv("TERM", "dumb");
      const { observed } = await start(["-c", 'printf "%s|%s|%s" "$TMUX" "$TERM" "$PWD"'], {
        env: undefined,
        name: "screen-256color",
      });
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(0), deadline);
      expect(observed.output).toBe(`|screen-256color|${process.cwd()}`);
    });

    it("Ctrl-C interrupts the foreground job while the interactive shell survives", async () => {
      const { handle, observed } = await start(["--noprofile", "--norc", "-i"], {
        file: "/bin/bash",
        env: { PATH: "/usr/bin:/bin", PS1: "PTY_READY> " },
      });
      await vi.waitFor(() => expect(observed.output).toContain("PTY_READY> "), deadline);
      handle.write("stty -echo; sleep 30\r");
      let childPid = 0;
      await vi.waitFor(() => {
        const rows = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).stdout;
        const child = rows
          .split("\n")
          .map((line) => line.trim().split(/\s+/u))
          .find(
            ([, parent, command]) => Number(parent) === handle.pid && command?.endsWith("sleep"),
          );
        expect(child).toBeDefined();
        childPid = Number(child?.[0]);
      }, deadline);
      descendants.push(childPid);
      handle.write("\x03");
      handle.write('printf "INTERRUPTED:%s\\n" "$?"\r');
      await vi.waitFor(() => expect(observed.output).toContain("INTERRUPTED:130\r\n"), deadline);
      expect(isPidAlive(handle.pid)).toBe(true);
      expect(observed.exit).toBeUndefined();
      await vi.waitFor(() => expect(isPidAlive(childPid)).toBe(false), deadline);
      handle.write("exit 0\r");
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(0), deadline);
    });

    it("maps signal termination to node-pty's exit code and signal number", async () => {
      const { handle, observed } = await start(["-c", 'printf "READY\\n"; exec sleep 30']);
      await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
      handle.kill("SIGTERM");
      await vi.waitFor(
        () => expect(observed.exit).toEqual({ exitCode: 0, signal: constants.signals.SIGTERM }),
        deadline,
      );
    });

    it("reports shell exit promptly with a slave-holding descendant and still kills that descendant", async () => {
      const { handle, observed } = await start([
        "-c",
        'trap \'\' HUP; sleep 30 & printf "CHILD:%s\\n" "$!"; exit 3',
      ]);
      await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(3), {
        timeout: 1_000,
        interval: 10,
      });
      const match = observed.output.match(/CHILD:(\d+)/u);
      expect(match).not.toBeNull();
      const childPid = Number(match?.[1]);
      descendants.push(childPid);
      expect(isPidAlive(childPid)).toBe(true);
      handle.kill();
      await vi.waitFor(() => expect(isPidAlive(childPid)).toBe(false), deadline);
    });

    it("replays output emitted before the first data subscription in order, honoring pause", async () => {
      const handle = await spawnTerminalPty({
        file: "/bin/sh",
        // Separate writes arrive as separate PTY reads, so the replay holds several chunks.
        args: [
          "-c",
          "printf 'early 🦞\\n'; sleep 0.1; printf 'two\\n'; sleep 0.1; printf 'three\\n'",
        ],
        cols: 80,
        rows: 24,
      });
      handles.push(handle);
      let exited = false;
      handle.onExit(() => {
        exited = true;
      });
      await vi.waitFor(() => expect(exited).toBe(true), deadline);
      const chunks: string[] = [];
      handle.onData((chunk) => {
        chunks.push(chunk);
        if (chunks.length === 1) {
          handle.pause();
        }
      });
      expect(chunks).toEqual(["early 🦞\r\n"]);
      handle.resume();
      expect(chunks.join("")).toBe("early 🦞\r\ntwo\r\nthree\r\n");
    });

    // Upstream Bun and the current CI fork pin lack Terminal.pause/resume.
    describe.skipIf(!hasFlowControl)(
      "flow control (requires the OpenClaw Bun fork's Terminal.pause/resume)",
      () => {
        it("stalls child progress while paused and delivers every byte after resume", async () => {
          const cwd = tempDirs.make("openclaw-bun-pty-flow-");
          const payload = "x".repeat(4 * 1024 * 1024);
          fs.writeFileSync(path.join(cwd, "payload"), payload);
          const { handle, observed } = await start(
            [
              "-c",
              'stty -echo; printf "READY\\n"; read input; printf started > progress; cat payload; printf finished > progress',
            ],
            { cwd },
          );
          await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
          handle.pause();
          handle.write("go\r");
          const progress = () => fs.readFileSync(path.join(cwd, "progress"), "utf8");
          await vi.waitFor(() => expect(progress()).toBe("started"), deadline);
          let samples = 0;
          await vi.waitFor(
            () => {
              expect(progress()).toBe("started");
              expect(observed.output).toBe("READY\r\n");
              expect(++samples).toBeGreaterThanOrEqual(5);
            },
            { timeout: 1_000, interval: 20 },
          );
          expect(observed.exit).toBeUndefined();
          handle.resume();
          await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(0), deadline);
          expect(progress()).toBe("finished");
          expect(observed.output).toBe(`READY\r\n${payload}`);
        });

        it("preserves the tail when the child finishes while output is paused", async () => {
          const cwd = tempDirs.make("openclaw-bun-pty-tail-");
          const { handle, observed } = await start(
            [
              "-c",
              'stty -echo; printf "READY\\n"; read input; printf "tail 🦞\\n"; : > written; exit 9',
            ],
            { cwd },
          );
          await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
          handle.pause();
          handle.write("go\r");
          await vi.waitFor(
            () => expect(fs.existsSync(path.join(cwd, "written"))).toBe(true),
            deadline,
          );
          // macOS holds an exiting session leader until its PTY output drains.
          expect(observed.output).toBe("READY\r\n");
          expect(observed.exit).toBeUndefined();
          handle.resume();
          await vi.waitFor(() => expect(observed.exit?.exitCode).toBe(9), deadline);
          expect(observed.output).toBe("READY\r\ntail 🦞\r\n");
        });

        it("reports exit after kill while the consumer keeps re-pausing output", async () => {
          const cwd = tempDirs.make("openclaw-bun-pty-kill-");
          fs.writeFileSync(path.join(cwd, "payload"), "x".repeat(4 * 1024 * 1024));
          const { handle, observed } = await start(
            [
              "-c",
              'stty -echo; printf "READY\\n"; read input; printf started > progress; cat payload',
            ],
            { cwd },
          );
          await vi.waitFor(() => expect(observed.output).toBe("READY\r\n"), deadline);
          handle.pause();
          handle.write("go\r");
          await vi.waitFor(
            () => expect(fs.readFileSync(path.join(cwd, "progress"), "utf8")).toBe("started"),
            deadline,
          );
          // A viewer whose backlog stays full pauses again on every chunk it receives.
          handle.onData(() => handle.pause());
          handle.kill();
          await vi.waitFor(
            () => expect(observed.exit).toEqual({ exitCode: 0, signal: constants.signals.SIGKILL }),
            deadline,
          );
          // Teardown delivered the dying tree's output before exit; nothing trails it.
          const atExit = observed.output.length;
          expect(atExit).toBeGreaterThan("READY\r\n".length);
          handle.resume();
          expect(observed.output.length).toBe(atExit);
        });
      },
    );
  },
);
