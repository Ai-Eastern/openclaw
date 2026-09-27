import { describe, expect, it } from "vitest";
import {
  canonicalFailure,
  classifyJob,
  escapeMarkdown,
  guardPatch,
  isInfraOnly,
  parseFailures,
  parseResult,
  patchSha256,
  renderPrBody,
} from "../../scripts/ci-repair-agent.mts";

const result = parseResult({
  action: "fix",
  failingTests: ["src/example.test.ts"],
  cause: "restore fixture cleanup",
  classification: "flake",
  evidence: "The fixture retained shared state between tests.",
  confidence: "high",
});
function patch(
  path = "src/example.test.ts",
  before = "const value = stale;",
  after = "const value = fresh;",
) {
  const removed = before.split("\n");
  const added = after.split("\n");
  return `diff --git a/${path} b/${path}\nindex abc1234..def5678 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed.length} +1,${added.length} @@\n${removed.map((line) => `-${line}`).join("\n")}\n${added.map((line) => `+${line}`).join("\n")}\n`;
}
const job = (name: string, steps: string[]) => ({
  id: 1,
  name,
  conclusion: "failure",
  steps: steps.map((stepName) => ({ name: stepName, conclusion: "failure" })),
});

describe("failure collection", () => {
  it("extracts unique Vitest and annotation test paths without turning diagnostics into arguments", () => {
    expect(
      parseFailures(
        [
          "2026-09-26T01:00:00Z \u001b[31m FAIL \u001b[0m [unit] src/example.test.ts > cleanup",
          " FAIL  |tooling| src/example.test.ts > another case",
          "2026-09-26T01:00:00Z [shard:core] FAIL   tooling  src/example.test.ts > bare label",
          "::error file=extensions/chat/send.spec.ts,line=12::AssertionError",
          "::error title=Failure,file=ui/src/editor.test.ts::Failed",
          "::error file=src/runtime.ts,line=2::Type error",
          " FAIL ../escape.test.ts",
          " FAIL /tmp/foreign.test.ts",
          " FAIL --config=evil.test.ts",
        ].join("\n"),
      ),
    ).toEqual(["extensions/chat/send.spec.ts", "src/example.test.ts", "ui/src/editor.test.ts"]);
  });
  it("skips infrastructure-only failures, retaining test and unknown failures", () => {
    const setup = job("node", ["Install dependencies"]);
    const aggregate = job("openclaw/ci-gate", ["Verify selected CI lanes"]);
    expect(isInfraOnly([setup, aggregate])).toBe(true);
    expect(isInfraOnly([job("unassigned runner", [])])).toBe(true);
    expect(isInfraOnly([])).toBe(false);
    expect(isInfraOnly([setup, job("node", ["Test Node suites"])])).toBe(false);
    expect(isInfraOnly([job("lint", ["Check types"])])).toBe(false);
    expect(classifyJob(setup, ["src/example.test.ts"])).toBe("tests");
  });
});

