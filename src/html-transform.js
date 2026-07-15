export function classifyLavishSdkFailure({ meaningfulContent, sdkStarted, error }) {
  if (!meaningfulContent) return null;
  if (error) return "sdk-crashed";
  if (sdkStarted) return "sdk-startup-stalled";
  return "sdk-not-fetched";
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function createLavishHealthBootstrap(key) {
  return `(() => {
  const sdkPath=${scriptJson(`/sdk.js?key=${encodeURIComponent(key)}`)};
  const classifyLavishSdkFailure=${classifyLavishSdkFailure.toString()};
  const state={ sdkStarted:false, sdkAttached:false, sdkReady:false, sdkError:"", diagnosed:false };
  let startupTimer=0;
  let paintTimer=0;

  function post(message) {
    try { parent.postMessage(message, "*"); } catch {}
  }

  function lifecycle(stage, details={}) {
    post({ type:"lavish:artifactLifecycle", stage, ...details });
  }

  function hasMeaningfulContent() {
    const body=document.body;
    if (!body) return false;
    const ignored=new Set(["SCRIPT","STYLE","LINK","META","TITLE","BASE","TEMPLATE","NOSCRIPT"]);
    const visualTags=new Set(["IMG","PICTURE","SVG","CANVAS","VIDEO","AUDIO","IFRAME","OBJECT","EMBED","INPUT","BUTTON","SELECT","TEXTAREA"]);
    for (const el of body.querySelectorAll("*")) {
      if (ignored.has(el.tagName) || el.closest?.("[data-lavish-ui]")) continue;
      if (el.hidden || el.getAttribute?.("aria-hidden") === "true") continue;
      let style;
      try { style=getComputedStyle(el); } catch { continue; }
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) continue;
      let rect;
      try { rect=el.getBoundingClientRect(); } catch { continue; }
      if (!rect || rect.width <= 1 || rect.height <= 1) continue;
      const text=String(el.innerText || "").trim();
      if (text || visualTags.has(el.tagName)) return true;
    }
    return false;
  }

  function diagnosticCopy(code) {
    if (code === "sdk-not-fetched") return {
      title:"Lavish SDK was not fetched",
      copy:"The browser did not request /sdk.js inside this sandbox. Try Chrome, disable content blocking for localhost, then reload the artifact.",
    };
    if (code === "sdk-crashed") return {
      title:"Lavish SDK crashed during startup",
      copy:"The SDK began loading but threw before startup completed. Open the artifact frame console, capture the first error, then reload.",
    };
    if (code === "sdk-startup-stalled") return {
      title:"Lavish SDK startup stalled",
      copy:"The SDK started but window.lavish never attached. Capture the artifact frame console and network log, then reload.",
    };
    return {
      title:"Artifact content was not painted",
      copy:"The SDK is running and the document has laid-out content, but the browser reported no paint. Preserve this tab, capture a screenshot and console, then reload or open a fresh tab.",
    };
  }

  function renderDiagnostic(code, detail) {
    const existing=document.getElementById("lavish-artifact-diagnostic");
    if (existing) existing.remove();
    const host=document.createElement("div");
    host.id="lavish-artifact-diagnostic";
    host.setAttribute("data-lavish-ui", "artifact-diagnostic");
    host.style.cssText="all:initial!important;display:block!important;position:fixed!important;inset:0!important;z-index:2147483647!important;background:#0f1115!important;color:#f7f3ea!important;";
    const root=host.attachShadow({ mode:"open" });
    const style=document.createElement("style");
    style.textContent=":host{color-scheme:dark}.screen{box-sizing:border-box;min-height:100%;display:grid;place-items:center;padding:24px;background:#0f1115;color:#f7f3ea;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.card{box-sizing:border-box;width:min(560px,100%);padding:24px;border:1px solid #303745;border-radius:14px;background:#11141a}.eyebrow{margin:0 0 8px;color:#f4c95d;font:700 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}.title{margin:0 0 10px;color:#fffbf3;font:600 22px/1.25 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.copy{margin:0;color:#d8deea}.detail{margin:16px 0 0;padding:10px 12px;border:1px solid #303745;border-radius:8px;background:#1c212b;color:#b9c0cf;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}";
    const screen=document.createElement("div");
    screen.className="screen";
    const card=document.createElement("section");
    card.className="card";
    card.setAttribute("role", "alert");
    const eyebrow=document.createElement("p");
    eyebrow.className="eyebrow";
    eyebrow.textContent="Artifact diagnostics";
    const title=document.createElement("h1");
    title.className="title";
    const copy=document.createElement("p");
    copy.className="copy";
    const content=diagnosticCopy(code);
    title.textContent=content.title;
    copy.textContent=content.copy;
    card.append(eyebrow, title, copy);
    if (detail) {
      const detailEl=document.createElement("p");
      detailEl.className="detail";
      detailEl.textContent=detail;
      card.appendChild(detailEl);
    }
    screen.appendChild(card);
    root.append(style, screen);
    document.documentElement?.appendChild(host);
  }

  function report(code, detail="", { revealGate=false }={}) {
    if (state.diagnosed) return;
    state.diagnosed=true;
    const content=diagnosticCopy(code);
    renderDiagnostic(code, detail);
    lifecycle("failed", { failure:code, detail:String(detail || "").slice(0, 500) });
    post({
      type:"lavish:queuePrompt",
      prompt:{
        uid:"",
        prompt:"Lavish diagnostic — " + content.title + ". " + content.copy,
        selector:"html",
        tag:"artifact-diagnostic",
        text:content.title,
        _lavishQueueKey:"lavish:artifact-health",
      },
    });
    if (revealGate) post({ type:"lavish:layoutWarnings", layout_warnings:[] });
    try { console.error("[Lavish artifact diagnostic] " + content.title, detail || ""); } catch {}
  }

  function inspectStartup() {
    if (state.sdkReady || state.diagnosed) return;
    const failure=classifyLavishSdkFailure({
      meaningfulContent:hasMeaningfulContent(),
      sdkStarted:state.sdkStarted,
      error:state.sdkError,
    });
    if (failure) report(failure, state.sdkError, { revealGate:true });
    else lifecycle("empty", { sdkReady:false });
  }

  function inspectPaint() {
    if (!state.sdkReady || state.diagnosed || !hasMeaningfulContent()) return;
    if (document.visibilityState === "hidden" || !performance?.getEntriesByType) {
      lifecycle("paint-unverified");
      return;
    }
    const paints=performance.getEntriesByType("paint").map((entry) => entry.name);
    if (paints.includes("first-paint") || paints.includes("first-contentful-paint")) {
      lifecycle("painted", { paints });
      return;
    }
    report("artifact-not-painted", "No first-paint or first-contentful-paint entry was recorded.");
  }

  const health={
    markSdkStarted() {
      state.sdkStarted=true;
      lifecycle("sdk-started");
    },
    markSdkAttached() {
      state.sdkAttached=true;
      lifecycle("sdk-attached");
    },
    markSdkReady() {
      if (state.sdkReady) return;
      state.sdkReady=true;
      if (startupTimer) clearTimeout(startupTimer);
      lifecycle("sdk-ready", { meaningfulContent:hasMeaningfulContent() });
      paintTimer=setTimeout(inspectPaint, 4000);
      paintTimer?.unref?.();
    },
    report,
  };

  try {
    Object.defineProperty(window, "__lavishArtifactHealth", { value:health, configurable:true });
  } catch {
    window.__lavishArtifactHealth=health;
  }

  window.addEventListener("error", (event) => {
    if (state.sdkReady || state.diagnosed) return;
    const filename=String(event.filename || "");
    if (!state.sdkStarted && !filename.includes("/sdk.js")) return;
    state.sdkError=String(event.error?.stack || event.message || "SDK startup error").slice(0, 1200);
    if (hasMeaningfulContent()) {
      const attachment=state.sdkAttached ? "window.lavish attached before the crash. " : "window.lavish did not attach. ";
      report("sdk-crashed", attachment + state.sdkError, { revealGate:true });
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (!state.sdkStarted || state.sdkReady || state.diagnosed) return;
    state.sdkError=String(event.reason?.stack || event.reason || "Unhandled SDK rejection").slice(0, 1200);
    if (hasMeaningfulContent()) {
      const attachment=state.sdkAttached ? "window.lavish attached before the crash. " : "window.lavish did not attach. ";
      report("sdk-crashed", attachment + state.sdkError, { revealGate:true });
    }
  });

  lifecycle("bootstrap", { sdkPath });
  startupTimer=setTimeout(inspectStartup, 6000);
  startupTimer?.unref?.();
})();`;
}

export function injectLavishSdk(html, key) {
  const bootstrap = `<script>${createLavishHealthBootstrap(key)}</script>`;
  const sdk = `<script data-lavish-sdk src="/sdk.js?key=${encodeURIComponent(key)}"></script>`;
  const scripts = `${bootstrap}${sdk}`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${scripts}</body>`);
  }
  return `${html}\n${scripts}`;
}
