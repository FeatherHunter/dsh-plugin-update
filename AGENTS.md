# AGENTS.md

Guidance for agents working in this repo.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `FeatherHunter/dsh-plugin-update`, read and written through the `deck_` tools. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` at the repo root, with architecture decisions in `docs/adr/`. See `docs/agents/domain.md`.

### Maintainer docs

`README.md` is the user manual for developers integrating this package — keep it that way: no in-repo process, tickets, or design rationale there.

Repo-side process (build, publish, publish whitelist, gates, change discipline) lives in `docs/maintainers.md`. Host install-exit contracts live in `docs/host-install-exits.md`.

### 架构导航

代码从哪进、电话/面板/日志怎么串、改日志事件要动哪三处、常见改动路线：见 `docs/agents/architecture.md`。改契约后的聚合验证是 `npm run check`；批量相关定向测试 `npm run test:batch`；端到端日志冒烟 `npm run smoke:log`；事件目录 `npm run docs:log`（`docs:log:check` 只查不写）。
