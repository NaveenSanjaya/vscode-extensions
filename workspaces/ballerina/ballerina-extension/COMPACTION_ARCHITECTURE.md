# Compaction Feature Architecture Design

**Document Type:** Architecture Design Document
**Status:** Draft
**Scope:** Context Window Management via Native Compaction for Ballerina Copilot Agent

---

## Overview / Executive Summary

The Ballerina Copilot uses Claude's native `compact_20260112` API feature to manage the 200k-token context window. When conversation history accumulates to ~60,000 input tokens, a server-side summarization replaces historical messages with a structured summary block — allowing the conversation to continue without losing critical context.

**Current state:** The feature works end-to-end but has gaps in reliability, user control, observability, and quality assurance. This document analyzes the current system, identifies all failure modes, and proposes a hardened architecture.

---

## Current State Analysis

### Architecture Overview

```
User Message
    ↓
AgentExecutor.streamText()
    │  contextManagement: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 60000 } }] }
    ↓
Anthropic API (streams response)
    │  ← detects input_tokens ≥ trigger
    │  ← generates compaction summary
    ↓
Stream Parts (text-start type='compaction', text-delta, finish)
    ↓
AgentExecutor event handlers
    │  emits: compaction_start / compaction_delta / compaction_end
    ↓
Frontend (AIChat)
    │  segment parsing: <compaction>...</compaction>
    ↓
CompactionSegment UI (streaming reveal → auto-collapse after 1.5s)
    ↓
ContextUsageIndicator (ring updates from usage_metrics events)
```

### Component Inventory

| Component | File | Responsibility |
|-----------|------|----------------|
| `AgentExecutor` | `src/features/ai/agent/AgentExecutor.ts` | Orchestrates streaming, emits compaction events |
| `native.ts` | `src/features/ai/agent/compact/native.ts` | Builds `contextManagement` config, validates trigger |
| `prompt.ts` | `src/features/ai/agent/compact/prompt.ts` | `COMPACTION_PROMPT` — instructions for summarization quality |
| `constants.ts` | `src/features/ai/agent/constants.ts` | `NATIVE_COMPACTION_TRIGGER=60000`, `CLAUDE_CONTEXT_WINDOW=200000` |
| `ChatStateStorage` | `src/views/ai-panel/chatStateStorage.ts` | Persists threads, generations, token counts |
| `rpc-manager.ts` | `src/rpc-managers/ai-panel/rpc-manager.ts` | `getContextUsage()` — calculates `willAutoCompact` flag |
| `CompactionSegment` | `ballerina-visualizer/.../CompactionSegment.tsx` | Renders streaming summary with animation |
| `ContextUsageIndicator` | `ballerina-visualizer/.../ContextUsageIndicator/` | Ring + tooltip showing token usage and warning |
| `useContextUsage` | `ballerina-visualizer/.../useContextUsage.ts` | Hook: polls RPC + live updates from stream events |
| `segment.ts` | `ballerina-visualizer/.../AIChat/segment.ts` | Parses `<compaction>` XML tags in streamed content |

### Strengths

- **API-native compaction:** No custom LLM prompt needed for triggering; Anthropic handles compression transparently
- **Rich preservation prompt:** `COMPACTION_PROMPT` explicitly preserves user messages verbatim, code snippets verbatim, file paths, errors, decisions
- **Live streaming UI:** Compaction summary streams progressively with animated reveal
- **Context ring indicator:** Real-time token usage with pre-emptive warning when approaching threshold
- **Checkpoint integration:** File snapshots coexist with compaction; time-travel available

### Weaknesses & Gaps

| # | Gap | Severity | Impact |
|---|-----|----------|--------|
| G1 | No manual compaction trigger (user cannot force compact) | Medium | Loss of user agency |
| G2 | Trigger at 60k/200k (30%) — premature, wastes context window | Medium | More frequent compactions than needed |
| G3 | No compaction summary persistence — lost on session reload | High | History inaccessible after restart |
| G4 | No quality validation of compaction output | High | Silent context degradation |
| G5 | No retry or recovery if compaction stream fails mid-way | High | Corrupt conversation state |
| G6 | Token counting depends on stream metadata; inaccurate before first generation | Medium | `willAutoCompact` misleading on cold start |
| G7 | No compaction telemetry / metrics events | Medium | Cannot measure effectiveness |
| G8 | Back-to-back compactions possible (no cooldown) | Medium | Cascading context loss |
| G9 | No user notification when compaction actually fires | Low | Confusing during long operations |
| G10 | Compaction result `clearedInputTokens` logged to console only | Low | No structured observability |

