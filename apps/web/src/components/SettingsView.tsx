import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Server, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";

interface Profile { role: string; provider: string; model: string; baseUrl: string; temperature: number; maxOutputTokens: number; enabled: boolean; hasApiKey: boolean }
const roleNames: Record<string, { name: string; detail: string }> = {
  planner: { name: "规划模型", detail: "创意、总纲、卷纲与章纲" }, writer: { name: "正文模型", detail: "章节、场景与局部改写" },
  reviewer: { name: "审校模型", detail: "一致性、情节与文风检查" }, extractor: { name: "记忆模型", detail: "事实、摘要与伏笔抽取" },
  embedder: { name: "向量模型", detail: "语义检索索引与相关片段召回" },
};

function ProfileRow({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ ...profile, apiKey: "" });
  useEffect(() => setForm({ ...profile, apiKey: "" }), [profile]);
  const save = useMutation({ mutationFn: () => api(`/api/model-profiles/${profile.role}`, { method: "PUT", body: JSON.stringify(form) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["profiles"] }) });
  return <div className="profile-row"><div className="profile-info"><span className="profile-icon"><Server size={17} /></span><div><strong>{roleNames[profile.role]?.name}</strong><span>{roleNames[profile.role]?.detail}</span></div></div><div className="profile-fields"><select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI Compatible</option></select><input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="模型名" />{form.provider === "openai-compatible" && <input className="base-url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="Base URL" />}<div className="key-input"><KeyRound size={15} /><input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={profile.hasApiKey ? "已保存，留空不修改" : "API Key"} /></div></div><div className="profile-controls"><label className="toggle"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /><span /></label><button className="button secondary compact" onClick={() => save.mutate()} disabled={save.isPending}><Check size={15} />保存</button></div>{save.error && <div className="error-banner compact">{save.error.message}</div>}</div>;
}

export function SettingsView() {
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/api/model-profiles") });
  return <section className="content-view settings-view"><header className="content-view-header"><div><span className="eyebrow">本地配置</span><h1>模型与凭据</h1><p>不同任务可以使用不同供应商。密钥只保存在本机数据目录。</p></div><div className="security-note"><ShieldCheck size={18} /><span>仅监听 localhost</span></div></header><div className="profile-list">{profiles.data?.map((profile) => <ProfileRow key={profile.role} profile={profile} />)}</div><section className="settings-note"><h2>配置建议</h2><p>规划模型适合较强的推理能力；正文模型需要稳定长输出；审校和记忆模型建议降低温度。OpenAI-compatible 接口需要填写完整 Base URL。</p></section></section>;
}
