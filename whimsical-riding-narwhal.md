# WSO2 Integrator Copilot — Auto Memory + Auto Dream: High-Level Architecture

> Design v5 — updated to match actual implementation: dual-directory storage (global + workspace), 6-type taxonomy, ANTHROPIC_SONNET_4 for both agents, 30-step dream cap, `releaseLock` + cache invalidation on dream completion, named 6-tool memory toolset, coalescing extraction state machine.

---

## Context & Goal

Claude Code ships a persistent memory system with two background agents:
- **Extract Memories** — captures important facts after every chat turn (reactive)
- **Auto Dream** — periodically consolidates and organizes those facts (proactive)

We want an **identical system** for the WSO2 Integrator Copilot VS Code extension, adapted to the WSO2 domain. The system gives the Copilot a persistent, self-organizing memory of the user, their integration projects, and their preferences — so users never have to re-explain themselves across sessions.

---

## Implementation Adaptations (WSO2 Codebase)

Key decisions where the actual implementation diverges from the original Claude Code design:

| Aspect | Original Design | WSO2 Implementation |
|--------|----------------|---------------------|
| Storage path | `~/.wso2/projects/{sanitized}/memory/` | `~/.ballerina/copilot/memory/global/` (cross-project) + `memory/{hash}/` (per-project) |
| Workspace identity | Sanitized path string | SHA-256 hash via `computeWorkspaceHash()` already in `copilot-utilities` |
| Dream activity gate | Count JSONL session files in `sessions/` dir | Count generation timestamps from existing `thread.json` files — no new files |
| Agent loop + tools | Custom `runForkedAgent` + reimplemented Read/Write/Edit | Vercel AI SDK `generateText` + reuse `createReadExecute`/`createWriteExecute`/`createEditExecute` from `text-editor.ts`, wrapped as 6 named tools in `memoryTools.ts` |
| Tool LS notifications | N/A | `sendAiSchemaDidOpen`/`sendAISchemaDidChange` are no-ops for `.md` files (early return in `ls-schema-notifications.ts`) — safe to reuse |
| Trigger point | `stopHooks.ts` after CLI query loop | `AgentExecutor.handleStreamFinish()` after agent completes |
| Implementation split | Single module | Utilities in `copilot-utilities/src/auto-memory/`, orchestration in `ballerina-extension/src/features/ai/memory/` |
| VS Code API in paths | `vscode.workspace.workspaceFolders` | Workspace hash passed as parameter — no VS Code dep in `copilot-utilities` |
| Feature flags | GrowthBook `tengu_*` | `COPILOT_DISABLE_AUTO_MEMORY` env var + `autoMemoryEnabled` in settings.json |
| Target scope | Both copilots | Ballerina AgentExecutor only (Phase 1). MI copilot is follow-up. |

### Module Split

**`copilot-utilities/src/auto-memory/`** — pure utilities, zero external npm dependencies (Node.js built-ins only):
```
memdir/paths.ts                  getMemoryDir(hash), getGlobalMemoryDir(), isInMemoryDir()
memdir/memoryTypes.ts            6-type taxonomy, GLOBAL_MEMORY_TYPES, WORKSPACE_MEMORY_TYPES
memdir/memoryScan.ts             scan .md files in both dirs, build dual manifest
memdir/memdir.ts                 loads both MEMORY.md files, builds combined system prompt
services/extractMemories/prompts.ts       extraction prompt with routing rules
services/autoDream/consolidationLock.ts   two lock files + generation count gate
services/autoDream/consolidationPrompt.ts 4-phase dream prompt covering both directories
index.ts
```

**`ballerina-extension/src/features/ai/memory/`** — agent orchestration (uses Vercel AI SDK):
```
extractMemories.ts    init + trigger + coalescing state machine
autoDream.ts          gate checks + dream agent loop
memoryTools.ts        6 named file tools (global_file_read/write/edit, workspace_file_read/write/edit)
```

---

## High-Level Component Map

```
ballerina-extension
│
├── activate.ts
│   └── initExtractMemories() + initAutoDream()    ← initialise both agents at startup
│
├── features/ai/agent/
│   ├── AgentExecutor.ts
│   │   └── handleStreamFinish()
│   │       ├── executeExtractMemories()            ← fires after every agent response
│   │       └── executeAutoDream()                  ← fires when gates pass
│   └── prompts.ts
│       └── loadMemoryPrompt()                      ← injects MEMORY.md into system prompt
│
└── features/ai/memory/                             ← orchestration layer (new)
    ├── extractMemories.ts                          ← init + trigger + coalescing
    ├── autoDream.ts                                ← gate checks + dream loop
    └── memoryTools.ts                              ← 6 named tools wrapping text-editor.ts execute fns

copilot-utilities/src/auto-memory/                  ← pure utilities (no VS Code dep)
│
├── memdir/
│   ├── paths.ts                                    ← path computation (hash-based)
│   ├── memoryTypes.ts                              ← 6-type taxonomy + prompt constants
│   ├── memoryScan.ts                               ← scan .md files, build manifest
│   └── memdir.ts                                   ← MEMORY.md loader, truncation, prompt builder
│
└── services/
    ├── extractMemories/prompts.ts                  ← extraction prompt builder
    └── autoDream/
        ├── consolidationLock.ts                    ← lock file + generation count gate
        └── consolidationPrompt.ts                  ← 4-phase consolidation prompt
```

---

## Memory Directory Structure

Two independent memory directories: **global** (cross-project) and **workspace** (project-specific). Both are injected into the system prompt at session start.

```
~/.ballerina/copilot/
├── workspaces/{hash}/                   ← existing chat persistence (unchanged)
│   ├── workspace.meta.json
│   └── threads/
│       └── {threadId}/
│           ├── thread.json              ← generation timestamps read here for dream gate
│           └── checkpoints/
└── memory/
    ├── global/                          ← NEW: cross-project memory (all workspaces share this)
    │   ├── MEMORY.md                    ← global index (≤200 lines, ≤25KB)
    │   ├── user_expertise.md            ← user type: engineer profile
    │   ├── codingstyle_error_handling.md ← codingstyle type: project coding conventions
    │   ├── history_salesforce_sap.md    ← history type: completed project knowledge
    │   └── .consolidate-lock           ← global dream lock (mtime = lastGlobalDreamAt)
    └── {hash}/                          ← workspace-specific memory (per project)
        ├── MEMORY.md                    ← workspace index (≤200 lines, ≤25KB)
        ├── integration_shopify.md       ← integration type: this project's systems
        ├── about_esb_migration.md       ← about type: project context & constraints
        ├── reference_monitoring.md      ← reference type: this project's dashboards
        └── .consolidate-lock           ← workspace dream lock (mtime = lastWorkspaceDreamAt)
```