### Known Failure Modes

1. **Mid-stream network disconnect:** Compaction starts streaming but drops — `compaction_start` emitted without `compaction_end`, leaving UI in loading state
2. **Summary quality regression:** If `COMPACTION_PROMPT` is not followed precisely, critical context (especially multi-file refactors) silently disappears
3. **Back-to-back rapid compaction:** High-throughput task consuming tokens fast may trigger a second compaction before the first is fully processed
4. **Cold-start token mismatch:** First message after session restore shows wrong ring percentage until first `usage_metrics` event
5. **Checkpoint-compaction ordering:** Restoring a checkpoint from before a compaction event may lead to inconsistent message history (checkpointed files vs. compacted messages)

---

## Requirements & User Scenarios

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR1 | Compaction must preserve all user messages verbatim | P0 |
| FR2 | Compaction must preserve all code snippets verbatim with file paths | P0 |
| FR3 | Context window usage must be visible in real time | P1 |
| FR4 | Users must be warned before compaction fires | P1 |
| FR5 | Compaction state must survive session restarts | P1 |
| FR6 | Users must be able to manually trigger compaction | P2 |
| FR7 | Compaction errors must surface to users with recovery options | P1 |
| FR8 | Compaction metadata must feed into telemetry | P2 |

### Non-Functional Requirements

- **Latency:** Compaction must not block user from submitting the next message
- **Reliability:** System must recover gracefully from partial compaction failures
- **Observability:** All compaction events must be telemetry-trackable
- **Transparency:** Users must always understand current context window state

### User Scenarios

#### Happy Path Scenarios

| Scenario | Trigger | Expected Behavior |
|----------|---------|-------------------|
| S1: Normal conversation | Organic token growth | Ring fills gradually; compaction fires automatically near threshold; summary shown then collapsed |
| S2: Large code gen task | Single response produces thousands of tokens | Compaction may fire mid-task; agent continues from summary |
| S3: Multi-file refactor | Many tool calls with file content | All file paths and code changes preserved in summary |
| S4: Resume after session restart | Session reload | Ring shows last known token count; compaction summary visible in history |
| S5: Thread switching | User switches to new thread | Ring resets to new thread's token count |

#### Edge Case Scenarios

| Scenario | Risk | Mitigation Needed |
|----------|------|-------------------|
| S6: Network drop during compaction stream | UI stuck in "Compacting..." state | Timeout + error state with retry |
| S7: Second message while compaction is streaming | Race condition on message history | Queue new message until compaction finishes |
| S8: Compaction applied but summary is empty | Context silently wiped | Validate summary length before accepting |
| S9: Checkpoint restore crosses a compaction boundary | File state vs message history mismatch | Warn user; offer full history reset |
| S10: User sends message right at trigger threshold | Compaction fires during the response | Show compaction inline in the streaming response |
| S11: Very long single user message | Single message may consume >50% of context | Warn user before submitting if message is unusually large |
| S12: Back-to-back compactions within same generation | Second compaction before first metadata arrives | Cooldown period; queue compactions |

---

## Proposed Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (React)                         │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ContextUsage  │  │  CompactionSeg   │  │  ChatInput       │  │
│  │Indicator     │  │  (streaming)     │  │  (send button)   │  │
│  └──────┬───────┘  └────────┬─────────┘  └────────┬─────────┘  │
│         │                   │                       │            │
│  ┌──────▼───────────────────▼───────────────────────▼─────────┐ │
│  │              useContextUsage hook                           │ │
│  │  (RPC polling + live usage_metrics + compaction events)     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└───────────────────────────┬─────────────────────────────────────┘
                            │ RPC (VSCode Messenger)
