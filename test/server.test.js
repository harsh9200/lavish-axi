import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createChromeHtml, createSdkJs, resolveArtifactAsset } from "../src/server.js";

test("artifact assets resolve within the artifact directory", () => {
  const root = path.resolve("/tmp/lavish-artifact");

  assert.equal(resolveArtifactAsset(root, "style.css"), path.join(root, "style.css"));
  assert.equal(resolveArtifactAsset(root, "../secret.txt"), null);
});

test("chrome sandbox does not grant modal prompts", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /sandbox="[^"]*allow-modals/);
});

test("artifact SDK uses a custom annotation card instead of browser prompts", () => {
  const js = createSdkJs("abc");

  assert.doesNotMatch(js, /window\.prompt/);
  assert.match(js, /lavish-annotation-card/);
  assert.match(js, /textarea/);
});

test("artifact SDK ignores Lavish-owned annotation UI", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function isLavishUi/);
  assert.match(js, /closest\('\[data-lavish-ui\]'/);
  assert.match(js, /data-lavish-ui/);
});

test("artifact SDK isolates Lavish annotation UI in Shadow DOM", () => {
  const js = createSdkJs("abc");

  assert.match(js, /attachShadow\(\{mode:'open'\}\)/);
  assert.match(js, /:host\{all:initial/);
  assert.match(js, /lavish-annotation-root/);
});

test("annotation card does not block its own Queue Prompt button", () => {
  const js = createSdkJs("abc");

  assert.match(js, /\.lavish-send'\)\.onclick=\(\)=>/);
  assert.doesNotMatch(js, /card\.addEventListener\('click',event=>event\.stopPropagation\(\),true\)/);
});

test("annotation card keeps the selected element highlighted while open", () => {
  const js = createSdkJs("abc");

  assert.match(js, /let selected=null/);
  assert.match(js, /function highlightElement/);
  assert.match(js, /if\(hovered&&hovered!==selected\)/);
});

test("annotation hover remains active while another element is selected", () => {
  const js = createSdkJs("abc");

  assert.doesNotMatch(js, /\|\|selected\)return/);
  assert.match(js, /if\(event\.target===selected\)return/);
  assert.match(js, /if\(hovered&&hovered!==selected\)clearHighlight\(hovered\)/);
});

test("annotation mode forces the artifact cursor to default", () => {
  const js = createSdkJs("abc");

  assert.match(js, /lavish-cursor-style/);
  assert.match(js, /cursor:default!important/);
  assert.match(js, /setAnnotationMode\(enabled\)/);
});

test("turning annotation mode off clears selection and floating card", () => {
  const js = createSdkJs("abc");

  assert.match(js, /if\(!annotationMode\)closeCard\(\)/);
});

test("annotation card title renders selected tag as an html element name", () => {
  const js = createSdkJs("abc");

  assert.match(js, /Annotate &lt;'/);
  assert.match(js, /'&gt;/);
});

test("chrome labels the mode as annotation instead of inspect", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /Annotation: On/);
  assert.doesNotMatch(html, /Inspect/);
});

test("chrome includes a chat-like prompt composer and agent reply listener", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /id="chatLog"/);
  assert.match(html, /id="chatInput"/);
  assert.match(html, /agent-reply/);
});

test("chrome bootstraps persisted chat history so missed replies still appear", () => {
  const html = createChromeHtml({
    key: "abc",
    file: "/tmp/artifact.html",
    chat: [{ role: "agent", text: "Persisted reply", at: "2026-05-11T00:00:00.000Z" }],
  });

  assert.match(html, /const initialChat=/);
  assert.match(html, /Persisted reply/);
  assert.match(html, /initialChat\.forEach/);
});

test("chrome can sync persisted chat after the event stream reconnects", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /chat-sync/);
  assert.match(html, /function syncChat/);
});

test("chrome shows agent working state when no poll is active", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /agent-working/);
  assert.match(html, /Working\.\.\./);
  assert.match(html, /spinner/);
});

test("chrome disables sending while agent is working", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /let agentPolling=false/);
  assert.match(html, /sendButton\.disabled=!agentPolling/);
  assert.match(html, /if\(!agentPolling\)return/);
});

test("chrome puts queued annotations inside the chat composer as preview pills", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /id="annotationPills"/);
  assert.match(html, /class="pill/);
  assert.match(html, /pill-preview/);
  assert.match(html, /removeQueuedPrompt/);
  assert.match(html, /pill-tooltip/);
  assert.match(html, /text-overflow:ellipsis/);
  assert.doesNotMatch(html, /togglePill/);
  assert.doesNotMatch(html, /pill-detail/);
  assert.doesNotMatch(html, /<h2>Queued Annotations<\/h2>/);
});

test("chrome omits clear queue button because pills can be removed individually", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /removeQueuedPrompt/);
  assert.doesNotMatch(html, /Clear Queue/);
  assert.doesNotMatch(html, /id="clear"/);
});

test("annotation pill tooltip separates target and prompt details", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /tooltip-label/);
  assert.match(html, /Target/);
  assert.match(html, /Prompt/);
  assert.match(html, /pill-tooltip-target/);
  assert.match(html, /pill-tooltip-prompt/);
});

test("chrome inline script is valid JavaScript", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const match = html.match(/<script>([\s\S]*)<\/script>/);

  assert.ok(match);
  assert.doesNotThrow(() => new Function(match[1]));
});

test("chrome omits the extra conversation description copy", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /Annotate elements in the artifact, or write a freeform message below/);
});

test("composer textarea is sized within the right panel", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /\.layout\{[^}]*min-height:0/);
  assert.match(html, /\.panel\{[^}]*min-height:0/);
  assert.match(html, /\.chat\{[^}]*min-height:0/);
  assert.match(html, /\.composer\{[^}]*min-width:0/);
  assert.match(html, /\.composer\{[^}]*flex-shrink:0/);
  assert.match(html, /\.composer textarea\{[^}]*box-sizing:border-box/);
});

test("hot reload resets iframe src instead of crossing sandbox location", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /contentWindow\.location\.reload/);
  assert.match(html, /frame\.src\s*=\s*frame\.src/);
});

test("chrome ignores Lavish postMessages not sent by the artifact iframe", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /event\.source\s*!==\s*frame\.contentWindow/);
});
