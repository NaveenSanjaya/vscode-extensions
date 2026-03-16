# Copilot Context Compaction — Red Team Analysis

**Reviewer:** Principal Engineer  
**Date:** 2026-03-06  
**Target Document:** `COPILOT_COMPACTION_DESIGN.md` v2.0.0  
**Scope:** Gaps, redundancies, loopholes, and vulnerabilities

---

## Executive Summary

The design proposes a shared `@wso2/copilot-utilities` package at `workspaces/common-libs/copilot-utilities/` that provides a pluggable `CompactionEngine` for both the Ballerina and MI copilots. After tracing every component in the design against the actual codebase, **15 critical issues**, **8 moderate issues**, and **6 minor issues** were identified, spanning API mismatches, architectural gaps, security concerns, and incorrect assumptions.

---

## Table of Contents

1. [Critical Issues (P0)](#1-critical-issues-p0)
2. [Moderate Issues (P1)](#2-moderate-issues-p1)
3. [Minor Issues (P2)](#3-minor-issues-p2)
4. [Redundancies](#4-redundancies)
5. [Summary Matrix](#5-summary-matrix)
6. [Recommended Next Steps](#6-recommended-next-steps)

---

## 1. Critical Issues (P0)

### C01 — `getChatHistory` / `setChatHistory` Do Not Exist

**Location in Design:** Section 6.2.1, CompactionManager

**Design assumes:**
```typescript
chatStateStorage.getChatHistory(workspaceId, threadId, generationId);
chatStateStorage.setChatHistory(workspaceId, threadId, generationId, result.compactedMessages);
```

**Actual API:** `ChatStateStorage` has:
- `getChatHistoryForLLM(workspaceId, threadId): any[]` — returns flattened `modelMessages` across **all** generations in a thread, with no `generationId` parameter.
- No `setChatHistory` method. Messages are set per-generation via `updateGeneration(workspaceId, threadId, generationId, { modelMessages: [...] })`.

**Impact:** The entire integration point is built on a non-existent API. The design fundamentally misunderstands how messages are stored — they are **per-generation**, not flat per-thread. Compaction needs to operate across all generations or the storage model needs to change.

**Fix Required:** Either:
(a) Add new methods to `ChatStateStorage` (e.g. `replaceAllMessages(workspaceId, threadId, compactedMessages)` that collapses all generations into a single synthetic generation), or  
(b) Redesign CompactionManager to work with the generation-based model — read from `getChatHistoryForLLM`, then update by clearing old generations and creating a new synthetic generation holding the compacted messages.

---

### C02 — `maxOutputTokens` Mismatch

**Design assumes:** `maxOutputTokens: 20_000` (Section 3.3, ThresholdCalculator)

**Actual code:** `AgentExecutor.execute()` uses `maxOutputTokens: 8192` for `streamText`.

**Impact:** The auto-compact threshold calculates as `200,000 - 20,000 - 13,000 = 167,000`. With the real output limit of 8,192, the effective safe window is `200,000 - 8,192 - 13,000 = 178,808`. The design would trigger compaction ~12K tokens earlier than necessary, wasting context. Worse, if `maxOutputTokens` is later increased in `AgentExecutor` without updating compaction config, the threshold becomes dangerously high.

**Fix Required:** Source `maxOutputTokens` from the same constant used by `streamText`, not a hardcoded value in compaction config. Otherwise, these will inevitably drift.

---

### C03 — System Prompt Excluded from Token Estimation

**Design assumes:** Token counting only covers `messages[]`.

**Actual code:** The `allMessages` array sent to `streamText` includes:
```typescript
{ role: "system", content: getSystemPrompt(projects, operationType), providerOptions: cacheOptions }
```

The system prompt can be substantial (project structure, tools, rules). It is part of the context window budget but is **never included in the compaction engine's token count**.

**Impact:** The token estimate could be off by thousands of tokens (system prompts are typically 2K-8K+ tokens). This means compaction could trigger too late (after the real context is already near the limit) or the LLM may hit context errors before auto-compact fires.

**Fix Required:** The `shouldCompact` check must include system prompt + tool definitions in the token estimate, or the threshold must account for them with a conservative buffer.

---

### C04 — Token Estimation via `chars/4` is Dangerously Inaccurate for Tool Calls

**Design assumes:** `Math.ceil(totalChars / 4)` as token estimation.

**Actual content:** AI SDK `ModelMessage[]` contains tool calls and tool results as **structured objects**:
```typescript
{ role: "tool", content: [{ type: "tool-result", toolCallId: "...", result: { ... } }] }
```

When `JSON.stringify`-ed, tool results (file contents, diagnostics output, etc.) inflate character count dramatically due to JSON escaping, nested objects, and metadata. Conversely, the LLM tokenizer packs structured data differently than raw text.

**Impact:** Token estimates could be off by 30-50% in either direction for tool-heavy agent conversations. Since the Ballerina copilot is an agent with heavy tool use (`stepCountIs(50)` allows up to 50 tool call steps), this is the primary conversation pattern, not an edge case.

**Fix Required:** Either:
(a) Use the existing `@anthropic-ai/tokenizer` package (already a dependency of MI) for accurate counting, or  
(b) Apply a weighted formula: tool results and structured content should use a different ratio than prose, or  
(c) Use the `usage` object from `streamText` response which provides actual `inputTokens` — this gives exact post-hoc measurement and can be used to calibrate thresholds.

---

### C05 — `populateHistoryForAgent` Drops Message Structure

**Design assumes:** History messages have `{ role, content }` structure suitable for summarization.

**Actual code:** `populateHistoryForAgent` maps every chat entry to just `{ role: entry.role, content: entry.content }`. For multi-turn agent conversations, the `content` field of assistant messages contains **tool call arrays**, not just text. The Vercel AI SDK `ModelMessage` type has:
- `content: string` for user/system messages
- `content: Array<TextPart | ToolCallPart>` for assistant messages  
- `content: Array<ToolResultPart>` for tool messages

When the summarization callback passes these messages to `generateText`, the content structure matters. The design's `prepareMessagesForSummarization` only handles `thinking`, `image`, and `document` blocks — it doesn't handle `tool-call` or `tool-result` content types at all.

**Impact:** Summarization LLM call will receive raw tool call/result structures. Best case: inflated token usage. Worst case: LLM confusion or API errors if the message format is invalid for a non-tool-calling `generateText` call.

**Fix Required:** `prepareMessagesForSummarization` must:
1. Convert tool-call parts to text descriptions: `"Called tool X with args {...}"`
2. Summarize or truncate large tool results (file reads can be 10K+ chars each)
3. Remove tool-result message roles entirely (or convert to user-role text)

---

### C06 — No System Prompt Handling in Summarization Call

**Design states (Section 5.2):**
```typescript
const response = await this.summarizationCallback(preparedMessages, systemPrompt);
```

**But the callback signature sends both messages AND systemPrompt.** The integration example (Section 6.2.1) does:
```typescript
summarizationCallback: async (messages, systemPrompt) => {
  const result = await generateText({
    model,
    system: systemPrompt,
    messages: messages,
  });
  return result.text;
}
```

**Problem:** The `messages` passed include the ORIGINAL system prompt from the agent conversation (`getSystemPrompt(projects, operationType)`). When `generateText` is called with a `system:` parameter AND messages containing a system message, the behavior depends on the SDK/provider. With Vercel AI SDK + Anthropic:
- Having `system:` parameter AND a `system` role message in `messages` can cause conflicts
- The original system prompt (which instructs the model to be a Ballerina coding agent) will conflict with the summarization system prompt

**Fix Required:** `prepareMessagesForSummarization` must strip any `role: 'system'` messages from the conversation history before passing to the summarization callback.

---

### C07 — Compaction Before `streamText` Creates Race Condition

**Design proposes (Section 6.2.2):**
```typescript
// BEFORE calling streamText, check for compaction
await this.compactionManager.checkAndCompact(workspaceId, threadId, generationId);
```

**Actual flow:** In `AgentExecutor.execute()`:
1. `addGeneration()` creates a new generation for the current user message
2. `getChatHistory()` retrieves all prior generations' messages
3. Messages are assembled and sent to `streamText`

**Problem:** If compaction runs at step 2, it modifies the storage. But the current user message hasn't been stored in `modelMessages` yet (it's stored after `handleStreamFinish`). The compaction would summarize all prior history but the new user message would be appended after, creating a valid sequence. However:

- The `addGeneration()` call has already created an empty generation for the current turn
- Compaction (as designed) would need to navigate the generation model to replace prior messages
- If compaction uses `getChatHistoryForLLM`, it will include the current empty generation's (empty) modelMessages — harmless but messy

More critically: **The design calls `checkAndCompact` with `generationId`**, but compaction needs to operate on the entire thread history, not a single generation. The generation-level granularity doesn't match the operation's scope.

**Fix Required:** Compaction should operate at thread level (before the new generation is created) or after the stream completes (as a post-processing step). Using a thread-level API is cleaner.

---

### C08 — MI Integration Uses Non-Existent Architecture

**Design proposes (Section 6.3):**
```typescript
rpcServer.onRequest('generateCode', async (params) => { ... });
rpcServer.onRequest('compactConversation', async (params) => { ... });
```

**Actual MI architecture:** 
- MI does NOT have an agentic loop in this workspace. The `sendAgentMessage`, `compactConversation` RPC types exist in `mi-core/lib/rpc-types/agent-mode/` as compiled `.d.ts` and `.js` files, but **no implementation source exists** in `mi-extension/src/`.
- The existing MI copilot (non-agent mode) uses `fetchCodeGenerationsWithRetry()` which calls `generateSynapse()` — a single-turn generation, not multi-turn.
- The sliding window (`chatHistory.slice(-7, -1)`) happens in `fetchCodeGenerationsWithRetry`, not in an RPC handler.
- MI has a separate agent-mode system whose source may live outside this workspace.

**Impact:** The MI integration section designs against an architecture that doesn't exist in the codebase. The `generateSynapse` function signature, the RPC handler structure, and the message format are all assumed incorrectly.

**Fix Required:** Before designing MI integration, determine:
1. Where does the MI agent-mode implementation actually live?
2. Is the agent-mode a backend service (external) or extension-local?
3. For the existing (non-agent) MI copilot, integration should hook into `fetchCodeGenerationsWithRetry` in `utils.ts`, not a fictional RPC handler.

---

### C09 — No Handling of Tool Messages in Continuation

**Design section 4.4** creates continuation messages as a simple user + assistant pair:
```typescript
[
  { role: 'user', content: '[Context restored...]' },
  { role: 'assistant', content: 'This session is being continued...' },
]
```

**Problem:** After compaction, the agent LLM receives this minimal history then gets the new user message. For the **Ballerina agent** which uses tool calls extensively, the LLM will have:
- No memory of which files exist in the project
- No memory of which files it already read/modified
- No tool call history to understand project state
- No awareness of pending review states, checkpoints, or modified files

The summary text captures high-level intent but **the LLM will re-read files it already read, retry operations it already completed**, and potentially make conflicting changes.

**Fix Required:** Post-compaction context should:
1. Include a structured "project state" section listing all currently modified files and their status
2. Include the temp project path so the agent can reference the right working directory
3. Consider attaching a "files of interest" tool result so the agent has immediate file awareness

---

### C10 — Missing Error Handling for Summarization Callback Failure

**Design's `CompactionEngine.compactWithRetry`:**
```typescript
const summary = await this.summarizationService.summarize(messages, options.customInstructions);
```

**No try-catch.** If the summarization LLM call fails (rate limit, network error, malformed response, token limit exceeded on the summarization call itself), the entire `compact()` call throws, and because `checkAndCompact` is called before `streamText`:
- The user's chat request fails entirely
- No graceful degradation
- The `isCompacting` flag is correctly released in `finally`, but the user gets an error instead of their response

**Fix Required:** Failed auto-compaction should be a warning, not a fatal error. The flow should:
1. Log the failure
2. Continue with un-compacted history
3. Optionally notify the user that compaction failed
4. Retry compaction on the next turn

---

### C11 — Summarization Prompt Asks for `<analysis>` Thinking — Token Waste

**Design Section 4.3** includes in the summarization prompt:
```
Before providing your final summary, wrap your analysis in <analysis> tags...
```

**Impact:** The summarization LLM is asked to produce potentially lengthy `<analysis>...</analysis>` blocks that are then **discarded** (only `<summary>...</summary>` is parsed). On a large conversation being compacted, this could consume 5K-15K output tokens of unnecessary generation, adding latency and cost.

**Fix Required:** Either:
(a) Use Claude's extended thinking feature (which doesn't count against output tokens) instead of asking for `<analysis>` in the output, or  
(b) Remove the analysis step and ask for the summary directly — the prompt is already detailed enough, or  
(c) At minimum, use `stop_sequences` or `maxOutputTokens` limits on the summarization call.

---

### C12 — `hashContent` is Not a Real Hash — Cache Collisions

**Design Section 3.2:**
```typescript
private hashContent(message: any): string {
  const str = JSON.stringify(message);
  const len = str.length;
  const start = str.substring(0, 20);
  const end = len > 20 ? str.substring(len - 20) : '';
  return `${len}:${start}:${end}`;
}
```

**Problem:** This is a prefix+suffix+length pseudo-hash. Two messages with the same length and the same first/last 20 characters but different middle content would collide. For tool results that all start with `{"type":"tool-result","toolCallId":"` and end with `"}}`, collisions are **highly likely**.

Additionally, the caching strategy is flawed: when not all messages are cached, the callback returns a total count for all messages, and individual estimates are just `total / messageCount` (average). This means cached individual values are inaccurate, and mixing cached and uncached messages produces wrong totals.

**Fix Required:** Either:
(a) Use Node.js `crypto.createHash('sha256')` for proper hashing (already imported in `chatStateStorage.ts`), or  
(b) Remove the message-level cache entirely and only cache the full-array total (simpler, still effective), or  
(c) Use the actual `usage.inputTokens` from the last `streamText` response as the baseline.

---

### C13 — Compaction During Active Tool Execution

**Design does not address:** What happens if compaction triggers during a multi-step agent loop?

`streamText` with `stepCountIs(50)` can involve up to 50 tool call steps. Each step may modify files. The design checks for compaction **before** `streamText`, but the context grows **during** the stream as tool calls and results accumulate.

If a future version adds mid-stream compaction, or if the single-turn context (system prompt + full history + new user message + all tool call steps) exceeds the context window during streaming, the agent will fail with a context window error.

**Impact:** The current design only prevents context overflow for the **start** of a turn, not during the turn itself. A long tool-call chain could still exceed the window.

**Fix Required:** Document this limitation explicitly. Consider adding a pre-flight check that estimates maximum possible token usage (current tokens + maxOutputTokens × estimated steps) and warns or triggers compaction proactively.

---

### C14 — `modelMessages` Type is `any[]` — No Validation

**Design uses `any[]` throughout for messages.** The actual `Generation.modelMessages` is typed as `any[]` too. There is no schema validation when:
1. Messages enter the compaction engine
2. Compacted messages are written back to storage
3. Continuation messages are created

**Impact:** Silent corruption. If the compaction engine produces malformed messages (e.g., missing `role`, wrong content structure), the error won't surface until the next `streamText` call, making it hard to diagnose.

**Fix Required:** Define a minimal `CompactionMessage` interface:
```typescript
interface CompactionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
}
```
Validate inputs and outputs at the engine boundary.

---

### C15 — No Persistence of Compaction State

**Design states:** "Session-only storage (cleared when VSCode closes)" — inherited from `ChatStateStorage`.

But the design has **no metadata tracking** for compactions:
- No record that compaction occurred (for debugging/audit)
- No original message count preserved
- No summary version tracking
- If re-compaction loops, no history of intermediate summaries
- If the summary is poor quality, there's no way to detect or recover (original messages are deleted)

**Fix Required:** Store compaction metadata as part of the generation model:
```typescript
interface CompactionMetadata {
  compactedAt: number;
  originalMessageCount: number;
  originalTokenEstimate: number;
  compactedTokenEstimate: number;
  retries: number;
  mode: 'auto' | 'manual';
}
```

---

## 2. Moderate Issues (P1)

### M01 — `/compact` Command Handler Location is Wrong — **RESOLVED**

**Design proposes (Section 6.2.3):** ~~Adding `/compact` handling in a `chat-handler.ts`.~~

**Fix Applied:** Section 6.2.3 redesigned to use the existing 4-layer RPC pattern:
1. `CompactConversationRequest`/`CompactConversationResponse` interfaces in `ballerina-core`
2. `compactConversation` RPC type following the `RequestType` pattern
3. `AIPanelAPI` interface extended with `compactConversation` method
4. `AiPanelRpcClient` client method for webview-side calls
5. Handler registration in `rpc-handler.ts` and implementation in `rpc-manager.ts`
6. Optional: `/compact` added to `Command` enum for UI autocomplete

---

### M02 — `getAnthropicClient` Used Without Auth Context — **RESOLVED**

**Design Section 6.2.1:** ~~`getAnthropicClient('claude-sonnet-4-5-20250929')` called independently in summarization callback.~~

**Fix Applied:** The `CompactionManager` no longer calls `getAnthropicClient` itself. Instead:
1. `CompactionEngineConfig.summarizationCallback` is now optional — not set at construction time
2. `CompactionEngine` exposes `setSummarizationCallback()` and `hasSummarizationCallback()` methods
3. `CompactionManager.bindModel(model: LanguageModel)` accepts a resolved model instance and wires up the summarization callback
4. **Auto-compact (AgentExecutor):** The model is resolved once via `await getAnthropicClient(ANTHROPIC_SONNET_4)`, then passed to both `compactionManager.bindModel(model)` and `streamText({ model, ... })` — same instance, same auth, same provider-specific model ID
5. **Manual compact (rpc-manager):** Resolves `await getAnthropicClient(ANTHROPIC_SONNET_4)` and passes directly to `compactionManager.manualCompact(..., model, ...)`
6. `compact()` validates that a summarization callback is bound before proceeding

---

### M03 — Re-compaction Loop Can Produce Empty Summaries — **RESOLVED**

**Design Section 5.1:**
```typescript
if (compactedTokens >= threshold && retryCount < maxRetries) {
  return await this.compactWithRetry(compactedMessages, options, retryCount + 1);
}
```

On retry, `compactedMessages` is just 2 messages (user + assistant with summary). Asking an LLM to summarize a 2-message conversation that is *itself a summary* will produce progressively degraded output. By retry 3, the summary may be incoherent.

**Fix Required:** If the compacted messages are still above threshold after a single compaction, it likely means the summary itself is too long. Instead of re-summarizing, truncate the summary or use a more aggressive summarization prompt with a token limit.

**Resolution:**
Two changes made to eliminate summary degradation:
1. **`compactWithRetry` now always retries from the original messages**, not the compacted output. On retry, a `targetTokenBudget` (50% of threshold) is computed and passed through to the summarization service.
2. **`SummarizationService.summarize()` accepts an optional `targetTokenBudget`** parameter. When set, a "Token Budget Constraint" section is appended to the system prompt instructing the LLM to focus only on critical information (active tasks, key decisions, recent code changes, unresolved errors) and omit completed tasks and intermediate steps.

This ensures retries always work from the full original conversation history with progressively stricter budget guidance, rather than re-summarizing an already-degraded summary.

---

### M04 — No Handling of Provider-Specific Token Limits — **RESOLVED**

**Design hardcodes:** `maxContextWindow: 200_000` (Claude-specific).

**Actual code:** Supports multiple providers:
- Anthropic direct (via `createAnthropic`)
- AWS Bedrock (via `createAmazonBedrock`)
- Google Vertex AI (via `createVertexAnthropic`)

Each provider may have different context window sizes, even for the same underlying model. Bedrock may restrict context windows or have different limits.

**Fix Required:** `ModelConfig` should be resolved dynamically based on the active provider, not hardcoded.

**Resolution:** Already addressed by the M02 `bindModel()` fix and the existing `ModelConfig` architecture:
1. `ModelConfig` is passed to `CompactionEngineConfig` at construction time — the integrator (e.g., `CompactionManager`) controls these values and can set provider-specific context windows
2. The `bindModel()` pattern means the compaction engine never resolves the provider itself — the caller (AgentExecutor / rpc-manager) resolves the model and knows which provider is active
3. If a future integrator needs different context windows (e.g., Bedrock with 100K), they simply pass a different `ModelConfig` when constructing the `CompactionEngine`
4. Design doc section 8.4 updated to reflect this resolution

---

### M05 — Missing Concurrency Between Summarization and User Actions — **RESOLVED**

The `isCompacting` guard prevents concurrent compactions. But it doesn't prevent:
- User aborting mid-compaction (the AbortController from the current execution isn't passed to the summarization call)
- User starting a new message while compaction is in progress (the storage would be in an inconsistent state)

**Fix Required:** 
1. Pass the user's `AbortController` signal to the summarization `generateText` call
2. Block new message submissions while compaction is in progress (UI-side indicator)

**Resolution:**
Most concurrency is already handled by existing controls:
- **UI-side:** `isLoading` state disables send button during generation — users can't send another message while auto-compaction runs (it executes within the same `AgentExecutor.execute()` flow)
- **Backend-side:** `setActiveExecution()` guarantees one execution per thread; auto-abort of previous execution on same thread

Changes made to close the remaining gaps:
1. `SummarizationCallback` type now accepts an optional `abortSignal` parameter
2. `CompactionOptions` now includes `abortSignal?: AbortSignal`
3. `bindModel()` callback forwards the `abortSignal` to `generateText()`
4. Signal threaded through: `checkAndCompact(abortSignal)` → `engine.compact(options.abortSignal)` → `compactWithRetry` → `summarize(abortSignal)` → `callback(abortSignal)`
5. `AgentExecutor` passes `this.config.abortController.signal` to `checkAndCompact()`
6. Manual compact RPC handler checks `chatStateStorage.getActiveExecution()` and rejects if a generation is in progress

---

### M06 — `@wso2/copilot-utilities` Package Has No `peerDependencies` — **RESOLVED**

**Design Section 2.1:**
```json
{
  "peerDependencies": {},
  "dependencies": {}
}
```

The package uses `any[]` for messages, which is fine. But the summarization prompt and continuation message format are tightly coupled to:
- Vercel AI SDK's `ModelMessage` format
- Anthropic's `<summary>` tag parsing expectations

These implicit couplings are not version-guarded. If Vercel AI SDK changes `ModelMessage` structure, the compaction engine silently breaks.

**Fix Required:** Document supported Vercel AI SDK version ranges in README, even if not enforced as `peerDependencies`.

**Resolution:** Added a `README.md` to the package structure and a "SDK Compatibility" section in the design doc (Section 2.2) documenting:
- Tested Vercel AI SDK version (`ai@^6.0.0`)
- Expected message format (`{ role, content }` with `ModelMessage` structure)
- `SummarizationCallback` contract for integrators
- Note that updating the `ai` package requires verifying message format compatibility

---

### M07 — Thread-level History Concatenation Loses Generation Boundaries — **RESOLVED**

`getChatHistoryForLLM` flattens all generations' `modelMessages` into one array. After compaction replaces this with 2 messages (user + assistant), the **generation boundary information is permanently lost**. This means:
- Checkpoint restore can't work (checkpoints are per-generation)
- Review state per-generation becomes meaningless
- Undo functionality breaks

**Fix Required:** Compaction must either:
(a) Preserve a "compacted generation" marker that replaces multiple old generations, OR  
(b) Only compact fully-accepted/closed generations, never pending-review ones, OR  
(c) Document that compaction clears all checkpoint/undo history (with user warning)

**Resolution:** Applied options (a) + file-based backup:
1. **Pre-compaction backup:** Before clearing generations, `backupPreCompactionHistory()` saves the full thread state (all generations with their messages) to `.ballerina/copilot/compaction-backups/<threadId>-<timestamp>.json`. This allows manual recovery if needed.
2. **Compacted generation marker:** The synthetic generation's metadata includes:
   - `isCompactedGeneration: true` — flag for UI/logic to detect compacted history
   - `compactedGenerationIds: string[]` — IDs of all generations that were replaced
   - `backupPath: string` — path to the backup file
3. `CompactionMetadata` extended with `backupPath` and `compactedGenerationIds` fields
4. `replaceThreadHistory` is now async to support file I/O

---

### M08 — Design Ignores Existing Compiled Compaction Artifacts — **RESOLVED**

**Finding:** The compiled `dist/extension.js` for Ballerina already contains symbols: `createNativeCompactionConfig`, `NATIVE_COMPACTION_TRIGGER`, `NATIVE_COMPACTION_INSTRUCTIONS`, `isCompactionPart`, `finalizeCompactionSummary`, `detectAndLogCompaction`, `isReceivingCompactionSummary`, `compactionSummaryBuffer`.

**Impact:** This suggests compaction was partially implemented on another branch and compiled. The design doesn't acknowledge or build on this prior work. When the new implementation ships, there may be conflicts with stale compiled artifacts.

**Fix Required:** Investigate the origin of these symbols. If they're from a prior attempt, either build on that work or ensure it's fully removed before introducing the new system.

**Resolution:** Confirmed these are stale artifacts from a previous attempt:
- No source `.ts` files contain any of these symbols — they exist only in compiled `out/` and `dist/` directories
- Both `out/` and `dist/` are gitignored (not tracked in version control)
- Deleted the stale `out/` and `dist/` directories; a clean rebuild will not regenerate them
- The new compaction design uses a completely different architecture (`@wso2/copilot-utilities/compaction` shared package) and does not conflict

---

## 3. Minor Issues (P2)

### L01 — Version Policy Not Specified — **RESOLVED**

The rush.json entry in the design doesn't include `versionPolicyName`. Looking at existing common-libs packages:
- `@wso2/font-wso2-vscode` uses policy `font-wso2-vscode`
- `@wso2/service-designer` uses policy `service-designer`
- `@wso2/ui-toolkit` uses policy `ui-toolkit`

**Fix:** Add an appropriate `versionPolicyName` to the rush.json entry.

**Resolution:** Added `"versionPolicyName": "copilot-utilities"` to the rush.json entry, following the existing pattern.

---

### L02 — Package `exports` Field Uses Source Path — **RESOLVED**

```json
{ "exports": { "./compaction": "./compaction/src/index.ts" } }
```

Exporting `.ts` source files requires consumers to have TypeScript compilation set up for node_modules. This works in a Rush monorepo with project references but should be verified against the repo's build chain.

**Resolution:** Changed exports to `./compaction/lib/index.js` (compiled output). Added `main`, `types`, and `scripts` (build/test) fields to package.json.

---

### L03 — Missing Test Strategy — **RESOLVED**

The design mentions `tests/unit/` and `tests/integration/` directories but provides zero test specifications. For a red team analysis, the absence of test design means:
- No way to verify threshold logic correctness
- No way to verify summarization prompt produces parseable output
- No regression testing for API mismatches

**Resolution:** Added Section 5.4 with full test specifications including:
- 6 unit test files covering ThresholdCalculator, TokenEstimator, SummarizationService, messageUtils, messagePreparation, and CompactionEngine
- 2 integration test files for end-to-end flow and abort handling
- Test utilities (mock callbacks, fixture messages)
- Example test code for ThresholdCalculator and concurrency guard

---

### L04 — `CompactionStateManager` is Trivially Simple — **RESOLVED**

`CompactionStateManager` is a class with a single method that returns two static messages. This is over-engineering — it should be a utility function, not a class. The name "StateManager" implies it manages state, but it manages nothing.

**Resolution:** Replaced `CompactionStateManager` class with a plain `createContinuationMessages()` utility function. Removed the class from `CompactionEngine` (no more `this.stateManager`). File renamed from `CompactionStateManager.ts` to `messageUtils.ts` in the package structure.

---

### L05 — Design Doc Versioning Inconsistency — **RESOLVED**

All 4 versions are dated `2026-03-06` (same day), which suggests rapid iteration but makes it hard to trace which version specific reviewers approved.

**Resolution:** Rounds 3 and 4 (moderate + minor fixes) are dated `2026-03-09` to reflect when they were actually applied.

---

### L06 — `warningThreshold` Is Defined But Never Used — **RESOLVED**

`ThresholdCalculator` has `isAboveWarningThreshold()` but it's never called anywhere in the design. No UI warning is designed for approaching the compaction threshold.

**Resolution:** Removed `warningThreshold` from `ModelConfig` interface, `DEFAULT_CONFIG`, and the `CompactionManager` constructor config. Removed `isAboveWarningThreshold()` method from `ThresholdCalculator`.

---

## 4. Redundancies

| # | Redundancy | Detail |
|---|-----------|--------|
| R01 | `CompactionStateManager` class | Contains only `createContinuationMessages()` — should be a plain function in `messagePreparation.ts` |
| R02 | Dual threshold check | `getAutoCompactThreshold()` and `isAboveAutoCompactThreshold()` do the same comparison; one is sufficient |
| R03 | `SummarizationService` class | Wraps a single callback with message prep. Could be a function in `CompactionEngine` |
| R04 | `clearCache()` after every compaction | If the compaction replaces all messages, the old cache entries will never be looked up anyway (new messages have different hashes). The explicit `clearCache()` is unnecessary if the cache uses content-based keys |
| R05 | Token counting for re-compaction check | After compaction, the result is 2 short messages. Checking if `compactedTokens >= threshold` for 2 messages will virtually never be true. The re-compaction loop is engineering for a scenario that can't realistically occur unless the summary itself is 150K+ tokens |

---

## 5. Summary Matrix

| ID | Severity | Category | Status |
|----|----------|----------|--------|
| C01 | **Critical** | API Mismatch | `getChatHistory`/`setChatHistory` don't exist |
| C02 | **Critical** | Config Mismatch | `maxOutputTokens` 20K vs actual 8192 |
| C03 | **Critical** | Token Estimation | System prompt excluded from count |
| C04 | **Critical** | Token Estimation | `chars/4` inaccurate for tool-heavy messages |
| C05 | **Critical** | Data Model | Tool call/result messages not handled in summarization prep |
| C06 | **Critical** | Data Model | Original system prompt conflicts with summarization system prompt |
| C07 | **Critical** | Architecture | Compaction timing + generation model mismatch |
| C08 | **Critical** | Architecture | MI integration section designs against non-existent code |
| C09 | **Critical** | Context Loss | No project state preservation after compaction |
| C10 | **Critical** | Error Handling | Summarization failure kills the user's request |
| C11 | **Critical** | Cost/Latency | `<analysis>` thinking in summarization wastes tokens |
| C12 | **Critical** | Correctness | Hash function causes cache collisions |
| C13 | **Critical** | Architecture | No mid-turn context overflow protection |
| C14 | **Critical** | Data Integrity | No message validation at engine boundary |
| C15 | **Critical** | Observability | No compaction metadata/audit trail |
| M01 | Moderate | Integration | **RESOLVED** — Redesigned as 4-layer RPC pattern |
| M02 | Moderate | Auth/Security | **RESOLVED** — Model instance reused via `bindModel()` |
| M03 | Moderate | Logic | **RESOLVED** — Budget-aware retry from original messages |
| M04 | Moderate | Config | **RESOLVED** — Covered by M02 `bindModel()` + configurable `ModelConfig` |
| M05 | Moderate | Concurrency | **RESOLVED** — AbortSignal threaded through + active execution guard |
| M06 | Moderate | Coupling | **RESOLVED** — SDK compatibility documented in README |
| M07 | Moderate | Data Loss | **RESOLVED** — Pre-compaction backup + compacted generation marker |
| M08 | Moderate | Conflict | **RESOLVED** — Stale compiled artifacts deleted; no source files affected |
| L01 | Minor | Config | **RESOLVED** — Added `versionPolicyName` |
| L02 | Minor | Build | **RESOLVED** — Exports use compiled path |
| L03 | Minor | Testing | **RESOLVED** — Test specifications added |
| L04 | Minor | Design | **RESOLVED** — Replaced class with utility function |
| L05 | Minor | Process | **RESOLVED** — Dates corrected |
| L06 | Minor | Dead Code | **RESOLVED** — `warningThreshold` removed |

---

## 6. Recommended Next Steps

### Phase 1: Fix Critical API Alignment
1. Map the **exact** `ChatStateStorage` API and design compaction to work with the generation-based model
2. Source `maxOutputTokens` and model configuration from existing constants
3. Include system prompt tokens in the estimation budget

### Phase 2: Fix Token Estimation
4. Evaluate using `usage.inputTokens` from the last `streamText` response as the ground-truth token count (free, accurate)
5. Design a hybrid approach: use actual `inputTokens` from the last turn as the running total, falling back to char estimation only when no prior usage data exists

### Phase 3: Fix Message Handling
6. Design proper `prepareMessagesForSummarization` that handles all `ModelMessage` content types (tool calls, tool results, thinking blocks, images, system prompts)
7. Design post-compaction context that preserves actionable project state (modified files, working directory)

### Phase 4: Fix Architecture
8. Resolve MI integration — determine actual MI agent-mode architecture before designing integration
9. Design compaction timing relative to the generation lifecycle
10. Add graceful degradation for compaction failures

### Phase 5: Revise Design Document
11. Update all code examples to use real API signatures
12. Add test specifications
13. Document limitations and known constraints
14. Remove redundant abstractions

---

*End of Red Team Analysis*
