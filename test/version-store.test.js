import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactVersionStore, visibleTextDiff, visibleTextLines } from "../src/version-store.js";

test("artifact versions persist beside state and dedupe identical HTML", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-versions-"));
  const file = path.join(dir, "board.html");
  const session = { key: "0123456789abcdef", file };
  const store = new ArtifactVersionStore(path.join(dir, "state.json"));
  try {
    await writeFile(file, "<!doctype html><h1>Round one</h1>");
    const first = await store.snapshot(session, { trigger: "open" });
    const duplicate = await store.snapshot(session, { trigger: "change", label: "Planning baseline" });
    await writeFile(file, "<!doctype html><h1>Round two</h1>");
    const second = await store.snapshot(session, { trigger: "change" });

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.version.label, "Planning baseline");
    assert.equal(second.version.id, "v0002");
    assert.deepEqual(
      (await store.list(session.key)).map((version) => version.id),
      ["v0001", "v0002"],
    );
    assert.equal(await store.readVersion(session.key, "v0001"), "<!doctype html><h1>Round one</h1>");
    const manifest = JSON.parse(await readFile(path.join(dir, "versions", session.key, "manifest.json"), "utf8"));
    assert.equal(manifest.versions.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visible text extraction excludes scripts and hidden content", () => {
  assert.deepEqual(
    visibleTextLines(
      "<main><h1>Hello</h1><p>Planner <strong>board</strong></p><script>nope()</script><p hidden>Secret</p></main>",
    ),
    ["Hello", "Planner board"],
  );
});

test("visible text diff reports reviewer-facing additions and removals", () => {
  assert.deepEqual(visibleTextDiff("<h1>Plan</h1><p>Draft</p>", "<h1>Plan</h1><p>Approved</p>").changes, [
    { type: "added", text: "Approved" },
    { type: "removed", text: "Draft" },
  ]);
});

test("version diff defaults to the immediately previous round", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-versions-"));
  const file = path.join(dir, "board.html");
  const session = { key: "0123456789abcdef", file };
  const store = new ArtifactVersionStore(path.join(dir, "state.json"));
  try {
    await writeFile(file, "<h1>Plan</h1><p>Draft</p>");
    await store.snapshot(session);
    await writeFile(file, "<h1>Plan</h1><p>Approved</p>");
    await store.snapshot(session);
    const diff = await store.diff(session.key, "v0002");
    assert.equal(diff.base.id, "v0001");
    assert.equal(diff.current.id, "v0002");
    assert.deepEqual(diff.changes, [
      { type: "added", text: "Approved" },
      { type: "removed", text: "Draft" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