### Why Two Directories

A developer who finishes Project A and starts Project B opens a new workspace folder — a new hash, an empty workspace memory. But they carry knowledge with them: who they are, how their team builds integrations, and what they built before. That knowledge lives in **global** memory and is always available regardless of which project is open.

### Type-to-Directory Assignment

Types are hardcoded to a directory — the LLM never decides:

| Type | Directory | Reasoning |
|------|-----------|-----------|
| `user` | global | Engineer profile doesn't change per project |
| `codingstyle` | workspace | Coding conventions specific to this project |
| `history` | global | Completed project knowledge persists across projects |
| `about` | workspace | Context, goals, deadlines, constraints for this project |
| `integration` | workspace | System quirks are specific to this project's connections |
| `project` | workspace | Active constraints and deadlines are project-specific |
| `reference` | workspace | Dashboards, JIRA projects are project-specific |

### Directory Design Decisions

- **Global directory** — `~/.ballerina/copilot/memory/global/` — one per user machine, shared across all workspace
- **Workspace directory** — `~/.ballerina/copilot/memory/{hash}/` — one per project, uses same `computeWorkspaceHash()` already in `copilot-utilities`
- **No `sessions/` directory** — dream activity gate reads generation timestamps from existing `thread.json` files
- **Each directory** has its own `MEMORY.md` (≤200 lines / 25KB) and `.consolidate-lock`
- **Topic files (`*.md`)** — one file per topic, AI-chosen names, frontmatter type field

### Topic File Format

```markdown
---
name: Salesforce→SAP order fulfillment integration
description: Completed 2025 — Salesforce→SAP via Ballerina, JWT auth, Kafka buffer, in production
type: history
---

Completed the Salesforce→SAP order fulfillment integration (MuleSoft→Ballerina migration).

Systems: Salesforce (JWT Bearer OAuth2) → Kafka buffer → SAP (RFC BAPI connector, pool of 5).

Key learnings:
- Salesforce JWT Bearer OAuth2 is reliable; auth code flow caused token refresh issues at scale
- SAP BAPI connector requires RFC auth; direct HTTP calls are not supported
- Kafka buffer was essential — direct SAP writes caused timeouts during peak order hours
- outbox pattern guaranteed no lost orders during SAP downtime windows

Status: In production as of 2026-01. Payment service and warehouse depend on it.
```

### MEMORY.md Index Format — Global

```markdown
- [Engineer background](user_expertise.md) — 10yr ESB veteran, migrating to Ballerina, prefers code
- [Error handling standard](codingstyle_error_handling.md) — retry 3× → dead-letter Kafka → Slack alert
- [Salesforce→SAP integration](history_salesforce_sap.md) — completed 2025, JWT auth, Kafka buffer, in prod
- [Shopify→QuickBooks sync](history_shopify_qbo.md) — completed 2024, GDPR-scoped, pass-through only
```

### MEMORY.md Index Format — Workspace

```markdown
- [Shopify webhook](integration_shopify.md) — fires twice per order, deduplicate on order_id
- [ESB to MI migration](about_esb_migration.md) — deadline 2026-08-01, flag ESB-only approaches
- [Monitoring dashboard](reference_monitoring.md) — Grafana at grafana.internal/d/integrations
```

---

## Memory Type Taxonomy (WSO2 Integration Engineering)

6 types across two scopes. Core principle: **only save what cannot be derived from the project files**.

| Type | Scope | What it holds |
|------|-------|--------------|
| `user` | **global** | Engineer profile, expertise, preferences |
| `codingstyle` | **workspace** | Coding conventions specific to this project |
| `history` | **global** | Completed integration projects and their learnings |
| `integration` | workspace | This project's connected systems and their quirks |
| `about` | workspace | Context, goals, deadlines, constraints for this project |
| `reference` | workspace | Links, dashboards, issue trackers for this project |

---

### Type 1: `user` — *global*
**What it contains:** Who the engineer is — their background, expertise level, and how they like the Copilot to work with them.

**Purpose:** So the Copilot doesn't explain things the user already knows, and doesn't skip things they don't. A 10-year WSO2 veteran and a developer writing their first Ballerina integration need completely different responses.

**When to capture:** User mentions their background, complains about explanation level, reveals a tool preference, or corrects how the Copilot is communicating.

```markdown
---
name: Engineer background
description: 10yr WSO2 ESB veteran migrating to Ballerina, prefers code over visual mapper
type: user
---

User has 10 years of WSO2 ESB experience and is migrating to Ballerina.
Frame Ballerina concepts using ESB analogues (e.g., Filter service ≈ CBR mediator).
Prefers code over the visual mapper. Does not need HTTP or protocol basics explained.
```

**More examples of what triggers a `user` memory:**
- *"I'm a Salesforce admin learning to build integrations — I'm not a developer"* → explain code concepts simply, use business terms
- *"Stop showing me XML config examples, I only use Ballerina code"* → never suggest XML mediators
- *"I always prefer reading the sequence diagram view"* → mention diagram view when relevant

---

### Type 2: `integration` — *workspace*
**What it contains:** Everything surprising, quirky, or non-obvious about the **external systems being connected** — things you'd write on a sticky note next to your monitor that you'd otherwise have to repeat every session.

**Purpose:** The Copilot can read your Ballerina code but cannot know how an external API actually behaves. Without this, you re-explain system quirks every session.

**When to capture:** User describes how a specific system authenticates, mentions a gotcha or limitation, explains a data format or naming convention, or describes the shape of data coming from an external system.

**Critical distinction from `reference`:** `integration` captures *how a system behaves*. `reference` captures *where to find things*. "The Shopify API paginates with cursors" is `integration`. "Shopify API docs are at X URL" is `reference`.

```markdown
---
name: Shopify order webhook behaviour
description: Shopify order webhooks fire twice per order — deduplicate on order_id
type: integration
---

The Shopify webhook for order events fires twice: once when the order is placed,
once when payment confirms. Always deduplicate on `order_id` before processing.

**How to apply:** Any Shopify → downstream integration must check for duplicate
order_id before writing to the destination system.
```