describe("patch-only publication guard", () => {
  it("accepts an ordinary single-commit patch and validates its digest", () => {
    const text = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nFrom: Example <example@example.com>\nSubject: [PATCH] fix(test): cleanup\n\n---\n${patch()}`;
    expect(guardPatch(text, result, patchSha256(text))).toEqual({
      passed: true,
      reasons: [],
      files: ["src/example.test.ts"],
      changedLines: 2,
    });
    expect(guardPatch(text, result, "0".repeat(64)).reasons).toContain("Patch sha256 mismatch");
  });
  it.each([
    ".github/workflows/ci.yml",
    "package.json",
    "extensions/chat/package.json",
    "pnpm-lock.yaml",
    "patches/library.patch",
    "src/example.snap",
    "test/__snapshots__/example.ts",
    "baseline.json",
    "scripts/assertion-ratchet.json",
    "src/plugin-inventory.ts",
    "CHANGELOG.md",
    "CHANGELOG/2026.md",
    "test/vitest/setup.ts",
    "vitest.config.ts",
    "config/vitest.unit.config.ts",
    "dist/index.js",
    "src/example.generated.ts",
    "generated/index.ts",
    "scripts/ci-repair-agent.mts",
    "AGENTS.md",
  ])("rejects forbidden path %s", (path) => {
    expect(guardPatch(patch(path), result).passed).toBe(false);
  });
  it.each([
    "test.skip('case', fn);",
    "it.only('case', fn);",
    "describe.todo('case');",
    "test.fails('case', fn);",
    "test . skip('case', fn);",
    "test['only']('case', fn);",
    "const options = { retry: 2 };",
    "const options = { retries: 2 };",
    "testTimeout: 30000,",
    "hookTimeout: 10000,",
    "vi.setConfig({});",
    "// @ts-nocheck",
    "// @ts-ignore",
    "// @ts-expect-error",
    "// eslint-disable-next-line",
    "/* oxlint-disable */",
  ])("rejects coverage-weakening addition %s", (line) => {
    expect(guardPatch(patch(undefined, "const value = 1;", line), result).reasons).toContain(
      "Forbidden added pattern: src/example.test.ts",
    );
  });
  it("enforces file and changed-line budgets at their boundaries", () => {
    expect(
      guardPatch([1, 2, 3, 4].map((i) => patch(`src/file${i}.ts`)).join(""), result).passed,
    ).toBe(true);
    expect(
      guardPatch([1, 2, 3, 4, 5].map((i) => patch(`src/file${i}.ts`)).join(""), result).reasons,
    ).toContain("Patch must modify 1–4 files");
    expect(
      guardPatch(
        patch(
          undefined,
          Array(40).fill("old();").join("\n"),
          Array(40).fill("newValue();").join("\n"),
        ),
        result,
      ).passed,
    ).toBe(true);
    expect(
      guardPatch(
        patch(
          undefined,
          Array(40).fill("old();").join("\n"),
          Array(41).fill("newValue();").join("\n"),
        ),
        result,
      ).reasons,
    ).toContain("Patch must change 1–80 lines");
  });
  it.each([
    "expect(value).toEqual(1);",
    "expect (value).toEqual(1);",
    "assert(value);",
    "assert.equal(value, 1);",
  ])("rejects assertion loss: %s", (assertion) => {
    expect(guardPatch(patch(undefined, assertion, "value();"), result).reasons).toContain(
      "Assertion count decreased: src/example.test.ts",
    );
  });
  it("does not offset assertion loss by adding assertions in another file", () => {
    expect(
      guardPatch(
        patch(undefined, "expect(value).toBe(1);", "value();") +
          patch("src/other.test.ts", "value();", "expect(value).toBe(1);"),
        result,
      ).passed,
    ).toBe(false);
  });
  it.each([
    "diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n",
    "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+newValue();\n",
    "diff --git a/src/a.ts b/src/a.ts\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old();\n",
    'diff --git "a/src/a.ts" "b/src/a.ts"\n',
    "diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n",
    "diff --git a/src/a.ts b/src/a.ts\nindex abc1234..def5678 120000\nGIT binary patch\n",
  ])("rejects structural edits without consulting a checkout (%#)", (text) => {
    expect(guardPatch(text, result).passed).toBe(false);
  });
  it("rejects incomplete hunks, duplicate file sections, empty patches and low confidence", () => {
    expect(guardPatch(patch().replace("@@ -1,1 +1,1 @@", "@@ -1,2 +1,1 @@"), result).passed).toBe(
      false,
    );
    expect(guardPatch(patch() + patch(), result).passed).toBe(false);
    expect(guardPatch("", result).passed).toBe(false);
    expect(guardPatch(patch(), { ...result, confidence: "medium" }).passed).toBe(false);
    expect(guardPatch(patch(), { ...result, action: "diagnose" }).passed).toBe(false);
    expect(guardPatch(patch(), { ...result, classification: "unknown" }).passed).toBe(false);
  });
  it("rejects an unparsed unified diff hidden before a permitted Git diff", () => {
    const hidden = "--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new\n";
    expect(guardPatch(hidden + patch(), result).reasons).toContain("Unexpected patch preamble");
    const mail = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] fix\n\n`;
    expect(guardPatch(mail + hidden + patch(), result).reasons).toContain(
      "Unexpected patch preamble",
    );
  });
  it("preserves trailing blank context and no-newline markers", () => {
    const text = patch().replace("@@ -1,1 +1,1 @@", "@@ -1,2 +1,2 @@") + " \n";
    expect(guardPatch(text, result).passed).toBe(true);
    expect(guardPatch(`${patch()}\\ No newline at end of file\n`, result).passed).toBe(true);
  });
});

it("renders model and log text as escaped prose while retaining the trusted run link", () => {
  const text = renderPrBody({
    runId: 123,
    attempt: 2,
    result: {
      ...result,
      cause: "<script>@everyone</script>\n# forged",
      evidence: "[click](https://evil.invalid) `code` & |",
    },
    tests: result.failingTests,
    guard: guardPatch(patch(), result),
    prove: "passed\n## spoof",
    base: "a".repeat(40),
  });
  expect(text).toContain("https://github.com/openclaw/openclaw/actions/runs/123/attempts/2");
  expect(text).toContain("&lt;script&gt;&#64;everyone&lt;/script&gt; \\# forged");
  expect(text).toContain("\\[click\\]\\(https://evil\\.invalid\\) \\`code\\` &amp; \\|");
  expect(text).not.toContain("\n## spoof");
  expect(escapeMarkdown("@user <b> &")).toBe("&#64;user &lt;b&gt; &amp;");
});

it("admits only completed canonical failures and permits push only on dispatch", () => {
  const run = {
    id: 123,
    attempt: 1,
    sha: "a".repeat(40),
    event: "schedule",
    branch: "main",
    path: ".github/workflows/ci.yml",
    repository: "openclaw/openclaw",
    headRepository: "openclaw/openclaw",
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-09-26T00:00:00Z",
  };
  expect(canonicalFailure(run, false)).toBe(true);
  expect(canonicalFailure({ ...run, event: "push" }, false)).toBe(false);
  expect(canonicalFailure({ ...run, event: "push" }, true)).toBe(true);
  for (const change of [
    { repository: "fork/openclaw" },
    { headRepository: "fork/openclaw" },
    { branch: "topic" },
    { conclusion: "success" },
    { status: "in_progress" },
    { path: ".github/workflows/other.yml" },
    { event: "pull_request" },
  ]) {
    expect(canonicalFailure({ ...run, ...change }, true)).toBe(false);
  }
});
