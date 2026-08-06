import { expect, test } from "@playwright/test";

test("modern workflow creates a project, workspace, draft, promotion and memory", async ({ page }) => {
  const title = `现代验收-${Date.now()}`;

  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();

  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "和主 Agent 讨论" })).toBeVisible();
  await expect(page.getByText("从一句话开始")).toBeVisible();
  await expect(page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…")).toBeVisible();

  await page.getByRole("button", { name: "项目资料", exact: true }).click();
  await page.getByRole("button", { name: "新建文件", exact: true }).click();
  await page.getByLabel("类型").selectOption("setting");
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("内容").fill("档案馆在城东，地下有旧井。");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.locator(".modern-preview-head").getByRole("heading", { name: title })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "转为正式", exact: true }).click();
  await page.getByRole("button", { name: "正式", exact: true }).click();
  await expect(page.locator(".modern-file-list").getByText(title, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "AI 记忆", exact: true }).click();
  await expect(page.locator(".modern-memory-list").getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByText("记忆正文")).toBeVisible();
});

test("modern library deletes a project after confirmation and clears its selection", async ({ page }) => {
  const title = `删除验收-${Date.now()}`;

  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "返回作品库" }).click();
  const card = page.locator(".modern-project-card").filter({ hasText: title });
  await card.getByRole("button", { name: `删除作品 ${title}` }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();

  await expect(page.locator(".modern-project-card").filter({ hasText: title })).toHaveCount(0);
  await expect(page.evaluate(() => localStorage.getItem("novel-studio:modern-project"))).resolves.toBeNull();
});