**More examples of what triggers an `integration` memory:**
- *"Our Salesforce connector uses JWT Bearer OAuth2, not the standard auth code flow"* → always suggest the right auth flow for Salesforce
- *"The inventory API returns HTTP 200 even on business errors — check `response.status` field"* → never rely on HTTP status code for this API
- *"The legacy ERP returns all dates as `DD/MM/YYYY HH:mm` strings, not ISO 8601"* → always add date parsing in any ERP integration
- *"Our Kafka topics follow the naming convention `{env}.{domain}.{entity}.v1`"* → use this convention when suggesting topic names
- *"The OneDrive API returns flat file metadata but Google Drive expects a nested `fileResource` object"* → always add the mapping layer in OneDrive→Drive integrations

---

### Type 3: `codingstyle` — *workspace*
**What it contains:** Architectural decisions and team standards for how integrations are built — the "we always do it this way" rules that apply across every integration in the project.

**Purpose:** So the Copilot never suggests an approach that works technically but violates how the team builds things. These are decisions made once so they don't get re-debated for every new integration.

**When to capture:** User corrects a suggested approach ("don't do it that way, we always use X"), confirms a pattern worked ("yes, always do it that way"), or explains a team convention. Record corrections AND confirmations.

```markdown
---
name: Standard error handling chain
description: All integrations use retry 3x → dead-letter Kafka topic → Slack alert
type: codingstyle
---

All integrations follow the same error handling chain:
retry 3× with exponential backoff (100ms base) →
dead-letter to `{env}.errors.{domain}` Kafka topic →
PagerDuty alert.

**Why:** Ops team SLA requires no silent failures. Established after a
production incident in Nov 2025 where errors were silently dropped.
**How to apply:** Every integration that calls an external system must
implement this chain. No exceptions.
```

**More examples of what triggers a `codingstyle` memory:**
- *"For file sync integrations, we always track processed files in a DB table — in-memory tracking doesn't survive restarts"* → always use DB-based idempotency for file sync
- *"We never hardcode API URLs — they always go in `Config.toml` as `configurable` variables"* → always use configurable variables, never hardcode
- *"Transformation logic over 20 lines always goes in its own `.bal` file under `transforms/`"* → extract long transforms to `transforms/` module
- *"All outbound HTTP calls must have a 30s timeout and circuit breaker — required after a cascade failure"* → always add timeout + circuit breaker to HTTP clients
- *"We buffer through Kafka before writing to Google Sheets — direct writes caused data loss during API outages"* → never write directly from source to Sheets

---

### Type 4: `about` — *workspace*
**What it contains:** What is actively being built *right now*, *why* it exists, and constraints that affect every suggestion. Time-sensitive — matters now, may be irrelevant in a few months.

**Purpose:** So the Copilot understands the business context behind requests. Knowing *why* something is being built changes what approach makes sense.

**Key rule:** Always convert relative dates to absolute. `"by Thursday"` → `"by 2026-04-10"`. Otherwise the memory is meaningless next week.

**When to capture:** User explains a deadline, describes what they're migrating from, mentions a business driver, flags a constraint like a freeze or compliance requirement.

```markdown
---
name: MuleSoft to Ballerina migration
description: Migrating Salesforce→SAP integration from MuleSoft to Ballerina, deadline 2026-07-01
type: about
---

Migrating the Salesforce → SAP order fulfillment integration from MuleSoft to Ballerina.
Hard deadline: 2026-07-01 (MuleSoft license expires).

**Why:** License cost and EOL — not a tech debt cleanup.
**How to apply:** Prioritise completeness over elegance. Flag any approach
that risks missing the deadline.
```

**More examples of what triggers an `about` memory:**
- *"We're in phase 2 of 3 of the GWS → M365 migration. Phase 1 (email) is done, now on calendar/contacts"* → don't suggest SharePoint-related work yet
- *"There's a Salesforce schema freeze until the audit finishes on 2026-06-15"* → flag any suggestions that require Salesforce schema changes
- *"This Stripe → QuickBooks sync must be GDPR compliant — no PII in the integration layer"* → always treat integration layer as pass-through, no PII storage
- *"No new APIs to the gateway until the security audit clears on 2026-05-15"* → flag API publishing suggestions until after that date

---

### Type 5: `reference` — *workspace*
**What it contains:** *Where to find things* — links, project keys, dashboard URLs, and pointers to external resources. Not what those things do (that belongs in `integration`) — just where they live.

**Purpose:** So when the Copilot says "check the monitoring dashboard" or "file a ticket," it knows exactly which one.

**When to capture:** User mentions a URL, JIRA project key, Confluence space, monitoring dashboard, internal tool, or any external system where work or documentation is tracked.

```markdown
---
name: Integration monitoring dashboard
description: Grafana at grafana.internal/d/integrations — watched by on-call
type: reference
---

Integration monitoring is at grafana.internal/d/integrations.
This is what the on-call team watches — check before touching any
request-path integration code.
```

**More examples of what triggers a `reference` memory:**
- *"Salesforce connector bugs go to JIRA `SFDC`, Google Workspace issues to `GWS`"* → use correct JIRA project per system
- *"We don't use the public Ballerina connector docs — we have an internal fork at `confluence.internal/ballerina-connectors`"* → always use internal docs
- *"The runbook for when the Stripe → QuickBooks sync fails is at `notion.so/team/stripe-qbo-runbook`"* → link to runbook when discussing that integration

---

### Type 6: `history` — *global*
**What it contains:** Completed integration projects — what was built, what systems were connected, the key architectural decisions made, and lessons learned. This is the institutional knowledge that survives after a project is done and the `about` memory fades.

**Purpose:** So when starting a new integration project, the Copilot already knows what the developer has built before and can apply those learnings. This is the answer to: *"I finished the Salesforce→SAP integration last year — the new copilot session knows nothing about it."*

**When to capture:** User describes a completed integration ("we shipped X last quarter"), references previous work ("like we did in the last project"), or mentions a system that's already in production from prior work. Auto-dream can also promote completed `project` memories to `history` when the project deadline passes.

**Key distinction from `project`:** `project` is for active work with deadlines and constraints — it fades when work ends. `history` is permanent — it captures what was built and why, for reference in all future sessions.

```markdown
---
name: Salesforce→SAP order fulfillment integration
description: Completed 2025 — Salesforce→SAP via Ballerina, JWT auth, Kafka buffer, in production
type: history
---

Completed the Salesforce→SAP order fulfillment integration (migrated from MuleSoft).
Live in production since 2026-01. Payment service and warehouse systems depend on it.

Systems: Salesforce → Kafka buffer → SAP BAPI (RFC connector, pool of 5).
Auth: Salesforce uses JWT Bearer OAuth2 (not auth code — caused token refresh issues at scale).

Key learnings carried forward:
- Always buffer through Kafka before writing to SAP — direct writes timeout under peak load
- SAP BAPI connector requires RFC auth; test the connection pool size under load
- outbox pattern is essential for guaranteed delivery during SAP maintenance windows
```