┌───────────────────────────▼─────────────────────────────────────┐
│                    Backend (Extension)                          │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                   AgentExecutor                            │ │
│  │  ┌──────────────┐  ┌───────────────┐  ┌────────────────┐  │ │
│  │  │ CompactionMgr│  │ StreamHandler │  │ CheckpointMgr  │  │ │
│  │  │ (lifecycle)  │  │ (event parse) │  │ (snapshots)    │  │ │
│  │  └──────┬───────┘  └───────┬───────┘  └───────┬────────┘  │ │
│  └─────────┼──────────────────┼───────────────────┼───────────┘ │
│            │                  │                   │             │
│  ┌─────────▼──────────────────▼───────────────────▼───────────┐ │
│  │               ChatStateStorage                              │ │
│  │  threads → generations → modelMessages + compactionHistory  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Anthropic API
                    compact_20260112
```

### State Machine for Compaction Lifecycle

```
           ┌──────────┐
           │  IDLE    │ ← (tokens < trigger)
           └────┬─────┘
                │ tokens approach trigger threshold
                ▼
           ┌──────────┐
           │ PENDING  │ ← (willAutoCompact = true, shown in UI warning)
           └────┬─────┘
                │ user sends next message → API triggers compact
                ▼
           ┌──────────┐
           │  ACTIVE  │ ← (compaction_start event received)
           └────┬─────┘
                │ compaction_delta events stream in
                ▼
           ┌──────────┐
           │STREAMING │ ← (summary streaming to UI)
           └────┬─────┘
           ┌────┴────┐
           │         │
           ▼         ▼
      ┌─────────┐ ┌─────────┐
      │COMPLETE │ │ FAILED  │
      │         │ │         │
      └─────────┘ └────┬────┘
                       │
                       ▼
                  ┌─────────┐
                  │ RECOVER │ ← retry / warn user / use last checkpoint
                  └─────────┘
```

---

## Component Design

### 1. CompactionManager (New)

**Purpose:** Encapsulates all compaction lifecycle concerns, removing this logic from `AgentExecutor`.

**Interface:**
```typescript
interface CompactionManager {
    // Configuration
    configure(config: NativeCompactionConfig): void;

    // Lifecycle
    onCompactionStart(): void;
    onCompactionDelta(content: string): void;
    onCompactionEnd(response: StreamResponse): CompactionRecord;

    // Recovery
    handleFailure(error: Error): Promise<void>;

    // Query
    getLastCompactionRecord(): CompactionRecord | null;
    isCompactionInFlight(): boolean;
}

interface CompactionRecord {
    id: string;                   // UUID for this compaction event
    timestamp: number;
    summary: string;              // Full compaction summary text
    clearedInputTokens: number;   // Tokens freed
    tokensBefore: number;
    tokensAfter: number;
    generationId: string;         // Which generation triggered it
    durationMs: number;
}
```

### 2. Enhanced ChatStateStorage

**New fields on `Generation`:**
```typescript
interface Generation {
    // ... existing fields ...
    compactionRecords: CompactionRecord[];  // History of all compactions
    lastCompactionSummary?: string;         // Most recent summary (for session restore display)
}
```

**New methods:**
```typescript
interface ChatStateStorage {
    // ... existing methods ...
    appendCompactionRecord(threadId: string, generationId: string, record: CompactionRecord): void;
    getCompactionHistory(threadId: string): CompactionRecord[];
    getLastCompactionSummary(threadId: string): string | null;
}
```

### 3. Enhanced ContextUsageInfo

```typescript
interface ContextUsageInfo {
    tokensUsed: number;
    maxTokens: number;
    percentage: number;
    willAutoCompact: boolean;
    compactionTriggerTokens: number;
    // New fields:
    compactionCount: number;            // Compaction events in this thread
    lastCompactionAt?: number;          // Timestamp of last compaction
    estimatedRemainingMessages: number; // Rough estimate based on avg message token cost
}
```

### 4. Trigger Policy Engine (New)

Replace the single hardcoded constant with a configurable policy:

```typescript
interface CompactionTriggerPolicy {
    type: 'token_threshold' | 'percentage' | 'adaptive';
    value: number;                      // tokens or 0-1 fraction
    minCooldownMs?: number;             // Default: 30000ms
    maxCompactionsPerSession?: number;  // Safety limit
}

