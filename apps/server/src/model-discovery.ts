export const MODEL_DISCOVERY_PROVIDERS = ["openai", "anthropic", "openai-compatible"] as const;
export type ModelDiscoveryProvider = typeof MODEL_DISCOVERY_PROVIDERS[number];
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

export interface ModelDiscoveryRequest {
  provider: ModelDiscoveryProvider;
  baseUrl?: string;
  apiKey: string;
}

const DEFAULT_BASE_URLS: Record<Exclude<ModelDiscoveryProvider, "openai-compatible">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

function stripTrailingSlashes(path: string) {
  if (path.length > 1) return path.replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

export function normalizeModelsEndpoint(provider: ModelDiscoveryProvider, baseUrl?: string): URL {
  const trimmed = baseUrl?.trim();
  let url: URL;
  if (!trimmed) {
    if (provider === "openai-compatible") throw new Error("OpenAI-compatible 供应商必须提供 Base URL");
    url = new URL(DEFAULT_BASE_URLS[provider]);
  } else {
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("Base URL 必须是合法的 http/https 地址");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL 必须是 http 或 https 地址");
    if (url.username || url.password) throw new Error("Base URL 不能包含用户名或密码");
    if (url.search || url.hash) throw new Error("Base URL 不能包含查询参数或片段");
  }

  const path = stripTrailingSlashes(url.pathname);
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith("/v1/models") || lowerPath.endsWith("/models")) {
    url.pathname = path;
  } else if (lowerPath.endsWith("/v1")) {
    url.pathname = `${path}/models`;
  } else {
    url.pathname = `${path || ""}/v1/models`;
  }
  return url;
}

function headersFor(provider: ModelDiscoveryProvider, apiKey: string): Record<string, string> {
  if (provider === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
  }
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

async function errorDetail(response: Response) {
  let text = "";
  try {
    text = (await response.text()).trim().slice(0, 500);
  } catch {
    return "供应商未返回错误详情";
  }
  if (!text) return "供应商未返回错误详情";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown; detail?: unknown };
    const message = parsed.error?.message ?? parsed.message ?? parsed.detail;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // Fall through to the raw response text below.
  }
  return text.slice(0, 300) || "供应商未返回错误详情";
}

function extractModelIds(payload: unknown): string[] {
  // Provider /models endpoints return model identifiers only; they do not
  // include reliable per-model capability metadata such as supported reasoning
  // efforts. OpenAI-compatible endpoints vary and Anthropic/OpenAI responses
  // have no standardized capability field, so capability discovery is not
  // attempted here and unsupported efforts are handled from request errors.
  const root = payload as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(root)
    ? root
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : null;
  if (!list) throw new Error("模型接口响应缺少 data/models 模型数组");
  const ids: string[] = [];
  for (const entry of list) {
    const id = typeof entry === "string" ? entry : (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  if (!ids.length) throw new Error("模型接口没有返回可用模型 ID");
  return ids;
}

export async function discoverModels(input: ModelDiscoveryRequest): Promise<string[]> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("API Key 不能为空");
  const url = normalizeModelsEndpoint(input.provider, input.baseUrl);
  const headers = headersFor(input.provider, apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`请求模型列表超时（${MODEL_DISCOVERY_TIMEOUT_MS / 1000} 秒）`);
      throw new Error(`无法连接模型供应商：${error instanceof Error ? error.message : "网络错误"}`);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`模型接口返回重定向（HTTP ${response.status}），已停止跟随以避免泄露 API Key`);
    }
    if (!response.ok) {
      throw new Error(`模型接口请求失败（HTTP ${response.status}）：${await errorDetail(response)}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("模型接口响应不是有效 JSON");
    }
    const ids = extractModelIds(payload);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timeout);
  }
}
