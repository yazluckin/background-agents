# Changelog

All notable changes to Open-Inspect are documented in this file.

This project uses [Semantic Versioning](https://semver.org/). Versions are tagged in the `public`
repository; the `prod` repo syncs tags on merge.

## [0.9.0] — 2026-04-13

### Added

- Daytona as alternative sandbox backend with direct REST API integration
- Automated Daytona snapshot builds via Terraform
- Browser-based web terminal (ttyd) in sandbox sessions
- Session cost display in web UI sidebar metadata
- D1 analytics columns with sync plumbing on terminal transitions
- Screenshot media pipeline with R2 streaming through worker
- Sandbox settings with configurable tunnel port support and per-row UI
- Analytics API routes
- Linear bot repo classifier with team context and richer metadata

### Fixed

- PR artifact hydration on subscribe and session branch kept live
- Session cost tracking type hardening
- Connecting timeout watchdog for sandboxes

---

## [0.8.0] — 2026-03-28

### Added

- **Trigger automations** — Sentry alert triggers and inbound webhook triggers with per-automation
  secrets (encrypted at rest)
- **GitLab provider** — PAT authentication, clone token support, provider-aware SCM URLs
- **Google OAuth** — alternative auth provider alongside GitHub OAuth
- **Slack DM support** — direct message handling in Slack bot
- Syntax highlighting with rehype-highlight and user-selectable code themes
- Light/dark mode theme respect for highlighting
- Agent-browser added to sandbox base image
- Full IANA timezone list for automation scheduling
- Reasoning effort controls on automations
- Linear bot `issueSessionInstructions` for custom session context
- Shared utility consolidation (logger, auth headers, agent response extractor, HMAC)

### Fixed

- Security hardening: input validation for external artifact URLs, snapshot store paths, query
  params, route params
- Structural isolation of untrusted content in prompts (GitHub comments, Linear fields, PR metadata)
- Sandbox-runtime extracted as independent package from modal-infra
- Image build `enabled` toggle respected at spawn time
- Git branch name normalization
- Cron expression validation blocking invalid automation submissions

---

## [0.7.0] — 2026-03-17

### Added

- **Code-server integration** — VS Code in browser with opt-in toggle, encrypted credentials, and
  settings UI
- **MCP server support** — settings UI and sandbox integration for custom MCP servers
- **shadcn/ui design system** — Radix primitives (Select, Switch, Input, Textarea, Checkbox, Button,
  Badge) adopted across UI
- **Global command palette** with keyboard shortcuts (`Cmd+K`)
- Session title rename from page header and sidebar overflow menu
- Session sidebar pagination for large session lists
- UserMenu dropdown replacing instant-logout avatar
- GitHub Enterprise Server support with configurable URLs

### Fixed

- PR token fallback — graceful degradation to App token when OAuth refresh fails
- Refresh token threading through session creation path
- Slack bot thread messages attributed to individual users
- Mobile session tap navigation
- Model hydration race condition with state-based guard

---

## [0.6.0] — 2026-03-06

### Added

- **Automation engine** — scheduled coding agent runs with cron expressions, IANA timezone support,
  and web UI for management
- GPT 5.4 added to supported model list
- Combobox scroll position and keyboard navigation stabilization

### Changed

- SessionDO modularized — extracted handlers for messages, sandbox, child sessions, pull requests,
  lifecycle, alarms, participants, WebSocket tokens, and internal route wiring into dedicated
  modules
- Unified internal endpoint contracts across SessionDO
- Git sync simplified with shared primitives and improved branch checkout across all sandbox boot
  paths

### Fixed

- GitHub webhook delivery deduplication
- Secrets propagation to prebuild step
- Inactivity timer reset on intermediate sandbox events
- Modal sandbox clone depth set to last 100 commits for fresh repos

---

## [0.5.0] — 2026-02-26

### Added

- **Pre-built image registry** — D1 schema, async Modal builder, image build scheduler cron, web
  settings UI for per-repo image management
- **Agent-spawned sub-sessions** — child session creation with event-driven status streaming through
  the bridge
- **Branch selection** — choose target branch at session creation, base and working branch displayed
  separately in session detail
- **Files Changed sidebar** — populated from tool call events with `apply_patch` support and diff
  stats
- **Cloudflare Workers** as alternative web app deployment platform
- **Microsoft Teams bot** — channel thread support (community contribution)
- Optional Slack bot and Linear bot Terraform deployments
- Session compaction handling in bridge message tracking
- `.env` block paste support in secrets editor
- Test coverage reporting across all packages
- Execution timeout alarm (defense-in-depth for stuck processing)

### Changed

- Terraform production root module split by concern
- Sandbox auth token storage and verification hardened
- SCM OAuth refresh tokens centralized in D1

### Fixed

- Terraform dependency cycle in control plane service bindings
- Fork PR comment posting (403 handling)

---

## [0.4.0] — 2026-02-19

### Added

- **GitHub bot** — automated PR reviews on open, comment-driven actions, customizable review and
  action prompts, caller gating, sandbox `gh` CLI support
- **Linear bot** — issue-to-session automation, multi-repo label-based routing, repo classification,
  activity callbacks
- **Microsoft Teams bot** — initial integration (community contribution)
- Claude Opus 4.6 with adaptive thinking support
- GPT 5.3 Codex Spark model
- OpenCode Zen models and global model enable/disable settings
- Integration settings redesigned into scalable provider detail flow
- Lean events v2 — deterministic event persistence
- Keyboard shortcuts with low-noise discoverability
- Repository search inputs in repo dropdowns
- **Mobile responsive layout** — sidebar overlay drawer, settings list/detail navigation, action bar
  overflow fix, iOS Safari viewport units
- SWR data fetching with caching and deduplication across web client
- Sidebar layout promoted to route group layout
- GitHub App installation token caching
- WebSocket event replay batched into single message
- Sidebar timestamp updates on WebSocket prompts

### Fixed

- Chat message horizontal scrolling
- Blank session page during WebSocket bootstrap
- Model selection dropdown overflow
- Secret decryption parallelized in stores

---

## [0.3.0] — 2026-02-10

### Added

- **Multi-provider model support** — reasoning effort controls (low / medium / high) across shared
  types, control plane bridge, web UI, and Slack bot
- **OpenAI models** — GPT 5.2, GPT 5.2 Codex, GPT 5.3 Codex
- Standardized `anthropic/` prefix on all model IDs with backward-compatible normalization
- LLM API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) configurable as repo secrets
- OpenAI OAuth `auth.json` written in sandbox entrypoint
- Centralized OpenAI Codex token refresh via control plane
- **Global secrets** — backend (D1 + store + API), web UI, merged into sandboxes at spawn time
- Mobile status dot replacing header indicators
- Developer setup script and pre-commit Python support
- Hover copy control for chat message markdown
- Eyes reaction lifecycle for Slack follow-up replies
- Disabled OpenCode question tool in headless sandbox