**More examples of what triggers a `history` memory:**
- *"We finished migrating OneDrive to Google Drive last month — it's all live now"* → save what was learned about both APIs, any quirks, patterns used
- *"The Shopify→QuickBooks sync we built in 2024 is still running"* → save that GDPR pass-through constraint and the deduplication approach
- *"We've integrated with this HR system before — same connector, different project"* → connect prior experience to current work

---

### How the 6 types work together — new project scenario

**Scenario:** Developer opens a brand new Ballerina project to build a Shopify → SAP integration.

The Copilot loads both memory directories:

**From global memory (carries over from past work):**

| Memory | What it contributes |
|--------|-------------------|
| `user` | 10yr ESB veteran, prefers code, don't explain HTTP basics |
| `codingstyle` | retry 3× → dead-letter Kafka → Slack alert; always buffer before SAP |
| `history` | Previously integrated SAP BAPI — RFC auth required, pool of 5, buffer mandatory |

**From workspace memory (empty on day 1, builds up fast):**

| Memory | What it contributes |
|--------|-------------------|
| `integration` | Shopify webhooks fire twice — deduplicate on order_id *(saved after first session)* |
| `about` | *(captured once developer explains what they're building)* |
| `reference` | *(captured once developer mentions dashboards and issue trackers)* |

On day 1: The Copilot already knows the developer's expertise, their error handling standard, and that SAP needs RFC auth and a Kafka buffer — without the developer saying a word about their history.

---

### What NOT to Save

| Don't save | Why |
|---|---|
| Ballerina sequences or integration XML in the repo | Copilot can read the files directly |
| Connector configs already in `Config.toml` | Derivable |
| `deployment.toml` topology | Derivable |
| Credentials, API keys, or secrets | Security risk — never save these |
| Stack traces and error logs | Ephemeral, useless next session |
| Payload examples from actual API calls | Ephemeral, potentially contains PII/PHI |
| Test data and mock payloads | Ephemeral |
| Anything already in `COPILOT.md` | Duplicate |
| "We used Filter mediator in xyz.bal" | Derivable by reading the file |

---

## The 3 LLM Calls Per Turn

Both agents make **separate, independent LLM calls** — completely invisible to the user.

```
User message
      ↓
LLM Call 1 — Main Copilot Agent      ← user sees this response
      ↓ (fire-and-forget)
LLM Call 2 — Extract Memories Agent  ← silent background call
      ↓ (only when gates pass)
LLM Call 3 — Auto Dream Agent        ← silent periodic call
```

---

## Extract Memories — Detailed Design

### Role
A **separate background `generateText` call** that runs after every Copilot response. The user never sees it. It has one job: read the recent conversation, decide if anything is worth remembering, write it to disk.

### Trigger
After every agent response via `AgentExecutor.handleStreamFinish()`. Fire-and-forget — user gets the response immediately, extraction runs in parallel.

### LLM Call Structure

```
model:          ANTHROPIC_SONNET_4 (claude-sonnet-4-6)
system prompt:  buildMemoryLines(globalDir, workspaceDir) — memory behavioral instructions
messages:       [user turn, assistant turn, extraction prompt as final user message]
tools:          6 named tools from memoryTools.ts (see Tool Set below)
max steps:      stopWhen: [stepCountIs(5)]
```

### Execution Flow

```
Agent response received
        ↓
handleStreamFinish() fires (fire-and-forget)
        ↓
Gate checks:
  - COPILOT_DISABLE_AUTO_MEMORY not set?
  - Not already extracting this turn?
  - Main agent didn't already write to memory dir this turn?
        ↓
generateText() call with memory tools
        ↓
Step 1 — READ (all in parallel)
  Read every memory file that might need updating
        ↓
Step 2 — WRITE (all in parallel)
  Create new files or update existing ones
  Update MEMORY.md index
        ↓
Done silently
```

### Tool Set (memoryTools.ts)

`memoryTools.ts` wraps `createReadExecute`/`createWriteExecute`/`createEditExecute` from `text-editor.ts`, instantiated once per memory directory. The LLM passes only short filenames (e.g. `user_expertise.md`); the execute function resolves them against the rooted directory.

| Tool | Directory | Permission |
|---|---|---|
| `global_file_read` | `memory/global/` | Read any file |
| `global_file_write` | `memory/global/` | Write new file (errors if file already has content) |
| `global_file_edit` | `memory/global/` | Exact-string replace; requires prior read |
| `workspace_file_read` | `memory/{hash}/` | Read any file |
| `workspace_file_write` | `memory/{hash}/` | Write new file |
| `workspace_file_edit` | `memory/{hash}/` | Exact-string replace; requires prior read |

Routing is enforced by the prompt (type field determines which tool set to use), not by path validation. `sendAiSchemaDidOpen`/`sendAISchemaDidChange` are no-ops for `.md` files — safe to reuse text-editor.ts execute functions unchanged.

### Coalescing State Machine

If an extraction is already in progress when the next turn arrives, the new context is stashed. Once the current extraction finishes, the trailing context runs immediately. Only one extraction runs at a time per workspace.

```
Turn arrives while extraction in progress?
    YES → stash as pendingCtx (latest wins — older context is dropped)
    NO  → run extraction immediately
```

### Closure-Scoped State
```typescript
const inFlight = new Set<Promise<void>>()  // for drainPendingExtraction at deactivation
let inProgress = false                      // prevents overlapping runs
let pendingCtx: ExtractionContext | undefined  // coalesced trailing context
const initialisedHashes = new Set<string>() // ensureMemoryDirsExist called once per workspace
```

### Exact Prompt Sent (Extract Memories)

Assembled from 4 parts and appended to conversation history:

**Part 1 — Opener (dynamic):**
```
You are now acting as the memory extraction subagent. Analyze the most recent ~{N} messages above and use them to update your persistent memory systems.

Available tools: file_read (unrestricted), file_write and file_edit for memory directories only. All other tools are not available.

You have TWO memory directories:
- Global memory: {globalMemoryDir}  ← for user, history types (applies to ALL projects)
- Workspace memory: {workspaceMemoryDir}  ← for integration, project, reference types (this project only)

ROUTING RULE — you must write each memory to the correct directory based on its type:
  user, history  →  global memory directory
  codingstyle, integration, about, reference  →  workspace memory directory

You have a limited step budget. The efficient strategy is: step 1 — read all files you might update in parallel; step 2 — write all updates in parallel. Do not interleave.

You MUST only use content from the last ~{N} messages. Do not investigate further.

## Global memory files (user/history types)

[user] user_expertise.md (2026-04-08): 10yr ESB veteran, new to Ballerina, prefers code over visual mapper
[codingstyle] codingstyle_error_handling.md (2026-04-06): retry 3× → dead-letter Kafka → Slack alert
[history] history_salesforce_sap.md (2026-03-01): completed Salesforce→SAP integration, JWT auth, Kafka buffer

## Workspace memory files (codingstyle/integration/about/reference types)

[integration] integration_shopify.md (2026-04-07): Shopify order webhooks fire twice — deduplicate on order_id
[project] project_esb_migration.md (2026-04-05): ESB→MI migration, deadline 2026-08-01

Check both lists before writing — update an existing file rather than creating a duplicate.
```

**Part 2 — Memory type taxonomy (sourced from `memoryTypes.ts` → `TYPES_SECTION`):**

This section is generated from the `TYPES_SECTION` constant in `memoryTypes.ts`. It contains the full 6-type WSO2 taxonomy (user, codingstyle, integration, about, reference, history) with descriptions, when_to_save, how_to_use, and examples as defined in File 2 of this document.

**Part 3 — What NOT to save (sourced from `memoryTypes.ts` → `WHAT_NOT_TO_SAVE_SECTION`):**

This section is generated from the `WHAT_NOT_TO_SAVE_SECTION` constant in `memoryTypes.ts`. See File 2 for the full list.

**Part 4 — How to save (from `prompts.ts` → `buildExtractPrompt()`):**
```
## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g., `user_expertise.md`, `integration_shopify.md`, `pattern_error_handling.md`) using this frontmatter format:

```markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{user, codingstyle, integration, about, reference, history}}
---