// Proposed default (vs current 60k/200k = 30%)
const DEFAULT_POLICY: CompactionTriggerPolicy = {
    type: 'percentage',
    value: 0.75,          // 150k of 200k = 75%
    minCooldownMs: 30000,
    maxCompactionsPerSession: 10
};
```

**Rationale for moving 30% → 75%:**
- Current 60k/200k (30%) is extremely conservative — wastes 140k tokens of usable context
- 75% (150k tokens) maximizes context utility while leaving a 50k buffer for response generation
- Anthropic's native compaction minimum is 50k; its own recommended default is 150k

---

## Compaction Strategy & Algorithms

### Preservation Priority

| Priority | Content Type | Strategy |
|----------|-------------|----------|
| P0 (Always) | All user messages | Verbatim copy, never paraphrase |
| P0 (Always) | Code blocks with file paths | Verbatim copy, full paths required |
| P0 (Always) | Error messages and stack traces | Verbatim copy |
| P1 (High) | Agent decisions and rationale | Summarized with key facts |
| P1 (High) | Tool call results (diagnostics, file reads) | Summarized with key data |
| P2 (Medium) | Assistant reasoning steps | Heavily condensed |
| P3 (Low) | Intermediate streaming text | May be omitted |

### Summary Quality Validation (New)

After compaction completes, validate the summary against minimum quality criteria before accepting:

```
Validation Rules:
1. Summary length ≥ 200 characters
2. Summary contains <analysis> section (structural requirement per COMPACTION_PROMPT)
3. If user messages exist in thread → at least 1 reproduced verbatim
4. If code blocks exist → at least 1 code block present in summary
5. Summary does not contain refusal patterns ("I cannot", "I don't have access")

On validation failure:
→ Mark compaction as FAILED
→ Do NOT replace message history (rollback)
→ Emit compaction_end with error payload to frontend
→ Surface error state in CompactionSegment UI
→ Log full summary + error to telemetry
```

### Compaction Prompt Improvements

The existing `COMPACTION_PROMPT` is strong. Recommended additions:

1. **Tool call coverage** — explicitly cover all tool types (diagnostics, HTTP calls, shell commands), not just file operations
2. **Checkpoint tagging** — instruct the model to note any checkpoint IDs referenced in the conversation
3. **Conflict detection** — flag if the conversation contained contradictory user instructions

---

## Trigger Conditions & Policies

### Current vs. Proposed

| Aspect | Current | Proposed |
|--------|---------|----------|
| Threshold | 60,000 tokens (absolute) | 150,000 tokens (75% of 200k) |
| Policy type | Fixed token count | Configurable percentage or absolute |
| Cooldown | None | 30 seconds minimum between compactions |
| User control | None | Manual "Compact Now" button |
| Pre-emptive warning | Yes | Yes + "Compact Now" option in tooltip |

### Trigger Decision Flow

```
On each usage_metrics event:
    IF isCompactionInFlight()         → skip
    IF timeSinceLastCompaction < 30s  → skip
    IF inputTokens >= triggerThreshold → set willAutoCompact = true

On user message submit:
    IF willAutoCompact:
        → attach contextManagement config to streamText
        → set isCompactionInFlight = true
```

### Manual Compaction Trigger

Show "Compact Now" in `ContextUsageIndicator` tooltip when:
- `percentage > 0.5` (meaningful to compress)
- `!isCompactionInFlight`
- `!isLoading`

**New RPC method required:**
```typescript
triggerManualCompaction(params: { threadId: string; workspaceId: string }): Promise<void>
```

---

## Error Handling & Edge Cases

| Error | Detection | Response |
|-------|-----------|----------|
| Network drop during compaction stream | `compaction_start` without `compaction_end` within 30s | Error state in UI; preserve existing history; offer retry |
| Empty/invalid summary | Summary length < 200 chars after `compaction_end` | Validation failure → rollback → notify user |
| Second compaction before first completes | `isCompactionInFlight` check | Queue second trigger; process after first |
| API 5xx during compaction stream | `onError` in streamText | Mark FAILED; log error; continue conversation without compaction |
| Checkpoint restore crossing compaction boundary | Generation has `compactionRecords` but checkpoint is older | Warning: "This checkpoint predates a context compaction. Message history may be inconsistent." |
| Cold-start with no prior token count | No prior generation exists | Estimate via `length / 4` chars-per-token heuristic; display with `~` prefix |
| Very large single user message pre-submit | Client-side token estimate > 50k | Warning dialog: "This message is very large and may immediately trigger context compaction." |

### Recovery Strategy

```
Compaction Failure Recovery:
1. CompactionManager transitions to FAILED state
2. Notify AgentExecutor: do NOT replace message history
3. Emit compaction_end with error payload to frontend
4. Frontend shows error state in CompactionSegment with "Retry" option
5. Log structured error to telemetry (compaction_failed event)
6. Allow user to continue conversation without compaction
7. If compaction_count > maxCompactionsPerSession:
   → disable further auto-compaction
   → surface persistent warning to user
