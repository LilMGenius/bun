// Fixture for parse-shared-buffer.test.ts.
//
//   bun parse-shared-buffer-fixture.ts <api> <calls>
//
// A worker rewrites a SharedArrayBuffer while the main thread parses it. Every
// parser here reads a byte more than once, so it must read a private copy of
// the bytes. Prints "ok" when every call returns or throws.
import { isMainThread, Worker, workerData } from "node:worker_threads";

// The two texts of a pair have the same length and differ only in the bytes
// that decide how a scanner classifies a position: an entity, a tag, a list
// item, a link, a string quote, a numeric separator, a UTF-8 lead byte. The
// worker writes one, then the other, so a byte a parser reads twice changes
// between the reads.
const TS_SOURCE = 'let a = 123_456_789; let b = `x${a}` + "s\\u0041" + /re[x]/g.source;//'.padEnd(128);
const TS_OTHER = "export const f = (x: number) => x + 0x1f + 1_000n; /* c */ f(2)".padEnd(128);
const MARKDOWN = '# H0\n\n* item **b** _i_ [l](http://x/y "t") `c` & <b>\n\n';
const YAML = 'a: 1\nb:\n  - x\n  - "y€"\nc: {d: e}\n';
const TOML = 'a = 1\n[b]\nc = "y€é"\nd = [1,2]\n';

const TEXT: Record<string, string> = {
  transpiler: TS_SOURCE,
  markdown: MARKDOWN.repeat(2),
  ansi: MARKDOWN.repeat(2),
  yaml: YAML.repeat(2),
  toml: TOML.repeat(2),
};

const api = process.argv[2];
const calls = Number(process.argv[3]);
const base = new TextEncoder().encode(TEXT[api]);

// Each byte that opens or closes a construct becomes a different one, and
// three of them become UTF-8 lead or continuation bytes with nothing to pair
// with. A scanner that classifies a position and reads it again gets a
// different answer the second time.
const SWAP: Record<number, number> = {
  0x0a: 0x7c, //  \n -> |
  0x20: 0x0a, //     -> \n
  0x22: 0x60, //   " -> `
  0x23: 0x3e, //   # -> >
  0x26: 0x3c, //   & -> <
  0x28: 0x5d, //   ( -> ]
  0x29: 0x28, //   ) -> (
  0x2a: 0x5b, //   * -> [
  0x2d: 0x3a, //   - -> :
  0x3a: 0x2d, //   : -> -
  0x3c: 0x26, //   < -> &
  0x5b: 0x2a, //   [ -> *
  0x5d: 0x29, //   ] -> )
  0x60: 0x22, //   ` -> "
  0x65: 0xe2, //   e -> 3-byte lead
  0x78: 0x80, //   x -> continuation
  0x7b: 0xf0, //   { -> 4-byte lead
};

function otherText(): Uint8Array {
  if (api === "transpiler") return new TextEncoder().encode(TS_OTHER);
  const other = new Uint8Array(base);
  for (let i = 0; i < base.length; i++) {
    // A UTF-8 lead byte that turns into ASCII changes the unit count a
    // measure pass reported to the convert pass that follows it.
    other[i] = base[i] > 0x7f ? 0x61 : (SWAP[base[i]] ?? base[i]);
  }
  return other;
}

if (isMainThread) {
  const bytes = new SharedArrayBuffer(base.length);
  const ready = new SharedArrayBuffer(4);
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { bytes, ready },
    argv: [api, String(calls)],
  });
  worker.unref();

  const input = new Uint8Array(bytes);
  input.set(base);

  // Parse only once the worker writes.
  Atomics.wait(new Int32Array(ready), 0, 0, 10_000);

  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const call: Record<string, () => unknown> = {
    transpiler: () => transpiler.transformSync(input),
    markdown: () => Bun.markdown.html(input),
    ansi: () => Bun.markdown.ansi(input),
    yaml: () => Bun.YAML.parse(input),
    toml: () => Bun.TOML.parse(input),
  };

  for (let i = 0; i < calls; i++) {
    try {
      call[api]();
    } catch {}
  }

  console.log("ok");
  process.exit(0);
} else {
  const { bytes, ready } = workerData as { bytes: SharedArrayBuffer; ready: SharedArrayBuffer };
  const input = new Uint8Array(bytes);
  const other = otherText();

  const flag = new Int32Array(ready);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);

  // The two whole-buffer writes change every classifying byte twice per pass.
  // That is the fastest way to change a byte between two reads of it.
  //
  // Some scanners derive a position from a span they already read, not from
  // one byte, so the burst writes bytes the document never had and changes
  // its shape. TOML reaches its second read only on a document that parses,
  // so its input stays valid and takes no burst.
  let state = 1234567;
  const rand = () => ((state ^= state << 13), (state ^= state >>> 17), (state ^= state << 5), state >>> 0);
  const noise = [
    0x26, 0x3c, 0x3e, 0x22, 0x61, 0x0a, 0x60, 0x2a, 0x5b, 0x5d, 0x28, 0x29, 0x7c, 0x20, 0x23, 0x39, 0x5c, 0x27,
    0x3a, 0x2d, 0x80, 0xe2, 0xf0,
  ];
  const burst = api === "toml" ? 0 : 16;
  const size = input.length;
  for (;;) {
    for (let i = 0; i < size; i++) input[i] = base[i];
    for (let k = 0; k < burst; k++) input[rand() % size] = noise[rand() % noise.length];
    for (let i = size - 1; i >= 0; i--) input[i] = other[i];
    for (let k = 0; k < burst; k++) input[rand() % size] = noise[rand() % noise.length];
  }
}
