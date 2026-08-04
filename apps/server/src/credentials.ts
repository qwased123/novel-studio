import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dataDir, ensureCredentialFilePermissions } from "./db.js";

const credentialPath = resolve(dataDir, "credentials.json");

type CredentialStore = Record<string, string>;

function readStore(): CredentialStore {
  if (!existsSync(credentialPath)) return {};
  try {
    return JSON.parse(readFileSync(credentialPath, "utf8")) as CredentialStore;
  } catch {
    return {};
  }
}

export function getCredential(role: string) {
  return readStore()[role] ?? "";
}

export function hasCredential(role: string) {
  return Boolean(getCredential(role));
}

export function setCredential(role: string, apiKey: string) {
  const store = readStore();
  if (apiKey.trim()) store[role] = apiKey.trim();
  else delete store[role];
  writeFileSync(credentialPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  ensureCredentialFilePermissions(credentialPath);
}

