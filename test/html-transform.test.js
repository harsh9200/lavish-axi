import assert from "node:assert/strict";
import test from "node:test";

import { classifyLavishSdkFailure, createLavishHealthBootstrap, injectLavishSdk } from "../src/html-transform.js";

test("injects the Lavish SDK before the closing body tag", () => {
  const html = "<!doctype html><html><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.match(result, /<script data-lavish-sdk src="\/sdk\.js\?key=abc123"><\/script><\/body>/);
  assert.ok(result.indexOf("__lavishArtifactHealth") < result.indexOf("data-lavish-sdk"));
});

test("does not inject Tailwind or DaisyUI design assets so the saved file stays portable", () => {
  const html = '<!doctype html><html><head><title>Hi</title></head><body><h1 class="btn">Hi</h1></body></html>';
  const result = injectLavishSdk(html, "abc123");

  assert.doesNotMatch(result, /\/design\/daisyui\.css/);
  assert.doesNotMatch(result, /\/design\/daisyui-themes\.css/);
  assert.doesNotMatch(result, /\/design\/tailwindcss-browser\.js/);
  assert.doesNotMatch(result, /data-lavish-design/);
});

test("leaves the <head> untouched and appends only the health bootstrap and SDK at end of body", () => {
  const html = "<!doctype html><html><head><title>Hi</title></head><body><h1>Hi</h1></body></html>";
  const result = injectLavishSdk(html, "abc123");

  assert.match(result, /^<!doctype html><html><head><title>Hi<\/title><\/head><body><h1>Hi<\/h1><script>/);
  assert.match(result, /<\/script><script data-lavish-sdk src="\/sdk\.js\?key=abc123"><\/script><\/body><\/html>$/);
});

test("appends the Lavish SDK when the artifact has no body tag", () => {
  const result = injectLavishSdk("<h1>Hi</h1>", "abc123");

  assert.match(result, /^<h1>Hi<\/h1>\n<script>/);
  assert.match(result, /<\/script><script data-lavish-sdk src="\/sdk\.js\?key=abc123"><\/script>$/);
});

test("classifies missing, crashed, and stalled SDK startup without alarming on an empty artifact", () => {
  assert.equal(classifyLavishSdkFailure({ meaningfulContent: true, sdkStarted: false, error: "" }), "sdk-not-fetched");
  assert.equal(
    classifyLavishSdkFailure({
      meaningfulContent: true,
      sdkStarted: true,
      error: "ReferenceError: MutationObserver is not defined",
    }),
    "sdk-crashed",
  );
  assert.equal(
    classifyLavishSdkFailure({ meaningfulContent: true, sdkStarted: true, error: "" }),
    "sdk-startup-stalled",
  );
  assert.equal(classifyLavishSdkFailure({ meaningfulContent: false, sdkStarted: false, error: "" }), null);
});

test("health bootstrap reports specific visible diagnoses over postMessage without opaque-origin storage", () => {
  const bootstrap = createLavishHealthBootstrap("abc123");

  assert.match(bootstrap, /lavish:artifactLifecycle/);
  assert.match(bootstrap, /lavish:queuePrompt/);
  assert.match(bootstrap, /Lavish SDK was not fetched/);
  assert.match(bootstrap, /Lavish SDK crashed during startup/);
  assert.match(bootstrap, /Artifact content was not painted/);
  assert.match(bootstrap, /first-contentful-paint/);
  assert.match(bootstrap, /data-lavish-ui/);
  assert.doesNotMatch(bootstrap, /localStorage|sessionStorage/);
  assert.doesNotThrow(() => new Function(bootstrap));
});
