export interface StyleRuleFinding {
  severity: "low" | "medium" | "high";
  title: string;
  evidence: string;
  suggestion: string;
}

const cliches = [
  ["深吸一口气", "改用具体动作、停顿或环境反应表达压力"],
  ["嘴角微扬", "改成人物独有的细微动作或直接删去"],
  ["眼眶湿润", "用可观察的生理细节替代概括情绪"],
  ["心头一震", "写清触发物和身体反应，避免抽象震动"],
  ["心中一紧", "用呼吸、动作或判断变化承载紧张"],
  ["不由得", "让动作具有明确动机，通常可直接删除"],
  ["情不自禁", "直接写行为及其诱因"],
  ["仿佛置身", "改为当前视角能感知的具体细节"],
] as const;

function occurrences(content: string, phrase: string) {
  const positions: number[] = [];
  let from = 0;
  while (from < content.length) {
    const index = content.indexOf(phrase, from);
    if (index < 0) break;
    positions.push(index);
    from = index + phrase.length;
  }
  return positions;
}

function excerptAt(content: string, index: number, length: number) {
  return content.slice(Math.max(0, index - 18), Math.min(content.length, index + length + 18)).trim();
}

export function scanAiStyle(content: string): StyleRuleFinding[] {
  const findings: StyleRuleFinding[] = [];
  for (const [phrase, suggestion] of cliches) {
    const positions = occurrences(content, phrase);
    if (!positions.length) continue;
    findings.push({
      severity: positions.length >= 3 ? "high" : "medium",
      title: `程式化表达：${phrase}${positions.length > 1 ? `（${positions.length}处）` : ""}`,
      evidence: excerptAt(content, positions[0]!, phrase.length),
      suggestion,
    });
  }

  const sudden = occurrences(content, "突然");
  if (sudden.length >= 2) findings.push({
    severity: sudden.length >= 4 ? "high" : "medium",
    title: `转折词重复：突然（${sudden.length}处）`,
    evidence: excerptAt(content, sudden[0]!, 2),
    suggestion: "删去提示性转折词，让事件本身制造突发感。",
  });

  const ending = content.slice(-700);
  const uplift = ending.match(/(?:这一刻|直到此时|他终于).{0,36}(?:明白|懂得|意识到|清楚).{0,42}[。！？]?/s);
  if (uplift) findings.push({
    severity: "medium",
    title: "章末总结式升华",
    evidence: uplift[0].trim(),
    suggestion: "停在动作、选择或未解决的张力上，不替读者总结感受。",
  });

  const sentenceStarts = new Map<string, string[]>();
  for (const sentence of content.split(/[。！？\n]+/).map((part) => part.trim()).filter((part) => part.length >= 8)) {
    const start = sentence.slice(0, 4);
    const group = sentenceStarts.get(start) ?? [];
    group.push(sentence);
    sentenceStarts.set(start, group);
  }
  for (const [start, sentences] of sentenceStarts) {
    if (sentences.length < 3) continue;
    findings.push({
      severity: "low",
      title: `连续句式重复：${start}…`,
      evidence: sentences.slice(0, 3).join(" / ").slice(0, 180),
      suggestion: "调整主语出现位置，混合动作、感官和对话句，打破相同起句。",
    });
  }
  return findings.slice(0, 20);
}
