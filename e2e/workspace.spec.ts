import { expect, test } from "@playwright/test";

test("desktop writing workflow remains usable end to end", async ({ page, request }) => {
  const title = `验收作品-${Date.now()}`;
  const created = await request.post("/api/projects", {
    data: {
      title,
      genre: "悬疑",
      premise: "旧城连续停电，刑警林彻发现每次停电都对应一段被删除的档案。",
      targetWords: 500000,
      pov: "第三人称限知",
      audience: "中文网文读者",
    },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json() as { id: string };
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

  try {
    await page.goto("/");
    await page.getByText(title).click();
    await expect(page.getByText("AI 协作")).toBeVisible();
    await expect(page.locator(".ProseMirror")).toBeVisible();

    await page.locator(".ProseMirror").fill("雨在凌晨两点落进旧城。\n\n林彻站在熄灭的档案馆门前，听见楼上传来纸张翻动的声音。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("已保存", { exact: true })).toBeVisible();
    await expect(page.getByText("35 字", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "场景规划" }).click();
    await page.getByLabel("场景名称").fill("进入档案馆");
    await page.getByLabel("场景摘要").fill("林彻进入断电后的档案馆，确认声音来自二楼。");
    await page.getByLabel("目标").fill("进入二楼");
    await page.getByLabel("冲突").fill("电子门禁失效，楼内仍有人活动");
    await page.getByLabel("结果").fill("发现一份被撕毁的值班表");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "写场景" }).click();
    await expect(page.getByText("当前场景")).toBeVisible();
    await expect(page.getByText("进入档案馆", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "故事圣经" }).click();
    await page.getByRole("button", { name: "新增人物" }).click();
    await page.getByLabel("名称").fill("林彻");
    await page.getByLabel("别名").fill("林队");
    await page.getByLabel("简述").fill("旧城刑警，左手有旧伤，不相信巧合。角色当前所在位置必须有章节证据。");
    await page.getByRole("button", { name: "保存设定" }).click();
    await expect(page.getByRole("heading", { name: "林彻" })).toBeVisible();

    await page.getByRole("button", { name: "记忆健康" }).click();
    await expect(page.getByRole("heading", { name: "记忆健康" })).toBeVisible();
    await page.getByRole("button", { name: "模型设置" }).click();
    await expect(page.getByText("规划模型", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "正文" }).click();
    await page.getByPlaceholder("搜索作品内容").fill("档案馆");
    await expect(page.locator(".search-results button")).toHaveCount(1);
    await page.locator(".search-results button").click();
    await page.getByPlaceholder("目标字数、场景重点、必须出现或避免的内容…").fill("续写林彻进入档案馆，保持悬疑节奏，不揭晓幕后人物。");
    await page.getByRole("button", { name: "检查上下文" }).click();
    await expect(page.locator(".context-summary").getByText(/[\d,]+ \/ 48,000 tokens/)).toBeVisible();
    await expect(page.getByText("林彻 · character")).toBeVisible();

    await page.locator(".ProseMirror p").first().selectText();
    await page.locator(".select-wrap select").selectOption("rewrite_selection");
    await expect(page.getByText(/已选 \d+ 个字符/)).toBeVisible();
    await page.getByRole("button", { name: "检查上下文" }).click();
    await expect(page.getByText("待改写选区（原文）")).toBeVisible();

    const panes = await page.locator(".left-sidebar, .primary-pane, .ai-panel").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }));
    for (const box of panes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(1440);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(900);
    }
    await page.screenshot({ path: "test-results/workspace.png", fullPage: true });

    const txt = await request.get(`/api/projects/${id}/export/txt`);
    expect(txt.ok()).toBeTruthy();
    expect(await txt.text()).toContain("雨在凌晨两点落进旧城");
    expect(consoleErrors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});

test("mobile drawers keep navigation and AI tools reachable", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `移动验收-${Date.now()}`;
  const created = await request.post("/api/projects", {
    data: { title, genre: "奇幻", premise: "学徒在旧钟楼发现时间裂隙。", targetWords: 200000, pov: "第三人称限知", audience: "中文网文读者" },
  });
  const { id } = await created.json() as { id: string };
  try {
    await page.goto("/");
    await page.getByText(title).click();
    await expect(page.locator(".ProseMirror")).toBeInViewport();

    await page.getByTitle("打开导航").click();
    await expect(page.locator(".left-sidebar")).toBeInViewport();
    await page.getByRole("button", { name: "故事圣经" }).click();
    await expect(page.getByRole("heading", { name: "故事圣经" })).toBeInViewport();

    await page.getByTitle("打开导航").click();
    await page.getByRole("button", { name: "正文", exact: true }).click();
    await page.getByTitle("打开 AI 协作").click();
    await expect(page.locator(".ai-panel")).toBeInViewport();
    await expect.poll(async () => {
      const box = await page.locator(".ai-panel").boundingBox();
      return box ? box.x + box.width : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(390);
    const aiBox = await page.locator(".ai-panel").boundingBox();
    expect(aiBox).not.toBeNull();
    expect(aiBox!.x).toBeGreaterThanOrEqual(0);
    expect(aiBox!.x + aiBox!.width).toBeLessThanOrEqual(390);
    expect(aiBox!.width).toBeGreaterThan(340);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: "test-results/workspace-mobile.png", fullPage: true });
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});
