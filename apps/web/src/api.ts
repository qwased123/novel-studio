export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options?.body instanceof ArrayBuffer ? options.headers : { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      code?: string;
      detail?: Record<string, unknown>;
    };
    throw new ApiError(payload.error ?? "请求失败", response.status, payload.code, payload.detail);
  }
  return response.json() as Promise<T>;
}

export async function download(path: string) {
  const response = await fetch(path);
  if (!response.ok) throw new ApiError("导出失败", response.status);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const plain = disposition.match(/filename=([^;]+)/)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : plain ?? "download";
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replaceAll('"', "");
  anchor.click();
  URL.revokeObjectURL(url);
}