{{memory content — for codingstyle/about/history types include **Why:** and **How to apply:** lines}}
```

**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.

- `MEMORY.md` is always loaded into your system prompt — lines after 200 will be truncated, so keep the index concise
- Keep the name, description, and type fields in memory files up-to-date with the content
- Organize memory semantically by topic, not chronologically
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.
```

---

## Auto Dream — Detailed Design

### Role
A **separate periodic background `generateText` call** that consolidates and organizes everything Extract Memories has accumulated. Unlike Extract Memories, it does NOT run every turn — it runs when enough time and activity has accumulated.

### Trigger — 3 Gates (all must pass, cheapest first)

```
Gate 1 — Time Gate (one stat() call)
  Has it been ≥24 hours since the last dream?
  Read .consolidate-lock mtime to check
  NO → skip entirely
  YES → continue

Gate 2 — Scan Throttle
  Has it been ≥10 minutes since we last scanned?
  Prevents repeated scanning when time gate passes but activity hasn't
  NO → skip
  YES → continue

Gate 3 — Activity Gate (read existing thread.json files)
  Have ≥10 new generations been added since the last dream?
  Count generations with timestamp > lastDreamAt across all thread.json files
  No separate session files needed — reuses existing chat persistence data
  NO → skip, not enough material yet
  YES → FIRE
```

### LLM Call Structure

```
model:          ANTHROPIC_SONNET_4 (claude-sonnet-4-6)
system prompt:  buildMemoryLines(globalDir, workspaceDir) — same behavioral instructions as extraction
messages:       just the 4-phase consolidation prompt — no conversation history
tools:          same 6 named tools from memoryTools.ts (global + workspace read/write/edit)
max steps:      stopWhen: [stepCountIs(30)]
```

Note: Auto Dream does **not** share the main conversation history — it only needs the memory files. Sonnet 4 is used (same as extraction) because consolidation involves cross-file reasoning across multiple memory files, which is more demanding than single-turn extraction.

### Consolidation Lock

Each memory directory has its own independent lock file:

```
memory/global/.consolidate-lock   ← global dream lock
memory/{hash}/.consolidate-lock   ← workspace dream lock
```

Both lock files use the same mechanics:
```
Body: PID of the process currently dreaming
mtime: timestamp of last completed dream (this IS lastDreamAt)
Stale: after 60 minutes even if PID is alive (PID reuse guard)
```

The dream runs once per trigger and consolidates **both** directories in a single `generateText()` call. Both lock files are acquired before starting and stamped together on completion. If the global lock is held by another process (another workspace dreaming simultaneously), the workspace lock is acquired anyway and the dream runs — but skips the global consolidation, doing only the workspace portion.

**Acquire order:**
```
1. Acquire workspace lock (required — abort if held)
2. Try to acquire global lock (optional — skip global consolidation if held)
3. Run dream (consolidate workspace always, consolidate global if lock acquired)
4. On success: releaseLock() on both — writes empty body, advances mtime to completion time
   Then: invalidateMemoryPromptCache(workspaceHash) — busts 5s TTL so next turn reads fresh files
5. On failure: rollbackLock() on both — restores prior mtime so time gate can pass again
```

**Why `releaseLock` instead of just leaving the file stamped:**
After a successful dream the lock file body still contains the extension host's PID. On the next dream attempt, `tryAcquireLock` sees a recent mtime + live PID and blocks — the same process is always alive between dreams. `releaseLock` clears the body (writes empty string), so the next `tryAcquireLock` finds no live holder and can proceed. The mtime still advances to "now" (the completion time), which serves as `lastConsolidatedAt`.

### 4-Phase Dream Prompt (exact)

```
# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize
what you've learned recently into durable, well-organized memories so that future
sessions can orient quickly.

You are consolidating TWO memory directories:
- Global memory: `~/.ballerina/copilot/memory/global/`  (user, history types)
- Workspace memory: `~/.ballerina/copilot/memory/{hash}/`  (integration, project, reference types)

Both directories already exist — write directly with file_write.

ROUTING RULE: user/history types → global directory. codingstyle/integration/about/reference types → workspace directory.

---

## Phase 1 — Orient (both directories)
- Read global `MEMORY.md` and workspace `MEMORY.md`
- Skim existing topic files in both directories

## Phase 2 — Gather recent signal
Sources in priority order:
1. Existing memories that drifted — facts that contradict current project state
2. Completed project work that should be promoted: if an `about` memory has a deadline that has passed and the work is done, distill its key learnings into a `history` memory in the global directory

## Phase 3 — Consolidate
- Merge new signal into existing topic files
- Convert relative dates to absolute dates
- Delete contradicted facts
- **Promote completed projects**: if a workspace `project` memory describes work that is now done, extract the durable learnings (systems connected, key patterns, gotchas) into a new `history` memory in the global directory

## Phase 4 — Prune and index (both directories)
Update both `MEMORY.md` files (each ≤200 lines, ≤25KB).
- Remove stale or superseded pointers
- Demote verbose entries to topic files
- Add pointers to newly important memories

---

Return a brief summary of what you consolidated, promoted to history, or pruned.
If nothing changed, say so.

## Additional context
New generations since last workspace consolidation: {N} (since {lastWorkspaceDreamAt})
Last global consolidation: {lastGlobalDreamAt}
```

