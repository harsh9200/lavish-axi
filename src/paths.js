import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function stateDir() {
  return process.env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), ".lavish-axi");
}

export function stateFile() {
  return path.join(stateDir(), "state.json");
}

export function serverLogFile() {
  return path.join(stateDir(), "server.log");
}

export async function ensureStateDir() {
  await mkdir(stateDir(), { recursive: true });
}

export function defaultPort() {
  return Number(process.env.LAVISH_AXI_PORT || 4387);
}