```

---

## Performance Considerations

### Cold-Start Token Estimation

**Problem:** `willAutoCompact` is incorrect until the first `usage_metrics` event arrives.

**Solution:** Estimate token count on session restore using a lightweight heuristic:
```typescript
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4); // ~4 chars/token for English
}

// Sum across all model messages in the thread
const estimatedTokens = thread.generations
    .flatMap(g => g.modelMessages)
    .reduce((sum, msg) => sum + estimateTokens(JSON.stringify(msg.content)), 0);

// Display as "~45k" until real usage_metrics arrives
```

### Compaction Impact on Latency

- Compaction adds ~2–10s to the response where it fires (server-side summary generation)
- Cannot be reduced — managed via UX expectations
- Show "Compacting context..." indicator in chat footer during active compaction

### Memory Bounds on Compaction History

- `CompactionRecord.summary` strings: 5–20KB each
- Cap: Keep last 3 compaction records per thread
- Records beyond the cap retain metadata only (drop the `summary` field)
- Prevents unbounded memory growth in long-lived threads

---

## Testing Strategy

### Unit Tests

| Test | File | Assertion |
|------|------|-----------|
| CompactionManager state transitions | `compact/__tests__/CompactionManager.test.ts` | Full IDLE → ACTIVE → COMPLETE flow |
| Trigger policy evaluation | `compact/__tests__/TriggerPolicy.test.ts` | Correct threshold at different token counts for both modes |
| Summary quality validation | `compact/__tests__/validation.test.ts` | Reject empty/refusal summaries; accept structurally valid ones |
| Token estimation heuristic | `compact/__tests__/estimation.test.ts` | Within 15% of actual Anthropic token count |

### Integration Tests

| Scenario | Verification |
|----------|-------------|
| E2E compaction flow | Cross threshold → compaction fires → UI updates correctly |
| Session restore after compaction | Compact → save → reload → summary visible in history |
| Checkpoint + compaction ordering | Create checkpoint → compact → restore → warning shown |
| Back-to-back compaction prevention | Rapid second trigger → queued, not dropped or duplicated |

### Manual Testing Checklist

- [ ] Ring updates live during streaming
- [ ] Warning tooltip appears when `willAutoCompact = true`
- [ ] CompactionSegment shows streaming animation then auto-collapses after 1.5s
- [ ] After session restart, last compaction summary is visible in chat history
- [ ] No immediate re-compaction after completing (cooldown enforced)
- [ ] "Compact Now" button appears at >50% context usage when not generating
- [ ] Error state shown in CompactionSegment on failure; conversation remains usable

---

## Deep Dive: Compaction During Active Bug Fix

### When Does Compaction Fire in a Bug Fix?

Compaction does **not** fire mid-stream. It fires at the **start of the next `streamText()` call** — i.e., when the user sends their next message and accumulated `input_tokens` exceed the trigger threshold. The sequence during a bug fix looks like:

```
Turn N:   User: "Fix the compilation error in UserService.bal"
          Agent: file_read → analysis → file_edit → get_compilation_errors → file_edit → verify
          → All tool calls + results saved to modelMessages
          → totalInputTokens = 140k

Turn N+1: User: "Now also fix the null pointer in line 42"
          → streamText() called with full history as input
          → input_tokens = 155k → EXCEEDS THRESHOLD
          → compaction fires BEFORE agent starts reasoning about the new request
          → Summary of turns 1..N generated
          → Agent responds to "null pointer in line 42" using only the summary + this message