### UI Visibility
```
Status bar: $(sync~spin) Copilot Dreaming...    ← while running
Status bar: $(check) Memory updated             ← on completion (disappears after 5s)
(hidden)                                        ← on failure
```

**Status bar race fix:** The 5-second hide `setTimeout` handle from a completed dream is stored as `dreamHideTimeout`. `onDreamStart` calls `clearTimeout(dreamHideTimeout)` before showing the spinner — prevents the timer from a previous dream firing mid-dream and hiding a live spinning indicator. `onDreamFail` also clears the timer.

---

## System Prompt Injection (Session Start)

At session start, `loadMemoryPrompt(workspaceHash)` builds the system prompt section from **both** memory directories. This is how past memories — including from previous projects — influence current conversations.

**What gets injected:**
1. Memory behavioral instructions (when/how to save, type routing rules, drift caveat)
2. Contents of global `MEMORY.md` (truncated to 200 lines / 25KB) — labeled "Global Memory (applies to all your projects)"
3. Contents of workspace `MEMORY.md` (truncated to 200 lines / 25KB) — labeled "Workspace Memory (this project)"

**5-second TTL cache:** `loadMemoryPrompt` caches results per workspace hash for 5 seconds (`PROMPT_CACHE_TTL_MS = 5_000`) to avoid repeated `readFileSync` calls on every streaming chunk during multi-turn conversations. The short TTL ensures newly saved memories surface within one turn cycle. `invalidateMemoryPromptCache(workspaceHash)` is called explicitly after a successful dream, bypassing the TTL so the next turn immediately picks up consolidated memories.

**Injected structure:**
```
# auto memory

You have a persistent memory system with two scopes...

## Global Memory (applies to all your projects)

- [Engineer background](user_expertise.md) — 10yr ESB veteran, prefers code
- [Error handling standard](pattern_error_handling.md) — retry 3× → dead-letter Kafka → Slack
- [Salesforce→SAP integration](history_salesforce_sap.md) — completed 2025, JWT auth, Kafka buffer

## Workspace Memory (this project)

- [Shopify webhook](integration_shopify.md) — fires twice per order, deduplicate on order_id
- [ESB migration](project_esb_migration.md) — deadline 2026-08-01
```

**The drift caveat** — always included in system prompt:
```
Memory records can become stale over time. Use memory as context for what was
true at a given point in time. Before answering or building assumptions based
solely on information in memory records, verify that the memory is still
correct and up-to-date by reading the current state of the files or resources.
If a recalled memory conflicts with current information, trust what you observe
now — and update or remove the stale memory rather than acting on it.
```

**The trust caveat** — also included:
```
## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it
existed when the memory was written. It may have been renamed, removed, or
never merged. Before recommending it:
- If the memory names a file path: check the file exists
- If the memory names a function or flag: grep for it
- "The memory says X exists" is not the same as "X exists now."
```

---

## Extract Memories vs Auto Dream — Full Comparison

| Aspect | Extract Memories | Auto Dream |
|---|---|---|
| What it is | Separate background LLM call | Separate background LLM call |
| Model | `ANTHROPIC_SONNET_4` | `ANTHROPIC_SONNET_4` |
| Frequency | After every agent response | After 24h AND 10+ new generations |
| Input | Current user + assistant turn text | Memory files + generation count from thread.json |
| Output | New/updated topic files + both MEMORY.md files | Reorganized + pruned everything in both dirs |
| Shares conversation history | No — only current turn passed as messages | No — standalone call |
| Visible to user | No | Yes — `$(sync~spin)` spinner + `$(check)` completion |
| Blocks response | No (fire-and-forget) | No |
| Tools | 6 named tools from `memoryTools.ts` | Same 6 named tools |
| Max steps | `stepCountIs(5)` | `stepCountIs(30)` |
| Concurrency guard | Coalescing (stash as `pendingCtx`, run as trailing) | Lock file with PID body + mtime as `lastDreamAt` |
| On completion | — | `releaseLock()` + `invalidateMemoryPromptCache()` |
| Analogy | Note-taker | Librarian |

---

## Component Details

### 1. `copilot-utilities/src/auto-memory/memdir/`

**`paths.ts`**
- `getMemoryDir(workspaceHash)` → `~/.ballerina/copilot/memory/{hash}/`
- `getGlobalMemoryDir()` → `~/.ballerina/copilot/memory/global/`
- `isAutoMemoryEnabled()` — checks `COPILOT_DISABLE_AUTO_MEMORY` env var; default enabled
- `isInMemoryDir(absolutePath, workspaceHash)` — path is within workspace OR global memory dir

**`memoryScan.ts`**
- `scanMemoryFiles(memoryDir): MemoryHeader[]` — synchronous; reads `.md` frontmatter, sorted newest-first (max 200); excludes MEMORY.md and hidden files; handles CRLF line endings in frontmatter regex
- `formatMemoryManifest(globalFiles, workspaceFiles)` — formats two sections with headers "Global memory files" and "Workspace memory files" — pre-injected into extraction prompt

**`memdir.ts`**
- `loadMemoryPrompt(workspaceHash)` — reads both MEMORY.md files, truncates each to 200 lines / 25KB, builds combined prompt; **5s TTL cache** per workspace hash to avoid repeated `readFileSync` per streaming chunk
- `invalidateMemoryPromptCache(workspaceHash)` — busts the TTL cache for a workspace; called after successful dream
- `buildMemoryLines(globalDir, workspaceDir)` — behavioral instructions including type routing rules and two-directory layout explanation
- `truncateEntrypointContent()` — enforces line AND byte caps; byte truncation uses `Buffer.subarray(0, 25_000).toString('utf-8')` to correctly handle multibyte chars at the boundary

**`services/autoDream/consolidationLock.ts`**
- `tryAcquireLock(lockPath)` — writes PID body; returns `priorMtime` (0 if new) or `null` if blocked; cleans up orphaned lock on read-back failure
- `releaseLock(lockPath)` — writes empty body (clears PID, advances mtime to completion time = `lastConsolidatedAt`)
- `rollbackLock(lockPath, priorMtime)` — restores prior mtime on failure; unlinks if priorMtime was 0
- `readLastConsolidatedAt(lockPath)` — returns lock file mtime (0 if missing)
- `countGenerationsSince(workspacesBaseDir, workspaceHash, sinceMs)` — walks `threads/{id}/thread.json` files synchronously, counts generations with `timestamp > sinceMs`

