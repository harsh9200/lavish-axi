import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import chokidar from "chokidar";
import express from "express";

import { injectLavishSdk } from "./html-transform.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";

export async function serve({ port, stateFile }) {
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      const url = `http://localhost:${port}/session/${key}`;
      const session = await store.upsertSession(file, url);
      watchSession(session, watchers, events);
      res.json({ key, file, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/poll", async (req, res, next) => {
    try {
      const file = await canonicalFile(String(req.query.file || ""));
      const key = sessionKey(file);
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        res.json(immediate);
        return;
      }
      setPollActive(key, activePolls, events, true);
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(async () => {
              cleanup();
              res.json(await store.takeFeedback(key));
            }, timeoutMs);
      const onFeedback = async (changedKey) => {
        if (changedKey !== key || res.headersSent) {
          return;
        }
        cleanup();
        res.json(await store.takeFeedback(key));
      };
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        setPollActive(key, activePolls, events, false);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      const session = await store.queuePrompts(req.params.key, req.body || {});
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("feedback", req.params.key);
      res.json({ status: "queued", pending_prompts: session.pending_prompts });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      await store.endSession(req.params.key);
      events.emit("ended", req.params.key);
      res.json({ status: "ended" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const text = String(req.body?.text || "");
      const session = await store.addAgentReply(req.params.key, text);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      events.emit("agent-reply", req.params.key, text);
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      await store.endSession(key);
      events.emit("ended", key);
      res.json({ status: "ended" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      watchSession(session, watchers, events);
      res.type("html").send(createChromeHtml(session));
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const html = await readFile(session.file, "utf8");
      res.type("html").send(injectLavishSdk(html, key));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const root = path.dirname(session.file);
      const file = resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file);
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", async (req, res, next) => {
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const session = await store.findByKey(req.params.key);
      const sendReload = (key) => {
        if (key === req.params.key) {
          res.write("event: reload\ndata: {}\n\n");
        }
      };
      const sendAgentReply = (key, text) => {
        if (key === req.params.key) {
          res.write(`event: agent-reply\ndata: ${JSON.stringify({ text })}\n\n`);
        }
      };
      const sendWorking = (key, working) => {
        if (key === req.params.key) {
          res.write(`event: agent-working\ndata: ${JSON.stringify({ working })}\n\n`);
        }
      };
      res.write(`event: chat-sync\ndata: ${JSON.stringify({ chat: session?.chat || [] })}\n\n`);
      res.write(`event: agent-working\ndata: ${JSON.stringify({ working: !activePolls.has(req.params.key) })}\n\n`);
      events.on("reload", sendReload);
      events.on("agent-reply", sendAgentReply);
      events.on("agent-working", sendWorking);
      req.on("close", () => {
        events.off("reload", sendReload);
        events.off("agent-reply", sendAgentReply);
        events.off("agent-working", sendWorking);
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", (req, res) => {
    res.type("application/javascript").send(createSdkJs(String(req.query.key || "")));
  });

  app.use((error, req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  await new Promise((resolve) => {
    app.listen(port, "127.0.0.1", resolve);
  });
}

export function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

function watchSession(session, watchers, events) {
  if (watchers.has(session.key)) {
    return;
  }
  const root = path.dirname(session.file);
  const watcher = chokidar.watch(root, {
    ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi)([/\\]|$)/,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  let timer = null;
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), 100);
  });
  watchers.set(session.key, watcher);
}

function setPollActive(key, activePolls, events, active) {
  const count = activePolls.get(key) || 0;
  const nextCount = active ? count + 1 : Math.max(0, count - 1);
  if (nextCount === count) return;
  if (nextCount === 0) {
    activePolls.delete(key);
  } else {
    activePolls.set(key, nextCount);
  }
  if (count > 0 === nextCount > 0) return;
  events.emit("agent-working", key, nextCount === 0);
}

export function createChromeHtml(session) {
  const initialChat = JSON.stringify(session.chat || []);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish Editor</title>
<style>
body{margin:0;background:#0f1115;color:#f7f3ea;font:14px/1.4 ui-sans-serif,system-ui,sans-serif;overflow:hidden}
.bar{height:56px;display:flex;align-items:center;gap:12px;padding:0 16px;background:#171a21;border-bottom:1px solid #2a2f3a;box-sizing:border-box}
.brand{font-weight:750;letter-spacing:.02em}.file{color:#b9c0cf;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
button{border:0;border-radius:10px;padding:9px 12px;background:#f4c95d;color:#17130a;font-weight:700;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}
button.secondary{background:#2a2f3a;color:#f7f3ea}button.danger{background:#f06464;color:white}
.layout{height:calc(100vh - 56px);min-height:0;display:grid;grid-template-columns:1fr 360px}.frame{background:white}.panel{border-left:1px solid #2a2f3a;background:#11141a;display:flex;flex-direction:column;min-width:0;min-height:0}
.panel h2{font-size:15px;margin:16px 16px 8px}.chat{flex:1;min-height:0;overflow:auto;padding:0 16px 12px;display:flex;flex-direction:column;gap:10px}.bubble{border-radius:14px;padding:10px 12px;background:#1c212b;border:1px solid #303745}.bubble.user{background:#25230f;border-color:#5d4d1b}.bubble.agent{background:#172419;border-color:#315f3a}.bubble.agent-working{display:flex;align-items:center;gap:8px;color:#d8deea}.spinner{width:14px;height:14px;border-radius:999px;border:2px solid #315f3a;border-top-color:#8fe39e;animation:spin .8s linear infinite}.bubble small{display:block;color:#aeb6c6;margin-bottom:4px}@keyframes spin{to{transform:rotate(360deg)}}.composer{display:grid;gap:8px;padding:12px 16px;border-top:1px solid #2a2f3a;min-width:0;flex-shrink:0;box-sizing:border-box}.annotation-pills{display:flex;flex-wrap:wrap;gap:6px;min-width:0}.pill-wrap{position:relative;max-width:100%}.pill{display:flex;align-items:center;gap:6px;max-width:100%;border:1px solid #3c4557;border-radius:999px;background:#1c212b;color:#d8deea;padding:5px 7px 5px 9px;font-size:12px;font-weight:750}.pill-preview{display:block;max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.pill-close{width:18px;height:18px;border:0;border-radius:999px;padding:0;background:#303745;color:#d8deea;line-height:18px;font-size:14px}.pill-tooltip{display:none;position:absolute;z-index:5;left:0;bottom:calc(100% + 8px);width:min(320px,80vw);border:1px solid #3c4557;border-radius:12px;background:#171a21;color:#d8deea;padding:10px;font-size:12px;font-weight:500;box-shadow:0 16px 44px rgba(0,0,0,.35)}.tooltip-label{color:#8c96aa;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;margin:0 0 4px}.pill-tooltip-target{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1115;border:1px solid #303745;border-radius:8px;padding:6px;margin-bottom:8px;overflow-wrap:anywhere}.pill-tooltip-prompt{white-space:pre-wrap;overflow-wrap:anywhere}.pill-wrap:hover .pill-tooltip{display:block}.composer textarea{width:100%;max-width:100%;min-width:0;min-height:82px;resize:vertical;border-radius:12px;border:1px solid #303745;background:#0f1115;color:#f7f3ea;padding:10px;font:inherit;box-sizing:border-box}.actions{display:flex;gap:8px}
iframe{width:100%;height:100%;border:0;background:white}
</style>
</head>
<body>
<div class="bar"><div class="brand">Lavish Editor</div><div class="file">${escapeHtml(session.file)}</div><button id="annotation">Annotation: On</button><button class="danger" id="end">End Session</button></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" src="/artifact/${session.key}/index.html"></iframe></div><aside class="panel"><h2>Conversation</h2><div class="chat" id="chatLog"></div><div class="composer"><div class="annotation-pills" id="annotationPills"></div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="actions"><button id="send">Send to Agent</button></div></div></aside></div>
<script>
const key=${JSON.stringify(session.key)};
const initialChat=${initialChat};
const frame=document.getElementById('artifact');
const annotationPills=document.getElementById('annotationPills');
const chatLog=document.getElementById('chatLog');
const chatInput=document.getElementById('chatInput');
const sendButton=document.getElementById('send');
const queued=[];
let annotation=true;
let agentPolling=false;
let pendingSnapshot='';
let workingBubble=null;
function render(){annotationPills.innerHTML=queued.map((p,i)=>'<div class="pill-wrap"><div class="pill"><span class="pill-preview">'+escapeHtml(p.prompt)+'</span><button class="pill-close" type="button" aria-label="Remove queued prompt" onclick="removeQueuedPrompt('+i+',event)">×</button></div><div class="pill-tooltip">'+(p.selector?'<div class="tooltip-label">Target</div><div class="pill-tooltip-target">'+escapeHtml(p.selector)+'</div>':'')+'<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">'+escapeHtml(p.prompt)+'</div></div></div>').join('')}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function addChat(role,text){if(!text)return;const el=document.createElement('div');el.className='bubble '+role;el.innerHTML='<small>'+(role==='agent'?'Agent':'You')+'</small><div>'+escapeHtml(text)+'</div>';chatLog.appendChild(el);chatLog.scrollTop=chatLog.scrollHeight}
function syncChat(chat){for(const el of [...chatLog.querySelectorAll('.bubble.user,.bubble.agent:not(.agent-working)')])el.remove();for(const item of chat)addChat(item.role,item.text);if(workingBubble)chatLog.appendChild(workingBubble);chatLog.scrollTop=chatLog.scrollHeight}
function setAgentPolling(active){agentPolling=!!active;sendButton.disabled=!agentPolling;if(agentPolling){if(workingBubble)workingBubble.remove();workingBubble=null;return}if(!workingBubble){workingBubble=document.createElement('div');workingBubble.className='bubble agent agent-working';workingBubble.innerHTML='<span class="spinner"></span><span>Working...</span>';chatLog.appendChild(workingBubble)}chatLog.scrollTop=chatLog.scrollHeight}
function removeQueuedPrompt(index,event){if(event)event.stopPropagation();queued.splice(index,1);render()}
function postToFrame(message){frame.contentWindow&&frame.contentWindow.postMessage(message,'*')}
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;const msg=event.data||{};if(msg.type==='lavish:queuePrompt'){queued.push(msg.prompt);render()}if(msg.type==='lavish:snapshot'){pendingSnapshot=msg.snapshot||'';submitQueued()}if(msg.type==='lavish:sendQueuedPrompts'){sendQueued()}if(msg.type==='lavish:endSession'){endSession()}});
document.getElementById('annotation').onclick=()=>{annotation=!annotation;document.getElementById('annotation').textContent='Annotation: '+(annotation?'On':'Off');postToFrame({type:'lavish:setAnnotationMode',enabled:annotation})};
sendButton.onclick=sendQueued;document.getElementById('end').onclick=endSession;
frame.addEventListener('load',()=>postToFrame({type:'lavish:setAnnotationMode',enabled:annotation}));
function sendQueued(){if(!agentPolling)return;const text=chatInput.value.trim();if(text){queued.push({uid:'',prompt:text,selector:'',tag:'message',text:'Freeform message'});addChat('user',text);chatInput.value='';render()}if(!queued.length)return;postToFrame({type:'lavish:requestSnapshot'})}
async function submitQueued(){const prompts=queued.splice(0,queued.length);render();setAgentPolling(false);await fetch('/api/'+key+'/prompts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompts,domSnapshot:pendingSnapshot})})}
async function endSession(){await fetch('/api/'+key+'/end',{method:'POST'});document.body.innerHTML='<div class="bar"><div class="brand">Lavish Editor</div><div class="file">Session ended. The agent polling loop can stop.</div></div>'}
const events=new EventSource('/events/'+key);events.addEventListener('reload',()=>{frame.src=frame.src});events.addEventListener('agent-reply',event=>addChat('agent',JSON.parse(event.data).text));events.addEventListener('chat-sync',event=>syncChat(JSON.parse(event.data).chat||[]));events.addEventListener('agent-working',event=>setAgentPolling(!JSON.parse(event.data).working));render();initialChat.forEach(item=>addChat(item.role,item.text));setAgentPolling(false);
</script>
</body>
</html>`;
}

export function createSdkJs(key) {
  return `(() => {
const key=${JSON.stringify(key)};
let annotationMode=true;
let hovered=null;
let selected=null;
let host=null;
let shadow=null;
let counter=0;
const ids=new WeakMap();
function uid(el){if(!ids.has(el))ids.set(el,String(++counter));return ids.get(el)}
function selector(el){if(!el||!el.tagName)return'';const parts=[];let node=el;while(node&&node.nodeType===1&&parts.length<5){let part=node.tagName.toLowerCase();if(node.id){part+='#'+CSS.escape(node.id);parts.unshift(part);break}const parent=node.parentElement;if(parent){const same=[...parent.children].filter(x=>x.tagName===node.tagName);if(same.length>1)part+=':nth-of-type('+(same.indexOf(node)+1)+')'}parts.unshift(part);node=parent}return parts.join(' > ')}
function context(el){return{uid:uid(el),selector:selector(el),tag:(el.tagName||'').toLowerCase(),text:(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,240)}}
function isLavishUi(el){return !!(el&&el.closest&&el.closest('[data-lavish-ui]'))}
function highlightElement(el){if(el){el.style.outline='2px solid #f4c95d';el.style.outlineOffset='2px'}}
function clearHighlight(el){if(el)el.style.outline=''}
function setAnnotationMode(enabled){annotationMode=!!enabled;let style=document.getElementById('lavish-cursor-style');if(annotationMode&&!style){style=document.createElement('style');style.id='lavish-cursor-style';style.textContent='*{cursor:default!important}';document.head.appendChild(style)}if(!annotationMode&&style)style.remove();if(!annotationMode)closeCard()}
function queuePrompt(prompt,options={}){const item={...context(options.element||document.activeElement||document.body),prompt:String(prompt||'')};if(options.uid)item.uid=String(options.uid);if(options.selector)item.selector=String(options.selector);if(options.tag)item.tag=String(options.tag);if(options.text)item.text=String(options.text);if(options.data)item.prompt+='\\n\\nContext data:\\n'+JSON.stringify(options.data,null,2);parent.postMessage({type:'lavish:queuePrompt',prompt:item},'*')}
function sendQueuedPrompts(){parent.postMessage({type:'lavish:sendQueuedPrompts'},'*')}
function endSession(){parent.postMessage({type:'lavish:endSession'},'*')}
function snapshot(){const lines=[];function walk(el,depth){if(!(el instanceof Element)||depth>6||isLavishUi(el))return;const c=context(el);const name=c.text?' "'+c.text.slice(0,80).replace(/"/g,"'")+'"':'';lines.push('  '.repeat(depth)+'uid='+c.uid+' '+c.tag+name);for(const child of el.children)walk(child,depth+1)}walk(document.body,0);return lines.join('\\n')}
function ensureShadow(){if(shadow)return shadow;host=document.createElement('div');host.className='lavish-annotation-root';host.setAttribute('data-lavish-ui','annotation-root');document.documentElement.appendChild(host);shadow=host.attachShadow({mode:'open'});const style=document.createElement('style');style.textContent=':host{all:initial;position:fixed;z-index:2147483647;left:0;top:0;color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}.lavish-annotation-card{position:fixed;width:min(320px,calc(100vw - 24px));padding:12px;border-radius:14px;background:#11141a;color:#f7f3ea;border:1px solid #f4c95d;box-shadow:0 20px 70px rgba(0,0,0,.35);font:14px/1.4 ui-sans-serif,system-ui,sans-serif}.lavish-annotation-card textarea{width:100%;min-height:86px;resize:vertical;border-radius:10px;border:1px solid #303745;background:#0f1115;color:#f7f3ea;padding:9px;font:inherit}.lavish-annotation-card .lavish-row{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}.lavish-annotation-card button{border:0;border-radius:9px;padding:8px 10px;font-weight:800;cursor:pointer}.lavish-annotation-card .lavish-send{background:#f4c95d;color:#17130a}.lavish-annotation-card .lavish-cancel{background:#2a2f3a;color:#f7f3ea}';shadow.appendChild(style);return shadow}
function closeCard(){if(shadow){for(const el of [...shadow.querySelectorAll('.lavish-annotation-card')])el.remove()}clearHighlight(selected);selected=null}
function showAnnotationCard(target){const root=ensureShadow();closeCard();selected=target;highlightElement(selected);const c=context(target);const rect=target.getBoundingClientRect();const card=document.createElement('div');card.className='lavish-annotation-card';card.innerHTML='<div style="font-weight:800;margin-bottom:6px">Annotate &lt;'+c.tag+'&gt;</div><textarea placeholder="Tell the agent what to change about this element..."></textarea><div class="lavish-row"><button class="lavish-cancel" type="button">Cancel</button><button class="lavish-send" type="button">Queue Prompt</button></div>';root.appendChild(card);const left=Math.min(Math.max(12,rect.left),window.innerWidth-card.offsetWidth-12);const top=Math.min(Math.max(12,rect.bottom+8),window.innerHeight-card.offsetHeight-12);card.style.left=left+'px';card.style.top=top+'px';const textarea=card.querySelector('textarea');card.querySelector('.lavish-cancel').onclick=closeCard;card.querySelector('.lavish-send').onclick=()=>{const prompt=textarea.value.trim();if(prompt)queuePrompt(prompt,c);closeCard()};setTimeout(()=>textarea.focus(),0)}
window.lavish={queuePrompt,sendQueuedPrompts,endSession,getQueuedPrompts:()=>[],setStatus:message=>parent.postMessage({type:'lavish:status',message:String(message)},'*'),snapshot};
window.addEventListener('message',event=>{const msg=event.data||{};if(msg.type==='lavish:setAnnotationMode')setAnnotationMode(msg.enabled);if(msg.type==='lavish:requestSnapshot')parent.postMessage({type:'lavish:snapshot',snapshot:snapshot()},'*')});
document.addEventListener('mouseover',event=>{if(!annotationMode||isLavishUi(event.target))return;if(event.target===selected)return;if(hovered&&hovered!==selected)clearHighlight(hovered);hovered=event.target;highlightElement(hovered)},true);
document.addEventListener('mouseout',()=>{if(hovered&&hovered!==selected){clearHighlight(hovered);hovered=null}},true);
document.addEventListener('click',event=>{if(!annotationMode||isLavishUi(event.target))return;event.preventDefault();event.stopPropagation();showAnnotationCard(event.target)},true);
setAnnotationMode(annotationMode);
})();`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}
