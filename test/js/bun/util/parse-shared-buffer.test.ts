import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";
import path from "node:path";

const fixture = path.join(import.meta.dir, "parse-shared-buffer-fixture.ts");

// Each parser reads a byte more than once: the transpiler re-reads the digits
// of a numeric literal after it counts the separators, the markdown renderer
// re-reads the byte its needle search found, YAML asserts the byte its scanner
// classified, and TOML measures a string before it converts it. A worker that
// writes the SharedArrayBuffer between the two reads aborted the process.
//
// The call count is the one that aborts the build without the fix on every
// run, with margin.
test.each([
  ["transpiler", 500],
  ["markdown", 8000],
  ["ansi", 8000],
  ["yaml", 1000],
  ["toml", 2000],
])(
  "%s parses a SharedArrayBuffer a worker writes",
  async (api, calls) => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), fixture, api, String(calls)],
      env: bunEnv,
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect({ stdout: stdout.trim(), stderr: stderr.trim() }).toEqual({ stdout: "ok", stderr: "" });
    expect(exitCode).toBe(0);
  },
  // The call count is fixed, so the run time follows the machine. A debug
  // build takes about 3 s per entry point here.
  30_000,
);