### 2. `ballerina-extension/src/features/ai/memory/memoryTools.ts`

Creates 6 named tools passed to both extraction and dream agents. Wraps the existing execute functions from `text-editor.ts` with two directory roots:

| Tool | Root |
|---|---|
| `global_file_read` / `global_file_write` / `global_file_edit` | `memory/global/` |
| `workspace_file_read` / `workspace_file_write` / `workspace_file_edit` | `memory/{hash}/` |

The LLM passes filenames relative to the directory root (e.g. `user_expertise.md`). The execute function resolves them. `sendAiSchemaDidOpen`/`sendAISchemaDidChange` are no-ops for `.md` files — verified at `ls-schema-notifications.ts` lines 82/140.

---

### 3. Integration Points in `ballerina-extension`

| Claude Code | WSO2 Ballerina Copilot |
|---|---|
| `stopHooks.ts` — fires after query loop | `AgentExecutor.handleStreamFinish()` |
| Forked agent via `runForkedAgent()` | `generateText()` from Vercel AI SDK v6 |
| Custom Read/Write/Edit tool implementations | `createReadExecute`/`createWriteExecute`/`createEditExecute` from `text-editor.ts`, wrapped as 6 named tools in `memoryTools.ts` |
| Process-level PID in lock file | Extension host process PID (same process — requires `releaseLock` after success) |
| JSONL session transcripts for dream gate | Generation timestamps from existing `thread.json` files |
| Single memory directory | Two directories: `memory/global/` + `memory/{hash}/` |
| Single MEMORY.md | Two MEMORY.md files — one global, one per workspace |

---

## End-to-End Data Flow

```
First Session on a New Project
  → loadMemoryPrompt(workspaceHash) reads global MEMORY.md + workspace MEMORY.md
  → global is pre-populated (user profile, patterns, history from past projects)
  → workspace MEMORY.md is empty on day 1
  → Copilot already knows who the developer is and what they've built before

Each Agent Response
  → User sends message, Copilot responds (generateText call 1)
  → AgentExecutor.handleStreamFinish() fires
  → executeExtractMemories() runs fire-and-forget (generateText call 2)
  → global types (user/history) → written to memory/global/
  → workspace types (integration/project/reference) → written to memory/{hash}/

After 24h + 10 new generations
  → executeAutoDream() gates pass
  → Dream runs fire-and-forget (generateText call 3)
  → Consolidates BOTH directories
  → Promotes completed project memories to history in global directory
  → Both MEMORY.md files updated, both .consolidate-lock mtimes stamped

Next Project (new workspace folder)
  → loadMemoryPrompt(newHash) reads global MEMORY.md (full history) + new empty workspace
  → Copilot immediately knows user profile, team patterns, and all prior project history
  → Workspace memory builds up as the new project progresses
```

---

## Configuration

Environment overrides (checked in `copilot-utilities/src/auto-memory/memdir/paths.ts`):
- `COPILOT_DISABLE_AUTO_MEMORY=1` — kill switch for all memory features (CI/automated runs)

Settings (checked in `ballerina-extension`, passed into auto-memory module):
```json
{
  "autoMemoryEnabled": true,
  "autoDreamEnabled": true
}
```

Memory is stored in two fixed directories — `~/.ballerina/copilot/memory/global/` and `~/.ballerina/copilot/memory/{workspaceHash}/`. Neither path is user-configurable. The workspace hash is derived from the existing `computeWorkspaceHash()` in `CopilotPersistenceStore`.

---

## Key Design Decisions

1. **Vercel AI SDK `generateText`** — uses the same SDK as the main agent, no new API client needed. The existing `getAnthropicClient()` is reused directly.
2. **Reuse `text-editor.ts` execute functions** — `createReadExecute`/`createWriteExecute`/`createEditExecute` work for `.md` files unchanged. Language Server notifications (`sendAiSchemaDidOpen`, `sendAISchemaDidChange`) are no-ops for non-`.bal` files — verified in `ls-schema-notifications.ts`. Wrapped in `tool()` as 6 named tools in `memoryTools.ts`.
3. **Named tools enforce routing** — `global_file_write` vs `workspace_file_write` structurally encodes the type routing rule. The LLM picks the tool whose name matches the memory scope, never a full path.
4. **Co-located storage with hash-based identity** — `~/.ballerina/copilot/memory/{hash}/` uses the same `computeWorkspaceHash()` already in `copilot-utilities`. No new hash logic or sanitization needed.
5. **No sessions directory** — Auto Dream activity gate reads generation timestamps from existing `thread.json` files. No new files written anywhere.
6. **Module split: utilities vs orchestration** — `copilot-utilities/src/auto-memory/` has zero external npm dependencies (Node.js built-ins only). Vercel AI SDK calls live in `ballerina-extension/src/features/ai/memory/`.
7. **`ANTHROPIC_SONNET_4` for both agents** — extraction uses Sonnet 4 for reliable memory routing decisions; dream uses Sonnet 4 because cross-file consolidation requires more complex reasoning than a single turn.
8. **Fire-and-forget** — extraction and dream never block the agent response.
9. **Lock file dual purpose** — `mtime` of `.consolidate-lock` IS `lastDreamAt`; body contains the holder PID. `releaseLock()` clears the body (prevents self-blocking between dreams) while `writeFileSync` naturally advances mtime to completion time. `rollbackLock()` restores prior mtime on failure.
10. **`invalidateMemoryPromptCache` after dream** — `loadMemoryPrompt` caches results for 5 seconds. After a successful dream, cache is explicitly invalidated so the next turn reads the consolidated files regardless of TTL.
11. **Status bar race prevention** — the 5-second hide timer handle from `onDreamComplete` is stored as `dreamHideTimeout` and cleared in `onDreamStart`, preventing a previous timer from hiding a live spinner.
12. **6-type taxonomy with two scopes** — global types (`user`, `history`) persist across all workspaces; workspace types (`codingstyle`, `integration`, `about`, `reference`) are project-specific. `history` is new — captures completed project institutional knowledge so it survives when a developer moves to a new project.
13. **Cross-project continuity** — global memory directory (`memory/global/`) is shared by all workspaces. A developer starting a new project immediately has their user profile, team standards, and all past project learnings available without re-explaining anything.