```

### What Is In modelMessages During a Bug Fix

The AI SDK automatically accumulates the full tool call chain into `modelMessages`:

```
[
  { role: "user",      content: "Fix the compilation error..." },
  { role: "assistant", content: [text, tool-use: file_read("UserService.bal")] },
  { role: "user",      content: [tool-result: "<full file content>"] },         ← 5-20k tokens
  { role: "assistant", content: [text: "I see the issue...", tool-use: file_edit] },
  { role: "user",      content: [tool-result: "edit success"] },
  { role: "assistant", content: [text: "Let me check...", tool-use: get_compilation_errors] },
  { role: "user",      content: [tool-result: { errors: [{file, line, code, msg}] }] }, ← raw diagnostic JSON
  { role: "assistant", content: [text: "Still an error at line 42...", tool-use: file_edit] },
  { role: "user",      content: [tool-result: "edit success"] },
  { role: "assistant", content: [text: "Verifying...", tool-use: get_compilation_errors] },
  { role: "user",      content: [tool-result: { errors: [] }] },
  { role: "assistant", content: "The bug is fixed." }
]
```

The compaction model **sees all of this**. The question is whether the current `COMPACTION_PROMPT` tells it to preserve the right parts.

### What the Current Prompt Misses for Bug Fix Context

| Information | Current Prompt Coverage | Risk |
|-------------|------------------------|------|
| Specific diagnostic error codes and line numbers | Only "Errors & Fixes" in general | Model may write "fixed a compilation error" without preserving `BCE0034 at line 42` |
| Tool result content verbatim | Section 7 says "Summary of file operations" | Diagnostic JSON output gets paraphrased — specific error details lost |
| Sequence of failed fix attempts | Not explicitly required | If bug recurs, agent may retry the exact same failed approach |
| Final state of each modified file | "Files modified" but not current content | Agent may re-read files unnecessarily after compaction, burning tokens |
| Runtime logs provided via tool | Covered only if user provided them in their message | Tool-fetched logs silently dropped |
| Partially fixed state ("error A fixed, error B remains") | Not explicitly required | Agent loses awareness of partial progress |

### Required Prompt Addition: Diagnostic & Debug State

Add the following as **Section 9** in `COMPACTION_PROMPT` (`src/features/ai/agent/compact/prompt.ts`):

```
9. **Diagnostic & Debug State** (critical for bug fix continuity):
   - Copy ALL diagnostic/compilation error output VERBATIM, including error codes, line numbers, and file paths
   - Record the diagnostic state at EACH step — before and after every fix attempt, not just the final state
   - List ALL failed fix attempts in order: what change was made, what error remained
   - Include the exact tool result JSON for the most recent diagnostic check
   - Note the final diagnostic state: fully resolved / N errors remaining (list remaining errors verbatim)
   - If the user provided runtime logs or stack traces, copy them verbatim even if already in user messages
```

Also update **Section 5** to add:
```
   - For EACH significantly modified file, include the CURRENT (post-edit) full file content,
     not just a summary of what changed. This avoids the agent needing to re-read files after compaction.
```

### Why This Matters

After compaction, the agent's ONLY source of truth is the summary. If the summary says "fixed a compilation error" instead of "fixed `BCE0034: undefined variable 'client'` at `UserService.bal:42` by initializing `http:Client` in `init()`", the agent cannot:
- Know if the same error reappears in a new message
- Know whether a related error in a different file is the same root cause
- Know not to retry a fix approach that was already attempted and failed

---

## Deep Dive: Dynamic Project-Aware Compaction Prompts

### The Problem with a Static Prompt

The current `COMPACTION_PROMPT` is entirely static — it applies the same preservation rules to a healthcare FHIR integration, a data mapper, a multi-package workspace, and a test suite. Each project type has **different critical context** that must survive compaction.

A data mapper's most important context is its type mappings. A healthcare project's is its FHIR resource definitions and clinical codes. A test generation session's is the test function list and coverage. The static prompt has no way to say "for this specific session, these are the things that matter most."

### Available Signals for Project Detection

The agent already has everything needed to detect project type at the point where `createNativeCompactionConfig()` is called in `src/features/ai/agent/index.ts`:

| Signal | Source | Already Available? |
|--------|--------|-------------------|
| `operationType` | `GenerateAgentCodeRequest.operationType` | Yes |
| `generationType` | `GenerationMetadata.generationType` | Yes |
| `isWorkspace` | `projectKind === WORKSPACE_PROJECT` | Yes |
| Import statements in `.bal` files | `ProjectSource.sourceFiles[].content` | Yes |
| Natural programming `.req` files | `extractResourceDocumentContent(projects)` | Yes |
| Module names | `ProjectSource.projectModules[].moduleName` | Yes |

### Domain Detection from Imports

A lightweight scan of source file imports identifies the domain reliably:

```typescript
// src/features/ai/agent/compact/domains.ts