test("shows a non-chat configuration notice instead of an assistant setup message", async ({ page }) => {
  const title = `配置提示-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…").fill("请继续写作");
  await page.getByTitle("发送").click();

  await expect(page.locator(".modern-notice")).toContainText("模型配置");
  await expect(page.locator(".modern-message.agent")).toHaveCount(0);
  await expect(page.getByText("尚未配置规划模型")).toHaveCount(0);
  await page.getByRole("button", { name: "去配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型配置", level: 2 })).toBeVisible();
});

test("notice with an existing model config directs to Agent settings", async ({ page }) => {
  const title = `绑定提示-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();

  await page.getByRole("button", { name: "模型配置", exact: true }).click();
  await page.getByRole("button", { name: "新建配置", exact: true }).click();
  await page.getByLabel("配置名称").fill("已有模型");
  await page.getByLabel("模型 ID").fill("gpt-5");
  await page.getByLabel("API Key").fill("sk-test");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();

  await page.getByRole("button", { name: "主 Agent", exact: true }).click();
  await page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…").fill("请继续写作");
  await page.getByTitle("发送").click();
  await expect(page.locator(".modern-notice")).toContainText("Agent 设置");
  await page.getByRole("button", { name: "去绑定", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent 设置", level: 2 })).toBeVisible();
});

test("deletes the current session and selects a remaining session", async ({ page }) => {
  const title = `会话删除-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();

  await page.getByTitle("新建会话").click();
  await expect(page.locator(".modern-session-row")).toHaveCount(2);
  await page.getByRole("button", { name: "删除会话 新会话", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();

  await expect(page.locator(".modern-session-row")).toHaveCount(1);
  await expect(page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…")).toBeVisible();
});

test("agent settings persist a bound model configuration across reloads", async ({ page }) => {
  const title = `Agent绑定-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();

  await page.getByRole("button", { name: "模型配置", exact: true }).click();
  await page.getByRole("button", { name: "新建配置", exact: true }).click();
  await page.getByLabel("配置名称").fill("绑定模型");
  await page.getByLabel("模型 ID").fill("gpt-5");
  await page.getByLabel("API Key").fill("sk-test");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("绑定模型", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Agent 设置", exact: true }).click();
  const mainCard = page.locator(".modern-agent-card").first();
  const modelSelect = mainCard.getByLabel("使用的模型配置");
  await modelSelect.selectOption({ label: "绑定模型" });
  await mainCard.getByRole("button", { name: "保存", exact: true }).click();
  await expect(modelSelect.locator("option:checked")).toHaveText("绑定模型");

  await page.reload();
  await page.getByRole("button", { name: "Agent 设置", exact: true }).click();
  const reloadedSelect = page.locator(".modern-agent-card").first().getByLabel("使用的模型配置");
  await expect(reloadedSelect.locator("option:checked")).toHaveText("绑定模型");

  await page.getByRole("button", { name: "返回作品库" }).click();
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(`${title}-B`);
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.getByRole("button", { name: "Agent 设置", exact: true }).click();
  await expect(page.locator(".modern-agent-card").first().getByLabel("使用的模型配置").locator("option:checked")).toHaveText("未绑定");
});

test("optimistic send clears the composer, shows the user bubble and blocks duplicates until the response returns", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/modern/projects/*/sessions/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      await gate;
      await route.continue();
    } else {
      await route.continue();
    }
  });

  const title = `乐观发送-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();
  const composer = page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…");
  await composer.fill("测试消息");
  await page.getByTitle("发送").click();

  await expect(composer).toHaveValue("");
  await expect(page.locator(".modern-message.user")).toHaveCount(1);
  await expect(page.locator(".modern-message.user")).toContainText("测试消息");
  await expect(page.locator(".modern-processing")).toContainText("正在整理上下文并生成回复，请勿重复发送");
  await expect(composer).toBeDisabled();
  await expect(page.getByTitle("发送")).toBeDisabled();

  await page.getByTitle("新建会话").click();
  await expect(page.locator(".modern-session-row")).toHaveCount(2);
  await expect(page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…")).toBeEnabled();
  await expect(page.locator(".modern-processing")).toHaveCount(0);
  await page.locator(".modern-session-row", { hasText: "主 Agent" }).locator(".modern-session-open").click();
  await expect(page.locator(".modern-message.user")).toHaveCount(1);
  await expect(page.locator(".modern-processing")).toBeVisible();
  await expect(page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…")).toBeDisabled();

  release();
  await expect(page.locator(".modern-processing")).toHaveCount(0);
  await expect(page.locator(".modern-message.user")).toHaveCount(1);
  await expect(page.locator(".modern-message.user")).toContainText("测试消息");
});

test("failed send restores the draft, removes the optimistic bubble and shows a retryable error", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/modern/projects/*/sessions/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      await gate;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟发送失败" }) });
    } else {
      await route.continue();
    }
  });

  const title = `发送失败-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();
  const composer = page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…");
  await composer.fill("失败消息");
  await page.getByTitle("发送").click();

  await expect(composer).toHaveValue("");
  await expect(page.locator(".modern-message.user")).toHaveCount(1);
  await expect(page.locator(".modern-processing")).toBeVisible();

  release();
  await expect(page.locator(".modern-processing")).toHaveCount(0);
  await expect(composer).toHaveValue("失败消息");
  await expect(page.locator(".modern-message.user")).toHaveCount(0);
  await expect(page.locator(".modern-send-error")).toContainText("模拟发送失败");
});

test("failed send after persistence shows the structured server cause instead of response-lost wording", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/modern/projects/*/sessions/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      await gate;
      await route.fetch();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "响应丢失" }) });
    } else {
      await route.continue();
    }
  });

  const title = `已保存但失败-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();
  const composer = page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…");
  await composer.fill("已保存消息");
  await page.getByTitle("发送").click();

  await expect(composer).toHaveValue("");
  await expect(page.locator(".modern-message.user")).toHaveCount(1);
  await expect(page.locator(".modern-processing")).toBeVisible();

  release();
  await expect(page.locator(".modern-processing")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(page.locator(".modern-message.user")).toHaveCount(1);
  await expect(page.locator(".modern-message.user")).toContainText("已保存消息");
  await expect(page.locator(".modern-send-error")).toContainText("消息已保存，但发送失败");
  await expect(page.locator(".modern-send-error")).toContainText("响应丢失");
  await expect(page.locator(".modern-send-error")).not.toContainText("未收到回复");
});

test("response loss after persistence keeps the generic saved-message warning", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/modern/projects/*/sessions/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      await gate;
      await route.fetch();
      await route.abort("connectionrefused");
    } else {
      await route.continue();
    }
  });

  const title = `响应丢失-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();
  const composer = page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…");
  await composer.fill("丢失消息");
  await page.getByTitle("发送").click();

  await expect(composer).toHaveValue("");
  await expect(page.locator(".modern-message.user")).toHaveCount(1);
  await expect(page.locator(".modern-processing")).toBeVisible();

  release();
  await expect(page.locator(".modern-processing")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(page.locator(".modern-message.user")).toHaveCount(1);
  await expect(page.locator(".modern-send-error")).toContainText("消息已保存，但未收到回复");
});

test("first user message names a new session in the sidebar without reload", async ({ page }) => {
  const title = `自动命名-${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "新建作品" }).click();
  await page.getByLabel("作品名称").fill(title);
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.getByTitle("新建会话").click();
  await page.getByPlaceholder("告诉主 Agent 你想讨论、规划或修改什么…").fill("自动命名消息");
  await page.getByTitle("发送").click();
  await expect(page.locator(".modern-session-row", { hasText: "自动命名消息" })).toHaveCount(1);
});
