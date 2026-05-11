import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/session-store.js";

test("queued prompts are returned with DOM snapshot context and then cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" }],
    });

    const first = await store.takeFeedback(session.key);
    assert.equal(first.status, "feedback");
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');
    assert.deepEqual(first.prompts, [
      { uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
    ]);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session makes feedback return ended", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);

    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent replies are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.addAgentReply(session.key, "Applied the requested changes.");

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["agent", "Applied the requested changes."]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("freeform user prompts are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Please make this clearer", selector: "", tag: "message", text: "Freeform message" },
      ],
    });

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["user", "Please make this clearer"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
