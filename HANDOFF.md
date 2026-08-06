# Novel Studio WSL Handoff

- Branch: `wsl-handoff-2026-08-06`
- Commit: see `git log -1` on this branch (created by `chore: checkpoint WSL handoff`)
- Windows path: `C:\Users\Administrator\Documents\Codex\novel-studio`
- Original WSL path: `/home/waimoyu/projects/novel-studio`

## Implemented in this session

- Optimistic chat send UX with pending status, duplicate-send blocking, and rollback.
- Session-scoped optimistic message reconciliation and session deletion.
- Automatic session naming from the first user message.
- Structured model/provider error reporting and sanitized failures.
- Custom-base-URL OpenAI providers now use Chat Completions.
- System prompt blocks are normalized through the AI SDK top-level system option.
- Agent model binding persistence, model notices, and project/session deletion UI.

## Prerequisites

- Node.js 22+ (tested with 24.x)
- npm 11+
- Git for Windows
- Playwright Chromium browser (`npx playwright install chromium`)

## Exact PowerShell commands

```powershell
cd C:\Users\Administrator\Documents\Codex\novel-studio
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run dev
```

## Data and credentials

- SQLite snapshot: `data\novel-studio.sqlite`
- API credentials: `data\credentials.json` (local only, ignored by git, never commit)
- Default data directory is the repository `data` folder unless `NOVEL_STUDIO_DATA_DIR` is set.

## Intentionally excluded from the copy

- `node_modules/`
- `dist/`
- `.vite/`
- `*.tsbuildinfo`
- `.test-data/`
- `playwright-report/`
- `test-results/`

## First verification steps

1. `git status` shows the handoff branch and a clean worktree.
2. `git log -1` shows the handoff checkpoint commit.
3. `npm run typecheck` and `npm test` pass.
4. `npm run build` completes.
5. `npx playwright test` passes.