---

## What's NOT in This Design (Out of Scope for v1)

- Team memory sharing (private only — no shared directory)
- KAIROS/daily-log mode (daily append-only logs)
- Manual `/dream` command (can be added in v2)
- Memory UI panel in VS Code sidebar

---

## Verification Plan

1. **Global routing**: Say "I prefer Ballerina over XML" (user type). Confirm file written to `~/.ballerina/copilot/memory/global/` NOT `memory/{hash}/`.
2. **Workspace routing**: Say "The Shopify webhook fires twice" (integration type). Confirm file written to `memory/{hash}/`.
3. **Cross-project continuity**: Open a brand new workspace folder (new hash). Confirm system prompt contains the global memories (user, history) from previous work even though workspace memory is empty.
4. **System prompt structure**: Confirm injected prompt has both "Global Memory" and "Workspace Memory" labeled sections.
5. **History promotion**: Add a project memory with a past deadline, run auto-dream. Confirm completed project is distilled into `history_*.md` in `global/` directory.
6. **Mutual exclusion**: Have the main agent write a memory file, confirm extraction skips that turn.
7. **Disable flag**: Set `COPILOT_DISABLE_AUTO_MEMORY=1`, confirm no files written to either directory.
8. **Truncation**: Create a global `MEMORY.md` with 210 lines, confirm system prompt receives only 200 lines with warning.
9. **Global lock contention**: Simulate two workspaces dreaming simultaneously. Confirm second dream skips global consolidation but still consolidates its own workspace.
10. **Lock rollback**: Kill dream mid-run, confirm both `.consolidate-lock` mtimes rewind.

---

---

# Actual Implementation Files

> The code below documents the actual implementation as shipped. For full source, read the files directly.

## `copilot-utilities/src/auto-memory/`

| File | Exports |
|---|---|
| `memdir/paths.ts` | `getMemoryDir`, `getGlobalMemoryDir`, `isAutoMemoryEnabled`, `isInMemoryDir` |
| `memdir/memoryTypes.ts` | `MEMORY_TYPES`, `GLOBAL_MEMORY_TYPES`, `WORKSPACE_MEMORY_TYPES`, `isGlobalMemoryType`, `parseMemoryType`, prompt text constants |
| `memdir/memoryScan.ts` | `scanMemoryFiles(dir): MemoryHeader[]`, `formatMemoryManifest(globalFiles, workspaceFiles): string` |
| `memdir/memdir.ts` | `loadMemoryPrompt(workspaceHash)`, `invalidateMemoryPromptCache(workspaceHash)`, `buildMemoryLines(globalDir, workspaceDir)`, `truncateEntrypointContent(raw)`, `ensureMemoryDirsExist(workspaceHash)` |
| `services/extractMemories/prompts.ts` | `buildExtractPrompt({ globalMemoryDir, workspaceMemoryDir, newMessageCount, existingMemoriesManifest })` |
| `services/autoDream/consolidationLock.ts` | `getLockPath`, `readLastConsolidatedAt`, `tryAcquireLock`, `releaseLock`, `rollbackLock`, `countGenerationsSince` |
| `services/autoDream/consolidationPrompt.ts` | `buildConsolidationPrompt(globalDir, workspaceDir, ctx: ConsolidationContext)` |
| `index.ts` | Re-exports all of the above |

## `ballerina-extension/src/features/ai/memory/`

| File | Exports |
|---|---|
| `memoryTools.ts` | `createMemoryTools(globalDir, workspaceDir): MemoryToolSet` — 6 named tools |
| `extractMemories.ts` | `initExtractMemories()`, `executeExtractMemories(ctx)`, `drainPendingExtraction(timeoutMs?)`, `setMemorySettingsProvider(provider)` |
| `autoDream.ts` | `initAutoDream()`, `executeAutoDream(ctx)`, `setDreamCallbacks(callbacks)`, `setDreamSettingsProvider(provider)` |

## `ballerina-extension/src/features/ai/agent/`

| File | Change |
|---|---|
| `prompts.ts` | Added `getSystemPromptWithMemory(projects, op, workspacePath)` — wraps base system prompt with `loadMemoryPrompt` |
| `AgentExecutor.ts` | `handleStreamFinish()` calls `executeExtractMemories` + `executeAutoDream` fire-and-forget; all `threadId` reads use `this.config.chatStorage?.threadId ?? 'default'` |
| `index.ts` | `createExecutorConfig` reads active thread ID from `chatStateStorage.getActiveThread(projectRootPath)?.id` |

## `ballerina-extension/src/views/ai-panel/activate.ts`

Wires all memory agents at extension activation:
```typescript
setMemorySettingsProvider(() => ({
    autoMemoryEnabled: vscode.workspace.getConfiguration('ballerina.ai.autoMemory').get<boolean>('enabled', true),
}));
setDreamSettingsProvider(() => ({
    autoDreamEnabled: vscode.workspace.getConfiguration('ballerina.ai.autoDream').get<boolean>('enabled', true),
}));

let dreamHideTimeout: ReturnType<typeof setTimeout> | undefined;
setDreamCallbacks({
    onDreamStart:    () => { clearTimeout(dreamHideTimeout); dreamStatusBar.text = '$(sync~spin) Copilot Dreaming...'; dreamStatusBar.show(); },
    onDreamComplete: () => { dreamStatusBar.text = '$(check) Memory updated'; dreamStatusBar.show(); dreamHideTimeout = setTimeout(() => dreamStatusBar.hide(), 5_000); },
    onDreamFail:     () => { clearTimeout(dreamHideTimeout); dreamStatusBar.hide(); },
});
initExtractMemories();
initAutoDream();
```

## VS Code Settings (ballerina-extension/package.json)

```json
"ballerina.ai.autoMemory.enabled": true   // gates Extract Memories
"ballerina.ai.autoDream.enabled":  true   // gates Auto Dream
```

Kill switch (no VS Code required): `COPILOT_DISABLE_AUTO_MEMORY=1`

## Unit Tests

`copilot-utilities/src/auto-memory/__tests__/auto-memory.test.ts` — 25 tests across 7 suites using `node:test`:
- `truncateEntrypointContent` (4 tests)
- `scanMemoryFiles` (6 tests)
- `formatMemoryManifest` (3 tests)
- `tryAcquireLock` (3 tests)
- `rollbackLock` (2 tests)
- `readLastConsolidatedAt` (2 tests)
- `countGenerationsSince` (5 tests)

Run compiled tests: `node --test lib/auto-memory/__tests__/auto-memory.test.js`

---
