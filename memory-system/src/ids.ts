import { createHash, randomUUID } from "node:crypto";

export const newId = () => randomUUID();
export const nowIso = () => new Date().toISOString();
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const normalizeName = (value: string) => value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
export const estimateTokens = (value: string) => Math.max(1, Math.ceil(value.length / 2));
