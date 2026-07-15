import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "parse5";

const MANIFEST_VERSION = 1;
const MAX_LABEL_LENGTH = 120;
const MAX_DIFF_LINES = 120;
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
const HIDDEN_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);

export class ArtifactVersionStore {
  /** @param {string} stateFile */
  constructor(stateFile) {
    this.root = path.join(path.dirname(stateFile), "versions");
    this.queues = new Map();
  }

  /**
   * @param {{ key: string, file: string }} session
   * @param {{ label?: unknown, trigger?: string, source?: string }} [options]
   */
  async snapshot(session, { label, trigger = "change", source } = {}) {
    const key = String(session?.key || "");
    if (!/^[0-9a-f]{16}$/.test(key)) throw new Error("invalid session key");
    return this.serialized(key, async () => {
      const html = source === undefined ? await readFile(session.file, "utf8") : String(source);
      const hash = crypto.createHash("sha256").update(html).digest("hex");
      const manifest = await this.readManifest(key);
      const latest = manifest.versions.at(-1);
      const normalizedLabel = normalizeLabel(label);

      if (latest?.hash === hash) {
        if (normalizedLabel && latest.label !== normalizedLabel) {
          latest.label = normalizedLabel;
          await this.writeManifest(key, manifest);
        }
        return { created: false, version: latest, versions: manifest.versions };
      }

      const number = (latest?.number || 0) + 1;
      const id = `v${String(number).padStart(4, "0")}`;
      const version = {
        id,
        number,
        hash,
        created_at: new Date().toISOString(),
        trigger: normalizeTrigger(trigger),
        ...(normalizedLabel ? { label: normalizedLabel } : {}),
      };
      const dir = this.versionDir(key);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${id}.html`), html);
      manifest.versions.push(version);
      await this.writeManifest(key, manifest);
      return { created: true, version, versions: manifest.versions };
    });
  }

  async list(key) {
    return (await this.readManifest(key)).versions;
  }

  async readVersion(key, id) {
    const manifest = await this.readManifest(key);
    if (!manifest.versions.some((version) => version.id === id)) return null;
    return readFile(path.join(this.versionDir(key), `${id}.html`), "utf8");
  }

  async diff(key, id, baseId) {
    const versions = await this.list(key);
    const index = versions.findIndex((version) => version.id === id);
    if (index === -1) return null;
    const baseIndex = baseId ? versions.findIndex((version) => version.id === baseId) : index - 1;
    const base = baseIndex >= 0 ? versions[baseIndex] : null;
    const current = versions[index];
    if (!base) return { base: null, current, changes: [], truncated: false };
    const [before, after] = await Promise.all([this.readVersion(key, base.id), this.readVersion(key, current.id)]);
    const diff = visibleTextDiff(before || "", after || "");
    return { base, current, ...diff };
  }

  versionDir(key) {
    return path.join(this.root, key);
  }

  async readManifest(key) {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.versionDir(key), "manifest.json"), "utf8"));
      return {
        version: MANIFEST_VERSION,
        versions: Array.isArray(parsed.versions) ? parsed.versions.filter(validVersionRecord) : [],
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: MANIFEST_VERSION, versions: [] };
      throw error;
    }
  }

  async writeManifest(key, manifest) {
    const dir = this.versionDir(key);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, "manifest.json");
    const temporary = path.join(dir, `.manifest-${process.pid}-${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, target);
  }

  serialized(key, operation) {
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(key, current);
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
  }
}

export function visibleTextDiff(beforeHtml, afterHtml) {
  const before = visibleTextLines(beforeHtml);
  const after = visibleTextLines(afterHtml);
  const changes = diffLines(before, after);
  return { changes: changes.slice(0, MAX_DIFF_LINES), truncated: changes.length > MAX_DIFF_LINES };
}

export function visibleTextLines(html) {
  const chunks = [];
  const addBreak = () => {
    if (chunks.at(-1) !== "\n") chunks.push("\n");
  };
  const walk = (node, hidden = false) => {
    const tag = String(node?.tagName || "").toLowerCase();
    const nextHidden = hidden || HIDDEN_TEXT_TAGS.has(tag) || hasHiddenAttribute(node);
    if (BLOCK_TAGS.has(tag)) addBreak();
    if (!nextHidden && node?.nodeName === "#text") chunks.push(String(node.value || ""));
    for (const child of node?.childNodes || []) walk(child, nextHidden);
    if (BLOCK_TAGS.has(tag)) addBreak();
  };
  walk(parse(String(html || "")));
  return chunks
    .join("")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function diffLines(before, after) {
  if (before.length * after.length > 160_000) return setDiffLines(before, after);
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const changes = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i += 1;
      j += 1;
    } else if (j < after.length && (i === before.length || table[i][j + 1] >= table[i + 1][j])) {
      changes.push({ type: "added", text: after[j++] });
    } else {
      changes.push({ type: "removed", text: before[i++] });
    }
  }
  return changes;
}

function setDiffLines(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...before.filter((line) => !afterSet.has(line)).map((text) => ({ type: "removed", text })),
    ...after.filter((line) => !beforeSet.has(line)).map((text) => ({ type: "added", text })),
  ];
}

function hasHiddenAttribute(node) {
  return (node?.attrs || []).some(
    (attr) => attr?.name === "hidden" || (attr?.name === "aria-hidden" && String(attr.value).toLowerCase() === "true"),
  );
}

function normalizeLabel(label) {
  const value = String(label ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value ? value.slice(0, MAX_LABEL_LENGTH) : "";
}

function normalizeTrigger(trigger) {
  return trigger === "open" || trigger === "explicit" ? trigger : "change";
}

function validVersionRecord(version) {
  return (
    version &&
    /^v\d{4,}$/.test(String(version.id || "")) &&
    Number.isInteger(version.number) &&
    version.number > 0 &&
    /^[0-9a-f]{64}$/.test(String(version.hash || ""))
  );
}