### Changed

- SourceControlProvider interface extracted for GitHub (foundation for multi-SCM)
- Integration tests added for control plane (workerd runtime) and WebSocket flows
- SessionWebSocketManager extracted from SessionDO
- Broadcasts scoped to subscribed/authenticated WebSocket clients
- Slack bot classifier requires structured output

### Fixed

- Manual PR fallback with Create PR button when auto-PR fails
- Abnormal WebSocket close handling for sandbox reconnection
- Base64url padding restored for JWT decoding
- Reasoning effort stored in D1 index at session creation
- Model selector synced with session model on page load
- Close sidebar on mobile after session selection

---

## [0.2.0] — 2026-02-03

### Added

- **Structured JSON logging** across control plane (wide events, correlation IDs), Modal
  infrastructure, and Slack bot
- **Repo-scoped secrets** — D1 storage with AES-256-GCM encryption, dedicated settings page, sandbox
  env injection at spawn time
- **D1 migration system** replacing single `schema.sql`
- **KV-to-D1 migration** for session index and repo metadata (standalone script)
- Dedicated settings page with secrets management
- Archived chats section in settings
- `.openinspect/setup.sh` repository setup script support
- Cloudflare Workers log retrieval script
- Debugging playbook for structured logging
- `jq` added to sandbox base image
- Slack bot channel name and description injected into agent prompt

### Fixed

- Bridge timeout hardening — inactivity-based SSE timeout replacing wall-clock timeout, progress
  watchdog, prompt task decoupling
- Sandbox restore `token_mismatch` race condition
- Supervisor no longer unconditionally restarts bridge
- Markdown text unreadable in dark mode and code blocks
- `create-pull-request` tool returns string instead of JSON object
- GitHub OAuth token refreshed for PR creation
- Execution errors displayed to users instead of false success
- Hidden archived sessions from sidebar
- Configurable timeout in `restore_from_snapshot`
- Session model included in frontend state

---

## [0.1.0] — 2026-01-20

### Added

- **Control Plane** — Cloudflare Workers with Durable Objects, SQLite-backed session state,
  WebSocket streaming, GitHub webhook signature verification
- **Data Plane** — Modal sandboxed environments running OpenCode with snapshot-based hibernation and
  restore
- **Web Client** — Next.js app with GitHub OAuth, real-time session streaming, collapsible sidebar
  with session list, markdown rendering, dark mode
- **Terraform IaC** — infrastructure-as-code for Cloudflare Workers, D1 database, and deployment
  automation
- **CI/CD** — GitHub Actions with automated Terraform apply and Vercel deployment on push to main
- **Slack bot** — repo classification, session creation, completion callback notifications
- WebSocket authentication for client connections with token-based handshake
- Per-message model switching and session persistence
- Model selection in session creation (Anthropic Claude, OpenCode free models)
- Collapsible tool call groups in session timeline
- PR creation with user attribution via GitHub App
- Sandbox lifecycle management with spawn deduplication and cooldown
- Control plane API authentication (HMAC)
- Repos endpoint authentication and normalized repo identifiers
- Pre-commit hooks for TypeScript (ESLint, Prettier) and Python (Ruff)
- Linting and formatting infrastructure across all packages