export type CompactionDomain = 'healthcare' | 'datamapper' | 'testing' | 'workspace';

const DOMAIN_IMPORT_PATTERNS: Record<CompactionDomain, RegExp> = {
    healthcare:  /import\s+ballerinax\/health\.(fhir|hl7)/,
    datamapper:  /_generated|ballerinax\/data\.mapper/,  // or check generationType
    testing:     /import\s+ballerina\/test/,
    workspace:   /^/,   // detected via projectKind, not imports
};

export function detectDomains(
    projects: ProjectSource[],
    operationType?: OperationType,
    generationType?: string,
    isWorkspace?: boolean
): CompactionDomain[] {
    const allSource = projects
        .flatMap(p => p.sourceFiles)
        .map(f => f.content ?? '')
        .join('\n');

    const domains: CompactionDomain[] = [];

    if (DOMAIN_IMPORT_PATTERNS.healthcare.test(allSource)) domains.push('healthcare');
    if (generationType === 'datamapper')                    domains.push('datamapper');
    if (operationType === OperationType.TESTS_FOR_USER_REQUIREMENT) domains.push('testing');
    if (isWorkspace)                                        domains.push('workspace');

    return domains;
}
```

### Dynamic Prompt Builder

Replace the static `COMPACTION_PROMPT` constant with a builder function:

```typescript
// src/features/ai/agent/compact/prompt.ts

export function buildCompactionInstructions(
    domains: CompactionDomain[],
    projectName?: string
): string {
    const parts: string[] = [BASE_COMPACTION_PROMPT];

    if (domains.includes('datamapper'))  parts.push(DATA_MAPPER_ADDENDUM);
    if (domains.includes('testing'))     parts.push(TEST_GENERATION_ADDENDUM);
    if (domains.includes('healthcare'))  parts.push(HEALTHCARE_ADDENDUM);
    if (domains.includes('workspace'))   parts.push(WORKSPACE_ADDENDUM);

    return parts.join('\n\n---\n\n');
}
```

Call site in `src/features/ai/agent/index.ts`:
```typescript
// Before (static):
const contextManagement = createNativeCompactionConfig({
    trigger: NATIVE_COMPACTION_TRIGGER,
    instructions: NATIVE_COMPACTION_INSTRUCTIONS
});

// After (dynamic):
const domains = detectDomains(projects, params.operationType, params.metadata?.generationType, isWorkspace);
const contextManagement = createNativeCompactionConfig({
    trigger: NATIVE_COMPACTION_TRIGGER,
    instructions: buildCompactionInstructions(domains, projects[0]?.projectName)
});
```

### Domain-Specific Addenda

#### Data Mapper Addendum
```
## Data Mapper Session — Additional Preservation Rules

This session involves data transformation work. Preserve with maximum fidelity:

- ALL input type (source) and output type (target) record definitions VERBATIM
  — every field name, type annotation, optional marker, and default value
- ALL mapping function signatures VERBATIM with full parameter and return types
- The COMPLETE mapping logic for each field: conditional mappings, transformations,
  default values, and nil-handling
- Any intermediate transformation records created during mapping
- Explicit note for fields where the mapping is ambiguous or was user-corrected
```

#### Test Generation Addendum
```
## Test Generation Session — Additional Preservation Rules

This session involves test code generation. Preserve with maximum fidelity:

- A complete list of ALL test functions generated, with their full function signatures
- Which service functions or resource methods each test covers (coverage map)
- All test data fixtures and mock configurations used
- All assertion logic verbatim — especially the expected values and conditions
- Any test functions the user explicitly requested changes to (and what change was made)
- The final test pass/fail state if diagnostic checks were run
```

#### Healthcare / FHIR Addendum
```
## Healthcare Integration Session — Additional Preservation Rules

This session involves FHIR/HL7 healthcare data. Preserve with maximum fidelity:

