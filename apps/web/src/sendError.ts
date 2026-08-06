import { ApiError } from "./api";

export function formatSendFailure(error: unknown, persisted: boolean): string {
  if (!persisted) return error instanceof Error ? error.message : "发送失败，请重试";
  if (error instanceof ApiError) return `消息已保存，但发送失败：${error.message}`;
  return "消息已保存，但未收到回复。请检查会话后继续。";
}
