import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/pointer-reorder.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const pointer = await import(moduleUrl);

test("pointer reorder starts only after a deliberate finite movement", () => {
  assert.equal(pointer.crossedPointerReorderThreshold(10, 10, 15, 10), false);
  assert.equal(pointer.crossedPointerReorderThreshold(10, 10, 16, 10), true);
  assert.equal(pointer.crossedPointerReorderThreshold(10, 10, 14, 15), true);
  assert.equal(pointer.crossedPointerReorderThreshold(10, 10, Number.NaN, 20), false);
});

test("horizontal targets map left, middle, gaps, and the trailing edge deterministically", () => {
  const items = [
    { id: "a", left: 0, right: 100 },
    { id: "b", left: 110, right: 210 },
    { id: "c", left: 220, right: 320 },
  ];
  assert.deepEqual(pointer.horizontalReorderTarget(items, "b", -20), {
    targetId: "a",
    position: "before",
  });
  assert.deepEqual(pointer.horizontalReorderTarget(items, "b", 90), {
    targetId: "c",
    position: "before",
  });
  assert.deepEqual(pointer.horizontalReorderTarget(items, "b", 400), {
    targetId: "c",
    position: "after",
  });
});

test("a lone source or invalid pointer produces no drop target", () => {
  assert.equal(
    pointer.horizontalReorderTarget([{ id: "only", left: 0, right: 100 }], "only", 50),
    null,
  );
  assert.equal(
    pointer.horizontalReorderTarget([{ id: "a", left: 0, right: 100 }], "other", Infinity),
    null,
  );
});