- ALL FHIR resource type names referenced (Patient, Observation, Bundle, etc.)
- ALL HL7 message types and segment structures (MSH, PID, OBX, etc.)
- Any FHIR profile URLs and extension definitions verbatim
- Clinical terminology codes used: LOINC, SNOMED CT, ICD-10, RxNorm — code + display verbatim
- Cardinality constraints (required/optional/repeating) for each resource field discussed
- Any terminology validation errors and their resolutions
```

#### Multi-Package Workspace Addendum
```
## Multi-Package Workspace Session — Additional Preservation Rules

This session involves a multi-package Ballerina workspace. Preserve with maximum fidelity:

- For EVERY file modification: prefix the file path with its package name
  (e.g., "package-a/service.bal" not just "service.bal")
- Record which package was the active package during each operation
- Note any cross-package dependencies that were modified or created
- Record the build order if multiple packages were touched
- Note any workspace-level configuration changes (workspace.toml)
```

### Prompt Selection Decision Table

| Condition | Addendum Applied | What Extra Is Preserved |
|-----------|-----------------|------------------------|
| `generationType === 'datamapper'` | Data Mapper | Type definitions, field-level mapping logic |
| `operationType === TESTS_FOR_USER_REQUIREMENT` | Test Generation | Test function list, coverage map, assertions |
| Healthcare imports detected | Healthcare | FHIR resources, HL7 segments, clinical codes |
| `isWorkspace === true` | Workspace | Package-prefixed paths, cross-package dependencies |
| Multiple conditions | All matching addenda combined | Full coverage |
| None match | Base prompt only | Standard preservation rules |

### Trade-offs & Considerations

| Concern | Analysis |
|---------|---------|
| Prompt length increase | Each addendum adds ~200–400 tokens to `instructions`. Anthropic's compaction is billed at output tokens; instructions are modest overhead. Acceptable. |
| Domain detection accuracy | Import-based detection is accurate for Ballerina (explicit imports required). False positives possible for generated connectors — mitigated by checking `isGenerated === false`. |
| New project types | Adding a new addendum requires only adding a new constant and a `detectDomains` check. Low maintenance cost. |
| Over-preservation risk | More specific instructions make the summary longer. This is a feature, not a bug — richer summaries reduce quality loss. The API handles summary length internally. |

---

## Open Questions

1. **User-configurable threshold?** VS Code setting for power users — adds complexity but provides control
2. **Prompt caching interaction:** Does `compact_20260112` invalidate existing prompt cache entries?
3. **Multi-model support:** `compact_20260112` is Anthropic-specific — what is the fallback strategy if a non-Claude model is used?
4. **Compaction summary export:** Should summaries be shareable/exportable for team handoffs?

---

## Future Enhancements

| Enhancement | Priority | Complexity |
|-------------|----------|------------|
| VS Code setting for trigger threshold | Medium | Low |
| Multi-model compaction fallback (manual summarization) | High | High |
| Proactive pre-submit warning for large messages | Medium | Low |
| Compaction quality score heuristic | Medium | Medium |
| Compaction history panel | Low | Medium |
| Cross-session compaction summary export | Low | Medium |

---

## Critical Files Reference

| File | Change Needed |
|------|---------------|
| `src/features/ai/agent/compact/native.ts` | Update default trigger to 150k |
| `src/features/ai/agent/constants.ts` | `NATIVE_COMPACTION_TRIGGER = 150000` |
| `src/features/ai/agent/AgentExecutor.ts` | Extract compaction logic to `CompactionManager` |
| `src/views/ai-panel/chatStateStorage.ts` | Add `compactionRecords` + `lastCompactionSummary` to `Generation` |
| `src/rpc-managers/ai-panel/rpc-manager.ts` | Enrich `getContextUsage()` response; add `triggerManualCompaction()` |
| `../ballerina-core/src/rpc-types/ai-panel/interfaces.ts` | Add new fields to `ContextUsageInfo` |
| `../ballerina-core/src/state-machine-types.ts` | Add `CompactionFailed` to `ChatNotify` union |
| `../ballerina-visualizer/.../CompactionSegment.tsx` | Add error state rendering |
| `../ballerina-visualizer/.../ContextUsageIndicator/` | Add "Compact Now" button to tooltip |
