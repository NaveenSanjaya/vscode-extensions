# Copilot Context Compaction System - Design Document

**Version:** 3.0.1
**Target:** Ballerina Copilot (Primary), MI Copilot (Secondary)
**Branch:** `feature/copilot-context-compaction`
**Date:** 2026-03-06

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Token Management](#3-token-management)
4. [Compaction Process](#4-compaction-process)
5. [Component Implementation](#5-component-implementation)
6. [Integration Guide](#6-integration-guide)
7. [Configuration](#7-configuration)
8. [Limitations and Known Constraints](#8-limitations-and-known-constraints)
9. [Mid-Stream Compaction](#9-mid-stream-compaction)
10. [Context Usage Widget](#10-context-usage-widget)

---

## 1. Overview

### 1.1 Goals

- Create pluggable compaction library for Ballerina and MI copilots
- Automatic context compaction using LLM-based summarization
- Provider-agnostic token counting (works with Vercel AI SDK)
- Manual compaction with custom instructions

### 1.2 Current State

**Ballerina:** No context window management (fails on long conversations)
- Uses Vercel AI SDK (`ai` package) with `@ai-sdk/anthropic`
- Messages stored in `chatStateStorage` as `ModelMessage[]`
- Agent uses `streamText` with tools

**MI:** Simple sliding window (last 6 messages, no summarization)

### 1.3 Solution

**Package:** `@wso2/copilot-utilities/compaction`
**Location:** `/workspaces/common-libs/copilot-utilities/compaction/`
**Dependencies:** NONE (provider-agnostic, uses callbacks)

---

## 2. Architecture

### 2.1 Package Structure

```
/workspaces/common-libs/copilot-utilities/
├── package.json                          # @wso2/copilot-utilities
├── README.md                             # SDK compatibility & usage docs (M06)
├── compaction/                           # Compaction module
│   ├── src/
│   │   ├── index.ts                      # Public API exports
│   │   ├── CompactionEngine.ts           # Main orchestrator
│   │   ├── core/
│   │   │   ├── TokenEstimator.ts         # Token counting (callback-based)
│   │   │   ├── ThresholdCalculator.ts    # Threshold logic
│   │   │   ├── SummarizationService.ts   # LLM summarization
│   │   │   └── messageUtils.ts           # Continuation message builder (L04)
│   │   ├── config/
│   │   │   └── defaults.ts               # Default configuration
│   │   ├── prompts/
│   │   │   └── summarizationPrompt.ts    # Summary template
│   │   ├── types/
│   │   │   └── index.ts                  # All interfaces
│   │   └── utils/
│   │       └── messagePreparation.ts     # Message utilities
│   └── tests/
│       ├── unit/
│       └── integration/
└── session-memory/                       # (Future)
```

**package.json:**
```json
{
  "name": "@wso2/copilot-utilities",
  "version": "1.0.0",
  "main": "compaction/lib/index.js",
  "types": "compaction/lib/index.d.ts",
  "exports": {
    "./compaction": "./compaction/lib/index.js"
  },
  "scripts": {
    "build": "tsc -b compaction",
    "test": "jest --config compaction/tests/jest.config.js"
  },
  "peerDependencies": {},
  "dependencies": {}
}
```

### 2.2 SDK Compatibility (M06)

The compaction engine is **provider-agnostic** — it receives an LLM summarization function via callback and does not depend on any SDK directly. However, integrators must be aware of implicit coupling:

**Tested with:**
- `ai` (Vercel AI SDK): `^6.0.0` (currently `6.0.103` in `ballerina-extension`)
- Message format: `{ role: 'user' | 'assistant' | 'system' | 'tool', content: string | ContentPart[] }`

**Integrator contract:**
- The `SummarizationCallback` receives prepared messages (system messages stripped, tool messages converted to text, images replaced with placeholders) and a system prompt string. It returns the raw LLM response text.
- The `TokenCountCallback` receives an array of messages and returns an estimated token count.
- Both callbacks are SDK-version-dependent — if the Vercel AI SDK changes `ModelMessage` structure, the callbacks may need updating.

**When upgrading the `ai` package:**
1. Verify `ModelMessage` format hasn't changed (role + content structure)
2. Verify `generateText()` / `streamText()` API compatibility
3. Run compaction integration tests

**README.md** in the package root should include this compatibility information for contributors.

**Rush Configuration:**

Add to `rush.json`:
```json
{
  "packageName": "@wso2/copilot-utilities",
  "projectFolder": "workspaces/common-libs/copilot-utilities",
  "reviewCategory": "production",
  "versionPolicyName": "copilot-utilities"
}
```

### 2.3 Component Architecture

```
CompactionEngine (Main API)
    ├── TokenEstimator (callback-based, provider-agnostic)
    ├── ThresholdCalculator (configurable thresholds)
    ├── SummarizationService (LLM summarization via callback)
    └── CompactionStateManager → createContinuationMessages() utility (L04)
```

---

## 3. Token Management

### 3.1 Strategy

**Hybrid token counting with actual usage tracking:**
- Use `usage.inputTokens` from last `streamText` response as ground truth (most accurate, free)
- Fall back to callback-based estimation for new messages not yet processed
- Include system prompt and tool definitions in token budget
- Caching to avoid redundant calculations
- Provider-agnostic (shared library has no SDK dependencies)

### 3.2 TokenEstimator Implementation

```typescript
/**
 * Token counting callback - provided by the integrating copilot
 * Can be sync (char estimation) or async (API call)
 */
export type TokenCountCallback = (messages: any[]) => Promise<number> | number;

/**
 * Context information for accurate token estimation
 */
export interface TokenEstimationContext {
  lastActualInputTokens?: number;     // From last streamText usage.inputTokens
  systemPromptTokenEstimate?: number; // Estimated tokens for system prompt
  toolDefinitionsTokenEstimate?: number; // Estimated tokens for tool definitions
}

interface CachedMessage {
  message: any;
  tokenCount: number;
  contentHash: string;
}

class TokenEstimator {
  private cache: Map<string, CachedMessage> = new Map();
  private tokenCountCallback: TokenCountCallback;
  private lastContext: TokenEstimationContext | null = null;

  constructor(tokenCountCallback: TokenCountCallback) {
    this.tokenCountCallback = tokenCountCallback;
  }

  /**
   * Update estimation context with actual usage data
   * Call this after each streamText response to improve accuracy
   */
  updateContext(context: TokenEstimationContext): void {
    this.lastContext = context;
  }

  /**
   * Estimate total token count for message history
   * Uses hybrid approach: actual usage data + callback + caching
   * Includes system prompt and tool definitions in estimate
   */
  async estimateTokens(messages: any[]): Promise<number> {
    // If we have actual usage data from the last turn, use it as baseline
    if (this.lastContext?.lastActualInputTokens) {
      // The actual input tokens already include messages + system + tools
      // This is the most accurate baseline
      return this.lastContext.lastActualInputTokens;
    }

    // Otherwise, estimate using callback
    const messageTokens = await this.estimateMessageTokens(messages);

    // Add system prompt and tool definition estimates
    const systemTokens = this.lastContext?.systemPromptTokenEstimate || 0;
    const toolTokens = this.lastContext?.toolDefinitionsTokenEstimate || 0;

    return messageTokens + systemTokens + toolTokens;
  }

  /**
   * Estimate tokens for messages only (excluding system/tools)
   */
  private async estimateMessageTokens(messages: any[]): Promise<number> {
    // Check if all messages are cached
    const allCached = messages.every(msg => {
      const hash = this.hashContent(msg);
      const cached = this.cache.get(hash);
      return cached && cached.contentHash === hash;
    });

    if (allCached) {
      // Fast path: all cached
      return messages.reduce((total, msg) => {
        const hash = this.hashContent(msg);
        return total + (this.cache.get(hash)?.tokenCount || 0);
      }, 0);
    }

    // Slow path: call the callback (might be async)
    const totalTokens = await this.tokenCountCallback(messages);

    // Cache individual message estimates (approximate distribution)
    if (messages.length > 0) {
      const avgPerMessage = totalTokens / messages.length;
      messages.forEach(msg => {
        const hash = this.hashContent(msg);
        if (!this.cache.has(hash)) {
          this.cache.set(hash, {
            message: msg,
            tokenCount: Math.ceil(avgPerMessage),
            contentHash: hash,
          });
        }
      });
    }

    return totalTokens;
  }

  /**
   * Clear cache (call after compaction)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * SHA-256 hash for cache invalidation
   * Using crypto.createHash to avoid collisions
   */
  private hashContent(message: any): string {
    const crypto = require('crypto');
    const str = JSON.stringify(message);
    return crypto.createHash('sha256').update(str).digest('hex');
  }
}
```

### 3.3 ThresholdCalculator Implementation

```typescript
interface ModelConfig {
  maxContextWindow: number;      // 200,000 tokens
  maxOutputTokens: number;        // 8,192 tokens (MUST match AgentExecutor.ts streamText config)
  autoCompactBuffer: number;      // 13,000 tokens
}

// CRITICAL: maxOutputTokens MUST match the value in AgentExecutor.ts streamText call
// If AgentExecutor changes maxOutputTokens, this MUST be updated accordingly
const DEFAULT_CONFIG: ModelConfig = {
  maxContextWindow: 200_000,
  maxOutputTokens: 8_192,  // Matches AgentExecutor.ts:215
  autoCompactBuffer: 13_000,
};

class ThresholdCalculator {
  private config: ModelConfig;

  constructor(config: ModelConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  getAutoCompactThreshold(): number {
    const effectiveWindow = this.config.maxContextWindow - this.config.maxOutputTokens;
    return effectiveWindow - this.config.autoCompactBuffer; // 167,000
  }

  isAboveAutoCompactThreshold(tokenCount: number): boolean {
    return tokenCount >= this.getAutoCompactThreshold();
  }
}
```

---

## 4. Compaction Process

### 4.1 Trigger Mechanisms

**Automatic:** After every assistant response, check if tokens >= threshold
**Manual:** User invokes `/compact` or `/compact <custom instructions>`

```typescript
// Automatic
async function afterAssistantResponse(messages: any[]): Promise<void> {
  const tokenCount = await tokenEstimator.estimateTokens(messages);
  if (tokenCount >= thresholdCalculator.getAutoCompactThreshold()) {
    await triggerCompaction(messages, { mode: 'auto' });
  }
}

// Manual
async function handleManualCompact(messages: any[], userInstructions?: string): Promise<void> {
  await triggerCompaction(messages, { mode: 'manual', customInstructions: userInstructions });
}
```

### 4.2 Compaction Lifecycle

1. **Pre-compaction:** Validate messages, fire hooks
2. **Summarization:**
   - Prepare messages (strip thinking blocks, replace images)
   - Call LLM with summary prompt + custom instructions
   - Parse `<summary>...</summary>` from response
3. **Continuation Structure:** Create valid message sequence (user + assistant)
4. **Post-compaction Context:** Re-attach recent files, session memory
5. **History Replacement:** Replace old messages with compacted version
6. **Re-compaction Check:** If still above threshold, mark for retry (max 3 attempts)

### 4.3 Summarization Prompt

```typescript
export const SUMMARIZATION_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first. If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>

IMPORTANT: Do NOT use any tools. You MUST respond with ONLY the <summary>...</summary> block as your text output.
`;
```

### 4.4 Continuation Message Structure (Fixed)

**Problem:** Assistant message as first message is invalid for LLM APIs.

**Solution:** Create a valid user-assistant sequence:

```typescript
function createContinuationMessages(summary: string): any[] {
  // User message requesting continuation
  const userMessage = {
    role: 'user',
    content: '[Context restored from previous conversation - conversation history has been compacted to manage token limits. Continue from the summary below.]',
  };

  // Assistant message with summary
  const assistantMessage = {
    role: 'assistant',
    content: `This session is being continued from a previous conversation. Below is a summary of what was discussed and accomplished:

---

${summary}

---

I'm ready to continue our work. What would you like to do next?`,
  };

  return [userMessage, assistantMessage];
}
```

---

## 5. Component Implementation

### 5.1 CompactionEngine (Main API)

```typescript
/**
 * LLM summarization callback - provided by integrating copilot
 * @param messages - Conversation history to summarize
 * @param systemPrompt - System prompt with summarization instructions
 */
export type SummarizationCallback = (
  messages: any[],
  systemPrompt: string,
  abortSignal?: AbortSignal   // M05: Allow caller to cancel summarization LLM call
) => Promise<string>;

export interface CompactionEngineConfig {
  modelConfig: ModelConfig;
  tokenCountCallback: TokenCountCallback;
  summarizationCallback?: SummarizationCallback;  // M02: Optional — set via setSummarizationCallback()
}

export interface CompactionOptions {
  mode: 'auto' | 'manual';
  customInstructions?: string;
  maxRetries?: number; // Default: 3
  projectState?: ProjectStateContext;  // C09: Project state to preserve
  abortSignal?: AbortSignal;           // M05: Propagate abort to summarization LLM call
}

/**
 * Compaction metadata for audit trail (C15 fix)
 */
export interface CompactionMetadata {
  compactedAt: number;                 // Timestamp
  originalMessageCount: number;        // Count before compaction
  originalTokenEstimate: number;       // Tokens before compaction
  compactedTokenEstimate: number;      // Tokens after compaction
  retries: number;                     // Number of retry attempts
  mode: 'auto' | 'manual';            // Compaction mode
  userInstructions?: string;           // Custom instructions if provided
  backupPath?: string;                 // M07: Path to pre-compaction backup file
  compactedGenerationIds?: string[];   // M07: IDs of generations that were compacted
}

/**
 * Project state context to preserve after compaction (C09 fix)
 */
export interface ProjectStateContext {
  modifiedFiles?: string[];           // List of files that have been modified
  tempProjectPath?: string;           // Temporary project path for agent
  pendingReviewFiles?: string[];      // Files pending review
  workingDirectory?: string;          // Current working directory
}

export interface CompactionResult {
  success: boolean;
  originalTokens: number;
  compactedTokens: number;
  reductionPercentage: number;
  compactedMessages: any[];
  summary: string;
  retriesUsed: number;
  metadata?: CompactionMetadata;      // C15: Compaction metadata
}

export class CompactionEngine {
  private tokenEstimator: TokenEstimator;
  private thresholdCalculator: ThresholdCalculator;
  private summarizationService: SummarizationService | null;
  private config: CompactionEngineConfig;
  private isCompacting: boolean = false; // Concurrency guard

  constructor(config: CompactionEngineConfig) {
    this.config = config;
    this.tokenEstimator = new TokenEstimator(config.tokenCountCallback);
    this.thresholdCalculator = new ThresholdCalculator(config.modelConfig);
    this.summarizationService = config.summarizationCallback
      ? new SummarizationService(config.summarizationCallback)
      : null; // M02: Deferred — set via setSummarizationCallback()
  }

  /**
   * M02: Set or update the summarization callback.
   * Called by the integrating copilot to bind the model instance BEFORE compact().
   * This keeps the compaction engine provider-agnostic while allowing the caller
   * to reuse its already-authenticated model instance.
   */
  setSummarizationCallback(callback: SummarizationCallback): void {
    this.summarizationService = new SummarizationService(callback);
  }

  /**
   * M02: Check if a summarization callback has been bound.
   */
  hasSummarizationCallback(): boolean {
    return this.summarizationService !== null;
  }

  async shouldCompact(messages: any[]): Promise<boolean> {
    const tokenCount = await this.tokenEstimator.estimateTokens(messages);
    return this.thresholdCalculator.isAboveAutoCompactThreshold(tokenCount);
  }

  async getTokenStatus(messages: any[]) {
    const tokenCount = await this.tokenEstimator.estimateTokens(messages);
    const threshold = this.thresholdCalculator.getAutoCompactThreshold();
    return {
      currentTokens: tokenCount,
      threshold,
      percentageUsed: (tokenCount / threshold) * 100,
      isAboveThreshold: tokenCount >= threshold,
    };
  }

  async compact(messages: any[], options: CompactionOptions): Promise<CompactionResult> {
    // Concurrency guard
    if (this.isCompacting) {
      throw new Error('Compaction already in progress');
    }

    this.isCompacting = true;

    try {
      // M02: Verify summarization callback is bound before compacting
      if (!this.summarizationService) {
        throw new Error('Summarization callback not set. Call setSummarizationCallback() before compact().');
      }

      // C14: Validate messages at engine boundary
      this.validateMessages(messages);

      return await this.compactWithRetry(messages, options, 0);
    } catch (error) {
      // C10: Graceful degradation on compaction failure
      console.error('[Compaction] Failed:', error);

      // Return failure result instead of throwing
      // This allows the caller to decide whether to continue without compaction
      return {
        success: false,
        originalTokens: await this.tokenEstimator.estimateTokens(messages),
        compactedTokens: 0,
        reductionPercentage: 0,
        compactedMessages: messages, // Return original messages
        summary: '',
        retriesUsed: 0,
        metadata: {
          compactedAt: Date.now(),
          originalMessageCount: messages.length,
          originalTokenEstimate: await this.tokenEstimator.estimateTokens(messages),
          compactedTokenEstimate: 0,
          retries: 0,
          mode: options.mode,
          userInstructions: options.customInstructions,
        },
      };
    } finally {
      this.isCompacting = false;
    }
  }

  /**
   * C14: Validate messages at engine boundary
   */
  private validateMessages(messages: any[]): void {
    if (!Array.isArray(messages)) {
      throw new Error('Messages must be an array');
    }

    for (const msg of messages) {
      if (!msg.role || !['user', 'assistant', 'system', 'tool'].includes(msg.role)) {
        throw new Error(`Invalid message role: ${msg.role}`);
      }

      if (msg.content === undefined || msg.content === null) {
        throw new Error(`Message missing content property`);
      }
    }
  }

  private async compactWithRetry(
    messages: any[],
    options: CompactionOptions,
    retryCount: number
  ): Promise<CompactionResult> {
    const maxRetries = options.maxRetries ?? 3;
    const originalTokens = await this.tokenEstimator.estimateTokens(messages);
    const threshold = this.thresholdCalculator.getAutoCompactThreshold();

    // M03: On retry, re-summarize the ORIGINAL messages with a token budget
    // constraint — never re-summarize a summary, which degrades quality.
    // The targetTokenBudget tells the LLM to produce a shorter summary.
    const targetTokenBudget = retryCount > 0
      ? Math.floor(threshold * 0.5) // Aim for 50% of threshold on retries
      : undefined;

    // Summarize
    // M05: Forward abortSignal from options so user abort cancels the LLM call
    const summary = await this.summarizationService.summarize(
      messages,
      options.customInstructions,
      options.abortSignal,
      targetTokenBudget
    );

    // C09: Create continuation messages with project state
    const continuationMessages = createContinuationMessages(
      summary,
      options.projectState
    );

    // Build new message array
    const compactedMessages = [...continuationMessages];

    // Calculate new token count
    const compactedTokens = await this.tokenEstimator.estimateTokens(compactedMessages);
    const reductionPercentage = ((originalTokens - compactedTokens) / originalTokens) * 100;

    // M03: If still above threshold, retry with original messages + stricter budget.
    // Always retry from the original messages to avoid quality degradation.
    if (
      compactedTokens >= threshold &&
      retryCount < maxRetries
    ) {
      console.warn(
        `[Compaction] Summary still ${compactedTokens} tokens (threshold: ${threshold}). ` +
        `Re-summarizing original messages with tighter budget... (${retryCount + 1}/${maxRetries})`
      );
      // Retry with ORIGINAL messages, not compactedMessages
      return await this.compactWithRetry(messages, options, retryCount + 1);
    }

    // Clear cache for fresh start
    this.tokenEstimator.clearCache();

    // C15: Create compaction metadata for audit trail
    const metadata: CompactionMetadata = {
      compactedAt: Date.now(),
      originalMessageCount: messages.length,
      originalTokenEstimate: originalTokens,
      compactedTokenEstimate: compactedTokens,
      retries: retryCount,
      mode: options.mode,
      userInstructions: options.customInstructions,
    };

    return {
      success: true,
      originalTokens,
      compactedTokens,
      reductionPercentage,
      compactedMessages,
      summary,
      retriesUsed: retryCount,
      metadata,
    };
  }
}
```

### 5.2 SummarizationService

```typescript
class SummarizationService {
  constructor(private summarizationCallback: SummarizationCallback) {}

  async summarize(
    messages: any[],
    customInstructions?: string,
    abortSignal?: AbortSignal,
    targetTokenBudget?: number    // M03: Token budget for retry — tells the LLM to produce a shorter summary
  ): Promise<string> {
    // Prepare messages (strip thinking blocks, replace images)
    const preparedMessages = this.prepareMessagesForSummarization(messages);

    // Build system prompt
    let systemPrompt = SUMMARIZATION_PROMPT;
    if (customInstructions) {
      systemPrompt += `\n\n## Additional Summarization Instructions from User\n\n${customInstructions}\n`;
    }

    // M03: On retry, append a token budget constraint to the system prompt.
    // This guides the LLM to produce a more concise summary instead of
    // re-summarizing an already-summarized conversation.
    if (targetTokenBudget) {
      systemPrompt += `\n\n## Token Budget Constraint\n\nIMPORTANT: Your summary MUST be concise enough to fit within approximately ${targetTokenBudget} tokens. Focus only on the most critical information: active tasks, key decisions, recent code changes, and unresolved errors. Omit completed tasks, exploratory discussions, and intermediate steps that led to the final approach.\n`;
    }

    // M05: Forward abortSignal so the LLM call can be cancelled
    const response = await this.summarizationCallback(preparedMessages, systemPrompt, abortSignal);

    // Parse <summary>...</summary>
    const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/);
    if (!summaryMatch) throw new Error('No <summary> tags found in response');

    return summaryMatch[1].trim();
  }

  private prepareMessagesForSummarization(messages: any[]): any[] {
    return messages
      .filter(msg => msg.role !== 'system') // C06: Strip system prompts to avoid conflicts
      .map(msg => {
        // C05: Handle tool calls and tool results
        if (msg.role === 'tool') {
          // Convert tool result to text description
          return this.convertToolMessageToText(msg);
        }

        // Handle both string content and array of content blocks
        if (typeof msg.content === 'string') return msg;
        if (!Array.isArray(msg.content)) return msg;

        const filteredContent = msg.content
          .filter((block: any) => block.type !== 'thinking') // Strip thinking blocks
          .map((block: any) => {
            // C05: Handle tool-call parts in assistant messages
            if (block.type === 'tool-call') {
              return {
                type: 'text',
                text: `[Tool Call: ${block.toolName} with args ${JSON.stringify(block.args).substring(0, 100)}...]`
              };
            }
            // C05: Handle tool-result parts
            if (block.type === 'tool-result') {
              const resultStr = JSON.stringify(block.result);
              const truncated = resultStr.length > 500 ? resultStr.substring(0, 500) + '...' : resultStr;
              return {
                type: 'text',
                text: `[Tool Result: ${truncated}]`
              };
            }
            if (block.type === 'image') return { type: 'text', text: '[image]' };
            if (block.type === 'document') return { type: 'text', text: '[document]' };
            return block;
          });

        return { ...msg, content: filteredContent };
      });
  }

  private convertToolMessageToText(toolMsg: any): any {
    // Convert tool message to user message with text description
    const content = Array.isArray(toolMsg.content) ? toolMsg.content : [toolMsg.content];
    const textDescriptions = content.map((item: any) => {
      if (item.type === 'tool-result') {
        const resultStr = JSON.stringify(item.result);
        const truncated = resultStr.length > 1000 ? resultStr.substring(0, 1000) + '...' : resultStr;
        return `[Tool: ${item.toolName || 'unknown'} returned: ${truncated}]`;
      }
      return JSON.stringify(item).substring(0, 200);
    }).join('\n');

    return {
      role: 'user', // Convert to user role for valid message sequence
      content: textDescriptions
    };
  }
}
```

### 5.3 Continuation Message Builder (L04)

```typescript
// L04: Plain utility function instead of a class — no state to manage
function createContinuationMessages(summary: string, projectState?: ProjectStateContext): any[] {
    // Build project state context section
    let projectStateSection = '';
    if (projectState) {
      projectStateSection = '\n\n## Current Project State\n\n';

      if (projectState.tempProjectPath) {
        projectStateSection += `**Working Directory:** \`${projectState.tempProjectPath}\`\n\n`;
      }

      if (projectState.modifiedFiles && projectState.modifiedFiles.length > 0) {
        projectStateSection += `**Modified Files:**\n${projectState.modifiedFiles.map(f => `- \`${f}\``).join('\n')}\n\n`;
      }

      if (projectState.pendingReviewFiles && projectState.pendingReviewFiles.length > 0) {
        projectStateSection += `**Pending Review:**\n${projectState.pendingReviewFiles.map(f => `- \`${f}\``).join('\n')}\n\n`;
      }
    }

    return [
      {
        role: 'user',
        content: '[Context restored from previous conversation - conversation history has been compacted to manage token limits. Continue from the summary below.]',
      },
      {
        role: 'assistant',
        content: `This session is being continued from a previous conversation. Below is a summary of what was discussed and accomplished:

---

${summary}

---
${projectStateSection}
I'm ready to continue our work. What would you like to do next?`,
      },
    ];
  }
```

### 5.4 Test Specifications (L03)

**Unit Tests** (`compaction/tests/unit/`):

| Test File | Covers | Key Cases |
|-----------|--------|----------|
| `ThresholdCalculator.test.ts` | Threshold logic | Default config → 167K threshold; custom config; boundary values |
| `TokenEstimator.test.ts` | Token counting + caching | Callback invocation; SHA-256 cache hits/misses; `updateContext` |
| `SummarizationService.test.ts` | Summary parsing | Valid `<summary>` extraction; missing tags → error; custom instructions appended; token budget constraint appended on retry |
| `messageUtils.test.ts` | Continuation messages | User+assistant pair structure; project state sections; empty summary |
| `messagePreparation.test.ts` | Message prep | Strip system messages; convert tool-call/tool-result; replace images; strip thinking blocks |
| `CompactionEngine.test.ts` | Orchestration | `shouldCompact` true/false; `compact` success/failure; concurrency guard (`isCompacting`); retry with budget; abort signal propagation; message validation |

**Integration Tests** (`compaction/tests/integration/`):

| Test File | Covers | Key Cases |
|-----------|--------|----------|
| `compaction-flow.test.ts` | End-to-end flow | Mock `SummarizationCallback` → full compact cycle; token reduction verified; metadata populated; retry scenario |
| `abort-handling.test.ts` | Abort support | AbortController.abort() during summarization → AbortError propagated |

**Test Utilities:**
- Mock `TokenCountCallback`: returns `message.content.length / 4`
- Mock `SummarizationCallback`: returns `<summary>Mock summary</summary>`
- Fixture messages: representative user/assistant/tool conversations

```typescript
// Example: ThresholdCalculator test
describe('ThresholdCalculator', () => {
  it('should calculate correct threshold with default config', () => {
    const calc = new ThresholdCalculator();
    // 200_000 - 8_192 - 13_000 = 178_808
    expect(calc.getAutoCompactThreshold()).toBe(178_808);
  });

  it('should detect when above threshold', () => {
    const calc = new ThresholdCalculator();
    expect(calc.isAboveAutoCompactThreshold(180_000)).toBe(true);
    expect(calc.isAboveAutoCompactThreshold(100_000)).toBe(false);
  });

  it('should use custom config', () => {
    const calc = new ThresholdCalculator({
      maxContextWindow: 100_000,
      maxOutputTokens: 4_096,
      autoCompactBuffer: 10_000,
    });
    expect(calc.getAutoCompactThreshold()).toBe(85_904);
  });
});

// Example: CompactionEngine concurrency guard test
describe('CompactionEngine', () => {
  it('should reject concurrent compaction calls', async () => {
    const engine = createTestEngine();
    // Start a slow compaction
    const slow = engine.compact(longMessages, { mode: 'auto' });
    // Try concurrent compaction
    await expect(engine.compact(longMessages, { mode: 'auto' }))
      .rejects.toThrow('Compaction already in progress');
    await slow;
  });
});
```

---

## 6. Integration Guide

### 6.1 Installation

```bash
cd workspaces/ballerina/ballerina-extension
rush add -p @wso2/copilot-utilities
```

### 6.2 Ballerina Copilot Integration

**Integration Point:** `chatStateStorage` in [workspaces/ballerina/ballerina-extension/src/features/ai/agent/AgentExecutor.ts](file:///home/naveen/wso2/vscode-extensions/workspaces/ballerina/ballerina-extension/src/features/ai/agent/AgentExecutor.ts)

#### 6.2.1 Create Compaction Manager

`/workspaces/ballerina/ballerina-extension/src/features/ai/compaction-manager.ts`

**M02 Design Decision — Model Instance Reuse:**
`getAnthropicClient` handles complex multi-provider authentication (BI_INTEL, ANTHROPIC_KEY, AWS_BEDROCK, VERTEX_AI), caches providers, and maps model names to provider-specific IDs (e.g., Bedrock ARN-style `us.anthropic.claude-sonnet-4-20250514-v1:0`). Creating a separate model instance for summarization would:
- Double rate limit exposure from concurrent API consumers
- Risk duplicate token refreshes in `fetchWithAuth`
- Require duplicating provider-specific model ID resolution

Instead, the `CompactionManager` does **not** own a model instance. The resolved model is passed in at compact-time by the caller (AgentExecutor for auto-compact, rpc-manager for manual compact), ensuring the same authenticated, provider-resolved model is reused.

```typescript
import { CompactionEngine } from '@wso2/copilot-utilities/compaction';
import { generateText, LanguageModel, ModelMessage } from 'ai';
import { chatStateStorage } from './agent/chat-state-storage';

export class CompactionManager {
  private engine: CompactionEngine;

  constructor() {
    this.engine = new CompactionEngine({
      modelConfig: {
        maxContextWindow: 200_000,
        maxOutputTokens: 8_192,  // C02: Match AgentExecutor.ts:215
        autoCompactBuffer: 13_000,
      },
      // Token counting callback using character estimation (fallback only)
      tokenCountCallback: async (messages: ModelMessage[]) => {
        // Fast estimation: ~4 chars per token (used as fallback)
        const totalChars = messages.reduce((sum, msg) => {
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return sum + content.length;
        }, 0);
        return Math.ceil(totalChars / 4);
      },
      // M02: summarizationCallback is NOT set here — it is provided per-call
      // via setSummarizationCallback() before compact() is called.
      // This ensures the same authenticated model instance used by the agent is reused.
    });
  }

  /**
   * Expose the underlying CompactionEngine for use by CompactionGuard (Section 9).
   */
  getEngine(): CompactionEngine {
    return this.engine;
  }

  /**
   * C04: Update token estimation context with actual usage data
   * Call this after each streamText response
   */
  updateTokenContext(
    actualInputTokens: number,
    systemPromptEstimate: number,
    toolDefinitionsEstimate: number
  ): void {
    this.engine['tokenEstimator'].updateContext({
      lastActualInputTokens: actualInputTokens,
      systemPromptTokenEstimate: systemPromptEstimate,
      toolDefinitionsTokenEstimate: toolDefinitionsEstimate,
    });
  }

  /**
   * M02: Bind the summarization callback with the caller's model instance.
   * Must be called before checkAndCompact() or manualCompact().
   * This ensures the same authenticated, provider-resolved model is reused
   * for summarization — no separate getAnthropicClient() call.
   */
  bindModel(model: LanguageModel): void {
    this.engine.setSummarizationCallback(
      async (messages: ModelMessage[], systemPrompt: string, abortSignal?: AbortSignal) => {
        const result = await generateText({
          model,          // Reuses the caller's authenticated model instance
          system: systemPrompt,
          messages: messages,
          abortSignal,    // M05: Propagate abort — cancels the LLM call if user stops
        });
        return result.text;
      }
    );
  }

  async checkAndCompact(
    workspaceId: string,
    threadId: string,
    projectState?: ProjectStateContext,
    abortSignal?: AbortSignal           // M05: Pass through from caller's AbortController
  ): Promise<void> {
    // Get ALL messages from chatStateStorage (across all generations)
    const history = chatStateStorage.getChatHistoryForLLM(workspaceId, threadId);

    if (!history || history.length === 0) return;

    const shouldCompact = await this.engine.shouldCompact(history);

    if (!shouldCompact) return;

    // M02: Ensure bindModel() was called before reaching here
    if (!this.engine.hasSummarizationCallback()) {
      console.error('[Compaction] No model bound — call bindModel() before compaction');
      return;
    }

    // C09: Pass project state, C10: Handle failures gracefully
    // M05: Forward abortSignal so summarization LLM call can be cancelled
    const result = await this.engine.compact(history, {
      mode: 'auto',
      projectState,
      abortSignal,
    });

    // C10: Check if compaction succeeded
    if (!result.success) {
      console.warn('[Compaction] Auto-compaction failed, continuing with uncompacted history');
      return; // Continue without compaction
    }

    // Replace chatStateStorage: clear old generations, create new synthetic generation
    // M07: Now async — backs up pre-compaction history before replacing
    await this.replaceThreadHistory(workspaceId, threadId, result.compactedMessages, result.metadata);

    console.log(
      `[Compaction] ${result.originalTokens} → ${result.compactedTokens} tokens ` +
      `(${result.reductionPercentage.toFixed(1)}% reduction, ${result.retriesUsed} retries)`
    );
  }

  async manualCompact(
    workspaceId: string,
    threadId: string,
    model: LanguageModel,
    userInstructions?: string,
    projectState?: ProjectStateContext
  ): Promise<CompactionResult> {
    const history = chatStateStorage.getChatHistoryForLLM(workspaceId, threadId);

    if (!history || history.length === 0) {
      throw new Error('No conversation history to compact');
    }

    // M02: Bind the model for this manual compaction call
    this.bindModel(model);

    const result = await this.engine.compact(history, {
      mode: 'manual',
      customInstructions: userInstructions,
      projectState,
    });

    if (!result.success) {
      throw new Error('Manual compaction failed');
    }

    // M07: Now async — backs up pre-compaction history before replacing
    await this.replaceThreadHistory(workspaceId, threadId, result.compactedMessages, result.metadata);

    return result;
  }

  async getTokenStatus(workspaceId: string, threadId: string) {
    const history = chatStateStorage.getChatHistoryForLLM(workspaceId, threadId);
    if (!history) return null;
    return await this.engine.getTokenStatus(history);
  }

  /**
   * M07: Save pre-compaction history to a backup file.
   * Stored in `.ballerina/copilot/compaction-backups/` under the project directory
   * so users can recover the original conversation if needed.
   */
  private async backupPreCompactionHistory(
    workspaceId: string,
    threadId: string
  ): Promise<{ backupPath: string; generationIds: string[] }> {
    const thread = chatStateStorage.getOrCreateThread(workspaceId, threadId);
    const generationIds = thread.generations.map((g: any) => g.id);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(workspaceId, '.ballerina', 'copilot', 'compaction-backups');
    const backupPath = path.join(backupDir, `${threadId}-${timestamp}.json`);

    // Ensure backup directory exists
    await fs.promises.mkdir(backupDir, { recursive: true });

    // Save the full thread state (all generations with their messages)
    const backupData = {
      backupVersion: 1,
      threadId,
      workspaceId,
      createdAt: Date.now(),
      generationCount: thread.generations.length,
      generations: thread.generations,
    };

    await fs.promises.writeFile(backupPath, JSON.stringify(backupData, null, 2), 'utf-8');
    console.log(`[CompactionManager] Backed up ${generationIds.length} generations to ${backupPath}`);

    return { backupPath, generationIds };
  }

  /**
   * Replace entire thread history with compacted messages
   * Clears all old generations and creates a single synthetic generation
   * C15: Store compaction metadata
   * M07: Backs up old history first, then marks compacted generation with metadata
   */
  private async replaceThreadHistory(
    workspaceId: string,
    threadId: string,
    compactedMessages: ModelMessage[],
    metadata?: CompactionMetadata
  ): Promise<void> {
    // M07: Back up the pre-compaction history before clearing
    const { backupPath, generationIds } = await this.backupPreCompactionHistory(
      workspaceId, threadId
    );

    // Attach backup info to metadata
    if (metadata) {
      metadata.backupPath = backupPath;
      metadata.compactedGenerationIds = generationIds;
    }

    const thread = chatStateStorage.getOrCreateThread(workspaceId, threadId);

    // Clear all old generations
    thread.generations = [];

    const generationId = 'compact-' + Date.now();

    // Create a synthetic generation with compacted messages
    // M07: The '[Compacted History]' label + metadata.compactedGenerationIds
    // serve as the marker that old generations were compacted.
    chatStateStorage.addGeneration(
      workspaceId,
      threadId,
      '[Compacted History]',
      {
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
      },
      generationId
    );

    // Update the generation with compacted messages and metadata
    chatStateStorage.updateGeneration(
      workspaceId,
      threadId,
      generationId,
      {
        modelMessages: compactedMessages,
        reviewState: { status: 'accepted' }, // Mark as accepted so it's included in history
        // C15 + M07: Store compaction metadata including backup path and compacted generation IDs
        metadata: metadata ? {
          compaction: {
            ...metadata,
            isCompactedGeneration: true,  // M07: Marker flag
          },
        } : undefined,
      }
    );

    console.log(
      `[CompactionManager] Replaced ${generationIds.length} generations with compacted history. ` +
      `Backup: ${backupPath}`
    );
  }
}
```

#### 6.2.2 Integrate into AgentExecutor

> **Note:** This section shows **pre-turn compaction only**. For the complete AgentExecutor integration with mid-stream compaction support, see **Section 9.8**. Section 9.8 supersedes the code below.

`/workspaces/ballerina/ballerina-extension/src/features/ai/agent/AgentExecutor.ts`

```typescript
import { CompactionManager } from '../compaction-manager';

export class AgentExecutor {
  private compactionManager: CompactionManager;

  constructor() {
    // ... existing initialization
    this.compactionManager = new CompactionManager();
  }

  async executeImpl(/* ... */): Promise<StreamTextResult<any>> {
    // ... existing code ...

    // Resolve the model instance ONCE (handles auth, provider-specific model IDs)
    const model = await getAnthropicClient(ANTHROPIC_SONNET_4);

    // M02: Bind the resolved model to the compaction manager
    // This reuses the SAME authenticated model instance for summarization,
    // avoiding duplicate getAnthropicClient() calls, rate limit doubling,
    // and provider-specific model ID mismatches (Bedrock ARN, Vertex AI).
    this.compactionManager.bindModel(model);

    // C09: Gather project state for compaction context
    const projectState = {
      modifiedFiles: Array.from(modifiedFiles.keys()),
      tempProjectPath,
      workingDirectory: this.config.executionContext.projectPath,
    };

    // BEFORE calling streamText, check for compaction (C10: handles failures gracefully)
    // M05: Pass abortSignal so user abort cancels the summarization LLM call too
    await this.compactionManager.checkAndCompact(
      workspaceId, threadId, projectState, this.config.abortController.signal
    );

    // Now call streamText with the SAME model instance
    // populateHistoryForAgent internally calls getChatHistoryForLLM
    const { fullStream, response, usage } = streamText({
      model,    // Same instance used for both agent and compaction
      maxOutputTokens: 8192,
      messages: allMessages,  // Includes system prompt + history + user message
      tools,
      // ... rest of config
    });

    // ... process stream ...

    // C04: After stream completes, update token estimation context with actual usage
    const result = await response;
    if (result.usage) {
      // Estimate system prompt tokens (rough estimate)
      const systemPromptEstimate = Math.ceil(
        getSystemPrompt(projects, params.operationType).length / 4
      );

      // Estimate tool definitions tokens (rough estimate)
      const toolDefinitionsEstimate = 2000; // Conservative estimate

      this.compactionManager.updateTokenContext(
        result.usage.inputTokens,
        systemPromptEstimate,
        toolDefinitionsEstimate
      );
    }

    return result;
  }
}
```

#### 6.2.3 Handle Manual Compaction

Manual compaction follows the existing 4-layer RPC pattern used by all Ballerina copilot AI panel features. Commands in the Ballerina copilot are defined in the `Command` enum (`ballerina-core`) and flow through the RPC chain: **UI (visualizer) → RPC client → messenger → RPC handler → RPC manager**.

##### Layer 1: Interfaces (`ballerina-core/src/rpc-types/ai-panel/interfaces.ts`)

Add the request/response types alongside existing interfaces:

```typescript
// ==================================
// Compaction Related Interfaces
// ==================================

export interface CompactConversationRequest {
  /** Optional user instructions for guiding the summarization (e.g., "focus on test changes") */
  customInstructions?: string;
}

export interface CompactConversationResponse {
  success: boolean;
  /** Token count before compaction */
  originalTokens?: number;
  /** Token count after compaction */
  compactedTokens?: number;
  /** Percentage of tokens reduced */
  reductionPercentage?: number;
  /** Error message if compaction failed */
  error?: string;
}
```

##### Layer 2: RPC Type Definition (`ballerina-core/src/rpc-types/ai-panel/rpc-type.ts`)

Add the RPC method definition following the existing pattern:

```typescript
import { CompactConversationRequest, CompactConversationResponse } from "./interfaces";

export const compactConversation: RequestType<CompactConversationRequest, CompactConversationResponse> = {
  method: `${_preFix}/compactConversation`
};
```

##### Layer 3: API Interface (`ballerina-core/src/rpc-types/ai-panel/index.ts`)

Add to the `AIPanelAPI` interface under the Chat State Management section:

```typescript
export interface AIPanelAPI {
    // ... existing methods ...

    // ==================================
    // Chat State Management
    // ==================================
    getChatMessages: () => Promise<UIChatMessage[]>;
    getCheckpoints: () => Promise<CheckpointInfo[]>;
    restoreCheckpoint: (params: RestoreCheckpointRequest) => Promise<void>;
    clearChat: () => Promise<void>;
    updateChatMessage: (params: UpdateChatMessageRequest) => Promise<void>;
    getActiveTempDir: () => Promise<string>;
    getUsage: () => Promise<UsageResponse | undefined>;
    compactConversation: (params: CompactConversationRequest) => Promise<CompactConversationResponse>;  // NEW
}
```

##### Layer 4: RPC Client (`ballerina-rpc-client/src/rpc-clients/ai-panel/rpc-client.ts`)

Add the client method (webview-side, called by UI):

```typescript
import { CompactConversationRequest, CompactConversationResponse, compactConversation } from "@wso2/ballerina-core";

// In AiPanelRpcClient class:
compactConversation(params: CompactConversationRequest): Promise<CompactConversationResponse> {
    return this._messenger.sendRequest(compactConversation, HOST_EXTENSION, params);
}
```

##### Layer 5: RPC Handler Registration (`ballerina-extension/src/rpc-managers/ai-panel/rpc-handler.ts`)

Register the handler in `registerAiPanelRpcHandlers`:

```typescript
import { compactConversation, CompactConversationRequest } from "@wso2/ballerina-core";

// Inside registerAiPanelRpcHandlers():
messenger.onRequest(compactConversation, (args: CompactConversationRequest) => rpcManger.compactConversation(args));
```

##### Layer 6: RPC Manager Implementation (`ballerina-extension/src/rpc-managers/ai-panel/rpc-manager.ts`)

Implement the handler in `AiPanelRpcManager`, following the `clearChat` pattern for workspace/thread resolution:

```typescript
import { CompactConversationRequest, CompactConversationResponse } from "@wso2/ballerina-core";
import { getAnthropicClient, ANTHROPIC_SONNET_4 } from '../../features/ai/utils/ai-client';

// In AiPanelRpcManager class:
async compactConversation(params: CompactConversationRequest): Promise<CompactConversationResponse> {
    const workspaceId = StateMachine.context().projectPath;
    const threadId = 'default';

    // M05: Reject manual compact if an AI generation is in progress.
    // The UI disables input during generation (isLoading), but this guard
    // protects against race conditions at the backend.
    const activeExecution = chatStateStorage.getActiveExecution(workspaceId, threadId);
    if (activeExecution) {
        return {
            success: false,
            error: 'Cannot compact while a generation is in progress. Please wait for it to complete or stop it first.',
        };
    }

    try {
        // M02: Resolve the model instance for manual compaction.
        // Uses the same getAnthropicClient → provider resolution as AgentExecutor,
        // ensuring correct auth and provider-specific model IDs.
        const model = await getAnthropicClient(ANTHROPIC_SONNET_4);

        const result = await compactionManager.manualCompact(
            workspaceId,
            threadId,
            model,
            params.customInstructions
        );

        console.log(
            `[RPC] Compacted conversation for workspace: ${workspaceId} ` +
            `(${result.reductionPercentage.toFixed(1)}% reduction)`
        );

        return {
            success: true,
            originalTokens: result.originalTokens,
            compactedTokens: result.compactedTokens,
            reductionPercentage: result.reductionPercentage,
        };
    } catch (error) {
        console.error(`[RPC] Compaction failed for workspace: ${workspaceId}`, error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Compaction failed',
        };
    }
}
```

##### UI Command Registration (Optional)

The `/compact` command can be added to the existing `Command` enum in `ballerina-core/src/interfaces/ai-panel.ts` to enable autocomplete suggestions in the chat input:

```typescript
export enum Command {
    DataMap = '/datamap',
    TypeCreator = '/typecreator',
    Ask = '/ask',
    NaturalProgramming = '/natural-programming (experimental)',
    OpenAPI = '/openapi',
    Agent = '/agent',
    Doc = '/doc',
    Compact = '/compact',  // NEW — manual conversation compaction
}
```

The visualizer's command template system (`commandTemplates.const.ts`) can then register a template for the `/compact` command with an optional placeholder for custom instructions. The UI would intercept this command and call `rpcClient.getAiPanelRpcClient().compactConversation(...)` instead of routing through the normal `generateAgent` flow.

### 6.3 MI Copilot Integration

**Status:** Deferred (C08 fix)

**Reason:** The MI copilot architecture in this workspace differs from the assumed design. Before integration:

1. **Investigate MI Agent Mode:**
   - Agent-mode RPC types exist in `mi-core/lib/rpc-types/agent-mode/` (compiled .d.ts/.js)
   - No source implementation found in `mi-extension/src/`
   - Determine if agent-mode is external service or lives in different repo

2. **Current MI Copilot (Non-Agent):**
   - Uses `fetchCodeGenerationsWithRetry()` → `generateSynapse()` (single-turn)
   - Implements sliding window in `fetchCodeGenerationsWithRetry` (last 6-7 messages)
   - Integration point would be in `fetchCodeGenerationsWithRetry`, not RPC handler

3. **Next Steps:**
   - Locate actual MI agent-mode implementation
   - Understand message passing architecture (extension vs backend)
   - Design integration based on actual architecture
   - If no agent mode exists yet, design for non-agent copilot first

**Placeholder Integration (for non-agent MI):**

```typescript
// workspaces/mi/mi-extension/src/ai-panel/copilot/utils.ts
import { CompactionEngine } from '@wso2/copilot-utilities/compaction';

// In fetchCodeGenerationsWithRetry:
const compactionEngine = new CompactionEngine({ /* config */ });

// Replace sliding window logic
if (await compactionEngine.shouldCompact(chatHistory)) {
  const result = await compactionEngine.compact(chatHistory, { mode: 'auto' });
  chatHistory = result.compactedMessages;
  // Use compacted history instead of .slice(-7, -1)
}
```

**Note:** Full MI integration requires architectural investigation first (see C08 in red team analysis).
    success: true,
    compactedMessages: result.compactedMessages,
    reduction: result.reductionPercentage,
  };
});
```

---

## 7. Configuration

### 7.1 VSCode Settings

Add to `package.json`:

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "ballerina.copilot.compaction.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable automatic context compaction"
        },
        "ballerina.copilot.compaction.threshold": {
          "type": "number",
          "default": 167000,
          "description": "Token count threshold for auto-compaction"
        }
      }
    }
  }
}
```

---

## 8. Limitations and Known Constraints

### 8.1 Mid-Turn Context Overflow (C13) — Resolved

**Previously:** Design only prevented context overflow at the start of each turn, not during it.

**Resolution:** Implemented via Section 9 (Mid-Stream Compaction) using Vercel AI SDK's `prepareStep` hook. See Section 9 for full design.

### 8.2 Generation Boundary Loss After Compaction — Resolved

**Constraint:** Compaction replaces all generations with a single synthetic generation

**Impact:**
- Checkpoint restore functionality breaks (checkpoints are per-generation)
- Review state per-generation becomes meaningless
- Undo functionality across generations is lost
- Generation metadata (timestamps, model used, etc.) is lost for old generations

**Resolution (via M07):**
- Pre-compaction history is backed up to `.ballerina/copilot/compaction-backups/<threadId>-<timestamp>.json`
- The synthetic generation includes `isCompactedGeneration: true` marker and `compactedGenerationIds` list
- `backupPath` stored in metadata for manual recovery

### 8.3 Re-Compaction Quality Degradation — Resolved

**Constraint:** Re-compacting already-compacted summaries degrades quality

**Resolution (via M03):**
- Retries now always re-summarize from the **original messages**, never the compacted output
- A `targetTokenBudget` (50% of threshold) is passed on retries to guide a more concise summary
- The LLM receives a "Token Budget Constraint" system prompt section instructing it to focus on critical information only

### 8.4 Provider-Specific Context Window Differences — Resolved

**Constraint:** Design hardcodes Claude context window (200K tokens)

**Problem:**
- Ballerina copilot supports multiple providers (Anthropic, AWS Bedrock, Google Vertex AI)
- Each provider may have different context windows for the same model
- Bedrock may restrict context windows or have different limits

**Resolution (via M02 + M04):**
- `ModelConfig` is passed to `CompactionEngineConfig` at construction time — the integrator controls these values
- The `bindModel()` pattern means the compaction engine never resolves the provider itself
- If a future integrator needs different context windows, they pass a different `ModelConfig` when constructing the `CompactionEngine`
- The current `DEFAULT_CONFIG` with 200K context window is correct for all current providers (Anthropic direct, Bedrock, Vertex AI all support 200K for Claude Sonnet 4)

### 8.5 Summarization Prompt Token Overhead

**Note:** The summarization prompt includes `<analysis>` thinking output which increases token usage

**Impact:**
- Summarization LLM generates potentially lengthy `<analysis>` blocks (5K-15K tokens)
- These blocks are discarded - only `<summary>` is parsed
- Adds latency and cost to compaction operation

**Status:** By design per user request (not changed in v2.1.0)

**Potential Future Optimization:**
- Use Claude extended thinking feature (doesn't count against output tokens)
- Or use `stop_sequences` to limit output
- Or remove analysis step entirely for efficiency

---

## 9. Mid-Stream Compaction

### 9.1 Problem Statement

The Ballerina agent uses `streamText` with `stepCountIs(50)`, allowing up to 50 tool-call steps in a single execution. Each step adds tool-call + tool-result messages to the context. For tool-heavy conversations (file reads, diagnostics, code edits), the accumulated context can exceed the 200K token window **mid-execution**, causing the LLM API to fail with a context overflow error.

The pre-turn compaction (Section 6.2.2) only checks before `streamText` starts — it cannot prevent overflow during the multi-step tool loop.

### 9.2 Solution: In-Stream Compaction via `prepareStep`

**Key Insight:** Vercel AI SDK v6 provides a `prepareStep` hook that fires **before each LLM step** within a single `streamText` call. It receives all completed steps (with token usage) and the current messages, and can **return a replacement message array**. This enables compaction **inside the stream** without breaking streaming continuity.

**Why NOT an outer loop:**
- Ending one `streamText` and starting another breaks streaming continuity (new `fullStream` iterable)
- Step counting across boundaries is error-prone
- Tool call context managed internally by SDK would be lost
- `prepareStep` already provides the exact hook needed

### 9.3 Architecture

```
Single streamText() call with prepareStep
│
├── Step 1: prepareStep fires → skip (no usage data yet)
│   └── LLM call → tool calls → tool results → onStepFinish
│
├── Step 2..N: prepareStep fires
│   ├── CompactionGuard reads steps[-1].usage.inputTokens
│   ├── Under threshold? → return undefined (no change, normal flow)
│   └── Over threshold? → COMPACT
│       ├── Emit compaction_start event to UI
│       ├── Split messages: [old messages] + [recent N messages]
│       ├── Summarize old messages via CompactionEngine
│       ├── Build: [continuation msgs] + [original user request] + [recent tool interactions]
│       ├── Emit compaction_end event to UI
│       └── Return { messages: compactedMessages }
│           └── SDK uses compacted messages for this step's LLM call
│
├── stopWhen: [stepCountIs(50), contextExhausted(guard)]
│   └── contextExhausted stops gracefully if compaction fails
│
└── Stream finishes → handleStreamFinish → save to chatStateStorage
```

### 9.4 Component: CompactionGuard

**Location:** `workspaces/ballerina/ballerina-extension/src/features/ai/agent/compaction/CompactionGuard.ts`

**Responsibility:** Encapsulates mid-stream compaction decision logic and execution. Designed to be called from `prepareStep`.

```typescript
import { CompactionEngine, CompactionResult, ProjectStateContext } from '@wso2/copilot-utilities/compaction';
import { ModelMessage, StepResult } from 'ai';

export interface CompactionGuardConfig {
  engine: CompactionEngine;
  /** Token threshold to trigger compaction (default: 80% of maxContextWindow) */
  tokenThreshold: number;
  /** Max compaction attempts per generation (default: 3) */
  maxCompactionAttempts: number;
  /** Number of recent messages to preserve verbatim (default: 6) */
  preserveRecentMessageCount: number;
  /** Event handler for UI notifications */
  eventHandler: (event: ChatNotify) => void;
  /** Original user request content (for continuation context) */
  originalUserMessage: string;
  /** Project state for continuation context */
  projectState: ProjectStateContext;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

export class CompactionGuard {
  private compactionCount: number = 0;
  private _lastCompactionFailed: boolean = false;
  private config: CompactionGuardConfig;

  constructor(config: CompactionGuardConfig) {
    this.config = config;
  }

  /** Used by contextExhausted stop condition */
  get lastCompactionFailed(): boolean {
    return this._lastCompactionFailed;
  }

  /**
   * Called from prepareStep. Checks if compaction is needed and performs it.
   *
   * @param options - prepareStep options from Vercel AI SDK
   * @returns PrepareStepResult with replacement messages, or undefined for no change
   */
  async maybeCompact(options: {
    steps: StepResult<any>[];
    stepNumber: number;
    messages: ModelMessage[];
  }): Promise<{ messages: ModelMessage[] } | undefined> {
    const { steps, messages } = options;

    // Skip on first step (no usage data yet)
    if (steps.length === 0) {
      return undefined;
    }

    // Check abort
    if (this.config.abortSignal?.aborted) {
      return undefined;
    }

    // Read actual token usage from the most recent completed step
    // This is the MOST ACCURATE measure — it's the actual inputTokens
    // the LLM API consumed for that step, including all accumulated messages
    const lastStep = steps[steps.length - 1];
    const lastInputTokens = lastStep.usage?.inputTokens ?? 0;

    // Check if we're approaching the threshold
    if (lastInputTokens < this.config.tokenThreshold) {
      return undefined; // Context is fine, proceed normally
    }

    console.log(
      `[CompactionGuard] Token threshold reached: ${lastInputTokens} >= ${this.config.tokenThreshold} ` +
      `(step ${options.stepNumber}, compaction attempt ${this.compactionCount + 1}/${this.config.maxCompactionAttempts})`
    );

    // Check if we've exhausted compaction attempts
    if (this.compactionCount >= this.config.maxCompactionAttempts) {
      console.error(
        `[CompactionGuard] Max compaction attempts (${this.config.maxCompactionAttempts}) reached. ` +
        `Setting lastCompactionFailed = true.`
      );
      this._lastCompactionFailed = true;
      return undefined; // contextExhausted stopWhen will halt the generation
    }

    // === PERFORM MID-STREAM COMPACTION ===
    try {
      return await this.performCompaction(messages);
    } catch (error) {
      console.error('[CompactionGuard] Mid-stream compaction failed:', error);
      this._lastCompactionFailed = true;
      this.config.eventHandler({
        type: 'compaction_failed',
        reason: error instanceof Error ? error.message : 'Unknown compaction error',
      });
      return undefined; // Let contextExhausted stop gracefully
    }
  }

  /**
   * Core compaction logic: split messages, summarize old ones,
   * preserve recent tool interactions, rebuild message array.
   */
  private async performCompaction(
    messages: ModelMessage[]
  ): Promise<{ messages: ModelMessage[] }> {
    // Notify UI
    this.config.eventHandler({ type: 'compaction_start' });

    // === SPLIT: old messages + recent messages ===
    const preserveCount = this.config.preserveRecentMessageCount;
    const splitIndex = Math.max(0, messages.length - preserveCount);

    // Find a clean split point (don't split in the middle of a tool-call/tool-result pair)
    const cleanSplitIndex = this.findCleanSplitPoint(messages, splitIndex);

    const oldMessages = messages.slice(0, cleanSplitIndex);
    const recentMessages = messages.slice(cleanSplitIndex);

    console.log(
      `[CompactionGuard] Splitting: ${oldMessages.length} old messages to summarize, ` +
      `${recentMessages.length} recent messages to preserve verbatim`
    );

    // === SUMMARIZE old messages (with mid-stream instructions injected into main prompt) ===
    const MID_STREAM_INSTRUCTIONS = `## Mid-Stream Compaction Context

CRITICAL: This compaction is happening MID-TASK. The assistant is in the middle of executing a task and will continue immediately after reading this summary. Prioritize:

1. **Original User Request**: Include the EXACT user request verbatim
2. **Task Progress**: What has been accomplished vs what remains
3. **Files Modified**: List ALL file paths created, read, or modified
4. **Current State**: What was being worked on at the moment of compaction
5. **Pending Work**: Specific next steps needed to complete the task
6. **Errors**: Any unresolved errors or blockers

The assistant MUST be able to seamlessly continue the task from this summary alone.`;

    const compactionResult = await this.config.engine.compact(oldMessages, {
      mode: 'auto',
      projectState: this.config.projectState,
      abortSignal: this.config.abortSignal,
      customInstructions: MID_STREAM_INSTRUCTIONS,  // Injected into existing SUMMARIZATION_PROMPT
    });

    if (!compactionResult.success) {
      throw new Error('CompactionEngine.compact() returned success: false');
    }

    // === BUILD replacement messages ===
    // Structure: [continuation summary] + [original user request] + [recent tool interactions]
    const compactedMessages: ModelMessage[] = [
      ...compactionResult.compactedMessages,
      // Re-inject the original user request so model remembers the task
      {
        role: 'user' as const,
        content: `[Mid-stream compaction occurred. The context was approaching token limits. Your conversation history has been compacted. Continue working on the original task below.]\n\nOriginal request: ${this.config.originalUserMessage}`,
      },
      {
        role: 'assistant' as const,
        content: 'Understood. I will continue working on the task. Let me pick up where I left off based on the recent context.',
      },
      // Preserved recent messages (last N tool interactions — verbatim)
      ...recentMessages,
    ];

    this.compactionCount++;

    // Notify UI
    this.config.eventHandler({
      type: 'compaction_end',
      metadata: compactionResult.metadata,
    });

    console.log(
      `[CompactionGuard] Mid-stream compaction #${this.compactionCount} complete. ` +
      `Messages: ${messages.length} → ${compactedMessages.length} ` +
      `(${compactionResult.reductionPercentage.toFixed(1)}% reduction on summarized portion)`
    );

    return { messages: compactedMessages };
  }

  /**
   * Find a clean split point that doesn't break tool-call / tool-result pairs.
   * Tool messages (role: 'tool') must stay with their preceding assistant tool-call.
   */
  private findCleanSplitPoint(messages: ModelMessage[], targetIndex: number): number {
    let index = targetIndex;

    // Walk backward until we find a user message (clean boundary)
    while (index > 0) {
      const msg = messages[index];
      if (msg.role === 'user') {
        break; // User messages are safe split points
      }
      index--;
    }

    // Don't summarize fewer than 4 messages (not worth it)
    if (index < 4) {
      return messages.length; // Skip compaction — too few messages to summarize
    }

    return index;
  }
}
```

### 9.5 Custom Stop Condition: `contextExhausted`

**Purpose:** Graceful termination if mid-stream compaction fails.

```typescript
import { StopCondition } from 'ai';
import { CompactionGuard } from './CompactionGuard';

/**
 * Creates a StopCondition that stops generation when compaction has failed
 * and the context cannot be reduced. Prevents context overflow crashes.
 */
export function contextExhausted(guard: CompactionGuard): StopCondition<any> {
  return ({ steps }) => {
    if (!guard.lastCompactionFailed) {
      return false; // Compaction is fine, don't stop
    }

    console.warn(
      '[contextExhausted] Stopping generation: compaction failed and context is near limit. ' +
      `Completed ${steps.length} steps before stopping.`
    );
    return true;
  };
}
```

**Usage with `stopWhen` (array of conditions — stops when ANY is true):**
```typescript
stopWhen: [stepCountIs(50), contextExhausted(guard)]
```

### 9.6 Mid-Stream Summarization: Prompt Injection

Instead of a separate prompt, mid-stream compaction **injects an additional section** into the existing `SUMMARIZATION_PROMPT`. This keeps a single prompt source of truth and avoids duplication.

**How it works:** `SummarizationService.summarize()` already accepts `customInstructions` which are appended to the system prompt. The `CompactionGuard.performCompaction()` (Section 9.4) defines a `MID_STREAM_INSTRUCTIONS` constant and passes it via `customInstructions` to `CompactionEngine.compact()`. The `SummarizationService` appends it as `## Additional Summarization Instructions`, producing:

```
{SUMMARIZATION_PROMPT}

## Additional Summarization Instructions from User

## Mid-Stream Compaction Context
CRITICAL: This compaction is happening MID-TASK...
```

This reuses the existing prompt pipeline (Section 5.2) with zero changes to `SummarizationService`.

This reuses the existing prompt pipeline (Section 5.2) with zero changes to `SummarizationService`.

### 9.7 ChatNotify Event Types

Add to `ballerina-core/src/state-machine-types.ts`:

```typescript
// Mid-stream compaction events
export interface CompactionStartEvent {
  type: 'compaction_start';
}

export interface CompactionEndEvent {
  type: 'compaction_end';
  metadata?: CompactionMetadata;
}

export interface CompactionFailedEvent {
  type: 'compaction_failed';
  reason: string;
}

// Add to ChatNotify union:
export type ChatNotify =
    | ChatStart
    | IntermidaryState
    | ChatContent
    // ... existing types ...
    | CompactionStartEvent
    | CompactionEndEvent
    | CompactionFailedEvent;
```

### 9.8 Updated AgentExecutor Integration

`workspaces/ballerina/ballerina-extension/src/features/ai/agent/AgentExecutor.ts`

```typescript
import { CompactionGuard } from './compaction/CompactionGuard';
import { contextExhausted } from './compaction/contextExhausted';
import { CompactionManager } from '../compaction-manager';

export class AgentExecutor extends AICommandExecutor<GenerateAgentCodeRequest> {
  private compactionManager: CompactionManager;

  constructor(config: AICommandConfig<GenerateAgentCodeRequest>) {
    super(config);
    this.compactionManager = new CompactionManager();
  }

  async execute(): Promise<AIExecutionResult> {
    const tempProjectPath = this.config.executionContext.tempProjectPath!;
    const params = this.config.params;
    const modifiedFiles: string[] = [];

    try {
      // ... existing setup (steps 1-5) ...

      const userMessageContent = getUserPrompt(params, tempProjectPath, projects);
      const model = await getAnthropicClient(ANTHROPIC_SONNET_4);

      // Bind model to compaction manager (M02 fix)
      this.compactionManager.bindModel(model);

      // PRE-TURN compaction (existing — for between-turn overflow)
      const projectState = {
        modifiedFiles: Array.from(modifiedFiles),
        tempProjectPath,
        workingDirectory: this.config.executionContext.projectPath,
      };
      await this.compactionManager.checkAndCompact(
        workspaceId, threadId, projectState
      );

      // Build messages AFTER pre-turn compaction
      const chatHistory = this.getChatHistory();
      const historyMessages = populateHistoryForAgent(chatHistory);
      const cacheOptions = await getProviderCacheControl();

      const allMessages: ModelMessage[] = [
        {
          role: "system",
          content: getSystemPrompt(projects, params.operationType),
          providerOptions: cacheOptions,
        },
        ...historyMessages,
        { role: "user", content: userMessageContent },
      ];

      // Create tools
      const tools = createToolRegistry({ /* ... existing ... */ });

      // === MID-STREAM COMPACTION GUARD ===
      const compactionGuard = new CompactionGuard({
        engine: this.compactionManager.getEngine(),
        tokenThreshold: Math.floor(200_000 * 0.80),  // 160K = 80% of context window
        maxCompactionAttempts: 3,
        preserveRecentMessageCount: 6,  // Keep last 3 tool-call + tool-result pairs
        eventHandler: this.config.eventHandler,
        originalUserMessage: userMessageContent,
        projectState,
        abortSignal: this.config.abortController.signal,
      });

      // Stream LLM response with mid-stream compaction support
      const { fullStream, response, usage } = streamText({
        model,
        maxOutputTokens: 8192,
        temperature: 0,
        messages: allMessages,
        tools,
        abortSignal: this.config.abortController.signal,

        // MID-STREAM COMPACTION: check and compact between steps
        prepareStep: async ({ steps, stepNumber, messages }) => {
          return compactionGuard.maybeCompact({ steps, stepNumber, messages });
        },

        // Track per-step token usage for telemetry
        onStepFinish: (step) => {
          console.log(
            `[AgentExecutor] Step ${step.stepNumber} complete: ` +
            `${step.usage?.inputTokens || 0} input tokens, ` +
            `finishReason: ${step.finishReason}`
          );
        },

        // DUAL STOP CONDITIONS: step limit + context exhaustion
        stopWhen: [stepCountIs(50), contextExhausted(compactionGuard)],
      });

      // ... existing stream processing (handleStreamPart loop) ...

      // After stream: update token context with final usage
      const finalResult = await response;
      const totalUsage = await usage;
      if (totalUsage) {
        this.compactionManager.updateTokenContext(
          totalUsage.inputTokens || 0,
          Math.ceil(getSystemPrompt(projects, params.operationType).length / 4),
          2000
        );
      }

      return { tempProjectPath, modifiedFiles };
    } catch (error) {
      // ... existing error handling ...
    }
  }
}
```

### 9.9 Data Flow: Complete Mid-Stream Compaction Lifecycle

```
User sends message
│
▼
AgentExecutor.execute()
├── Pre-turn compaction check (Section 6.2.2)
├── Build allMessages [system + history + user]
├── Create CompactionGuard
│
▼
streamText({ prepareStep, stopWhen: [stepCountIs(50), contextExhausted] })
│
├── Step 0: prepareStep → skip (no usage data)
│   └── LLM generates text + makes tool calls
│   └── onStepFinish: inputTokens = 45,000
│
├── Step 1: prepareStep → 45K < 160K threshold → skip
│   └── LLM processes tool results, makes more tool calls
│   └── onStepFinish: inputTokens = 82,000
│
├── Step 2: prepareStep → 82K < 160K → skip
│   └── More tool calls (reading files, running diagnostics...)
│   └── onStepFinish: inputTokens = 145,000
│
├── Step 3: prepareStep → 145K < 160K → skip
│   └── Large tool results push context higher
│   └── onStepFinish: inputTokens = 172,000  ← OVER THRESHOLD
│
├── Step 4: prepareStep → 172K >= 160K → ★ COMPACT ★
│   ├── eventHandler({ type: 'compaction_start' })
│   ├── Split: messages[0..N-6] → summarize, messages[N-5..N] → preserve
│   ├── CompactionEngine.compact(oldMessages) → summary
│   ├── Build: [summary] + [original request] + [recent 6 messages]
│   ├── eventHandler({ type: 'compaction_end' })
│   └── Return { messages: compactedMessages }  (e.g., 35K tokens)
│   └── LLM receives compacted messages, continues working seamlessly
│   └── onStepFinish: inputTokens = 42,000  ← REDUCED
│
├── Steps 5..N: Continue normally with compacted context
│   └── If threshold hit again → compact again (up to 3 times)
│
└── Generation finishes (finishReason: 'stop' or contextExhausted)
    └── handleStreamFinish → save to chatStateStorage
```

### 9.10 UI Behavior During Mid-Stream Compaction

**What the user sees:**

1. **Before compaction:** Normal streaming output — text deltas, tool call indicators
2. **During compaction (2-10 seconds):**
   - Stream naturally pauses (no new LLM output since `prepareStep` blocks)
   - UI shows a `CompactionSegment` indicator: "Compacting context to continue..."
   - This uses the existing `CompactionSegment` component pattern
3. **After compaction:** Streaming resumes seamlessly
   - The model's next response continues the task naturally
   - User sees no interruption in the conversation flow

**Frontend handling (in the ChatMessage stream renderer):**

```typescript
// In the message stream event handler
case 'compaction_start':
  setIsCompacting(true);
  // Show inline indicator in the chat stream
  break;

case 'compaction_end':
  setIsCompacting(false);
  // Optionally show brief "Context compacted" indicator
  break;

case 'compaction_failed':
  setIsCompacting(false);
  // Show warning: "Context compaction failed. Generation may be limited."
  break;
```

### 9.11 Error Handling Matrix

| Scenario | Behavior |
|---|---|
| Compaction succeeds | `prepareStep` returns new messages, stream continues seamlessly |
| Summarization LLM fails (rate limit, network) | `lastCompactionFailed = true`, `contextExhausted` stops at next step |
| Abort during compaction | AbortSignal propagated to `generateText`, `prepareStep` throws, `streamText` handles abort |
| Max compaction attempts (3) reached | `lastCompactionFailed = true`, `contextExhausted` stops gracefully |
| Compacted output still too large | CompactionEngine retry loop with stricter budget (M03 fix) |
| Only a few messages to summarize (<4) | Skip compaction, let context overflow happen (will get LLM API error) |

### 9.12 Configuration

```typescript
export interface MidStreamCompactionConfig {
  /** Enable mid-stream compaction (default: true) */
  enabled: boolean;
  /** Token threshold as percentage of maxContextWindow (default: 0.80) */
  thresholdPercentage: number;
  /** Max compaction attempts per generation (default: 3) */
  maxCompactionAttempts: number;
  /** Number of recent messages to preserve verbatim (default: 6) */
  preserveRecentMessageCount: number;
}

const DEFAULT_MID_STREAM_CONFIG: MidStreamCompactionConfig = {
  enabled: true,
  thresholdPercentage: 0.80,
  maxCompactionAttempts: 3,
  preserveRecentMessageCount: 6,
};
```

### 9.13 Key Design Decisions

1. **`prepareStep` over outer loop:** Uses the SDK's built-in hook. Single `streamText` call maintains full streaming continuity, correct step counting, and SDK-managed tool execution.

2. **80% threshold (160K of 200K):** Conservative enough to allow the compaction LLM call overhead + the next step's output (up to 8192 tokens) + tool results. The 40K buffer handles:
   - Up to 8K output tokens for the next step
   - Up to 15K for tool results in the next step
   - Up to 12K for the summarization overhead
   - 5K safety margin

3. **Preserve last 6 messages:** Keeping the last 3 tool-call + tool-result pairs gives the model immediate context about what it just did, preventing it from re-reading files or re-executing completed operations.

4. **Split summarization:** Only old messages are summarized. Recent messages are preserved verbatim. This avoids loss of critical recent context while still achieving significant token reduction.

5. **Re-inject original user request:** After compaction, the original user message is re-stated so the model clearly knows what task it's working on. This prevents task drift after compaction.

6. **Graceful degradation via `contextExhausted`:** If compaction fails (LLM error, max attempts), the generation stops gracefully instead of crashing with a context overflow. The user sees partial results and a warning.

7. **No chatStateStorage update during mid-stream:** Messages are only saved to chatStateStorage in `handleStreamFinish` after the stream completes. Mid-stream compaction only modifies the in-flight message array within the `streamText` call.

---

## 10. Context Usage Widget

### 10.1 Overview

A compact inline widget displayed in the chat input `ActionRow` — next to the "Attach Context" icon — showing how much of the 200K-token context window is currently used. Provides real-time visibility into context consumption and proximity to the auto-compaction threshold.

**Design reference:** VS Code's `ChatContextUsageWidget`. Adapted for React-based webview architecture — no VS Code service infrastructure available.

**Goals:**
- Show context usage as an SVG ring + inline percentage label (e.g., `"32%"`)
- Update after every agent step (incremental during multi-step responses, not just at turn end)
- Update immediately after compaction to reflect reduced context
- Tooltip showing tokens remaining until auto-compaction triggers
- Toggle visibility via `ballerina.ai.showContextUsage` VS Code setting
- Hidden when no data is available yet (fresh chat)

---

### 10.2 Placement and Visual Design

**Placement:** Inside `AIChatInput/index.tsx`'s `ActionRow`, immediately after the "Attach Context" `<ActionButton>`. The Footer passes a `contextUsage` prop down to `AIChatInput`, which renders the widget inline.

**Single color:** The ring stroke uses `var(--vscode-descriptionForeground)` throughout. No threshold-based color changes.

**Background ring:** `var(--vscode-disabledForeground)` at 50% opacity (always visible for scale reference).

**Inline label:** A short text label rendered immediately to the right of the ring:
- Format: `"32%"` (percentage of context window used, rounded to nearest integer)
- No click interaction — purely informational

**SVG ring geometry (matching VS Code):**
- ViewBox: `0 0 36 36`, `cx=18 cy=18 r=14`
- `stroke-width: 4`, `stroke-linecap: round`
- Arc rotated −90° (starts at 12 o'clock)
- `stroke-dasharray = circumference = 2π × 14 ≈ 87.96`
- `stroke-dashoffset = circumference − (percentage / 100) × circumference`

---

### 10.3 Token Math

```typescript
const CONTEXT_WINDOW = 200_000;  // Anthropic Claude max context

// inputTokens from streamText usage already includes system prompt + tools + history
const percentage = Math.min(100, (inputTokens / CONTEXT_WINDOW) * 100);

// Tooltip: tokens remaining until pre-turn auto-compact threshold
const PRE_TURN_THRESHOLD = 178_808;  // 200K - 8192 (maxOutputTokens) - 13K (buffer)
const remaining = Math.max(0, PRE_TURN_THRESHOLD - inputTokens);
const remainingK = Math.round(remaining / 1000);
const tooltipText = `~${remainingK}K tokens until auto-compaction (${Math.round(PRE_TURN_THRESHOLD / 1000)}K threshold)`;
```

We use `inputTokens` (not `inputTokens + outputTokens`) because `inputTokens` from the Anthropic API already accounts for the full input context consumed.

---

### 10.4 Data Flow

```
AgentExecutor — onStepFinish (fires after each step, during streaming)
    → stepResult.usage.inputTokens
    → eventHandler({ type: 'usage_metrics', usage: { inputTokens, ... } })
    → events.ts createWebviewEventHandler()
    → sendUsageMetricsNotification(usage)           [new function in ai-utils.ts]
    → RPC notification → onChatNotify in AIChat/index.tsx
    → setContextUsage({ inputTokens, percentage })
    → Footer receives contextUsage prop → AIChatInput receives contextUsage prop
    → ContextUsageWidget renders SVG ring + inline label

VS Code setting flow:
    vscode.workspace.getConfiguration('ballerina').get('ai.showContextUsage')
    → passed in initial webview state on panel open
    → vscode.workspace.onDidChangeConfiguration → RPC config_change notification
    → AIChat conditionally passes contextUsage (hides/shows widget without reload)
```

**Post-compaction update:** After `checkAndCompact()` succeeds, emit `usage_metrics` with the estimated post-compaction token count (`result.compactedTokens`) so the ring drops immediately.

---

### 10.5 Backend Changes

#### 10.5.1 `AgentExecutor.ts` — Emit usage after each step

Use `onStepFinish` (already present in `streamText`) to emit a `usage_metrics` event after each step, enabling incremental ring updates during multi-step responses:

```typescript
onStepFinish: async (stepResult) => {
    // ... existing step logic (CompactionGuard, etc.) ...

    // Emit per-step usage for the context usage widget
    if (stepResult.usage) {
        context.eventHandler({
            type: "usage_metrics",
            usage: {
                inputTokens: stepResult.usage.inputTokens || 0,
                cacheCreationInputTokens: (stepResult.usage as any).cacheCreationInputTokens || 0,
                cacheReadInputTokens: (stepResult.usage as any).cacheReadInputTokens || 0,
                outputTokens: stepResult.usage.outputTokens || 0,
            },
        });
    }
},
```

This reuses `stepResult.usage` already available in `onStepFinish` — no extra API calls.

#### 10.5.2 `compaction-manager.ts` — Emit post-compaction token estimate

After `replaceThreadHistory()` in `checkAndCompact()`, emit `usage_metrics` with the post-compaction token count so the ring drops immediately:

```typescript
// After replaceThreadHistory()
if (eventHandler) {
    const estimatedTokens = result.compactedTokens;
    eventHandler({
        type: 'usage_metrics',
        usage: {
            inputTokens: estimatedTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 0,
        },
    });
}
```

#### 10.5.3 `events.ts` — Route `usage_metrics` to webview

Currently `usage_metrics` is silently ignored in `createWebviewEventHandler()`. Change to:

```typescript
case "usage_metrics":
    sendUsageMetricsNotification(event.usage);
    break;
```

Add new function in `ai-utils.ts`:

```typescript
export function sendUsageMetricsNotification(
    usage: { inputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; outputTokens: number }
): void {
    const msg: ChatNotify = {
        type: "usage_metrics",
        usage,
    };
    sendAIPanelNotification(msg);
}
```

#### 10.5.4 `ballerina-extension/package.json` — VS Code setting

Add under `contributes.configuration.properties`:

```json
"ballerina.ai.showContextUsage": {
    "type": "boolean",
    "default": true,
    "description": "Show context usage indicator in the AI chat input footer."
}
```

#### 10.5.5 RPC manager — Read setting and listen for changes

In `rpc-manager.ts`, read the setting on panel open and include it in the initial state. Also listen for `onDidChangeConfiguration` to emit a live config-change notification:

```typescript
vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('ballerina.ai.showContextUsage')) {
        const show = vscode.workspace.getConfiguration('ballerina').get<boolean>('ai.showContextUsage', true);
        sendAIPanelNotification({ type: 'config_change', key: 'showContextUsage', value: show });
    }
});
```

---

### 10.6 Frontend Changes

#### 10.6.1 `AIChat/index.tsx` — State and event handling

Add state:
```typescript
const [contextUsage, setContextUsage] = useState<{ inputTokens: number; percentage: number } | null>(null);
const [showContextUsage, setShowContextUsage] = useState<boolean>(true);  // from VS Code setting
```

Handle in `onChatNotify`:
```typescript
} else if (type === "usage_metrics") {
    const CONTEXT_WINDOW = 200_000;
    const inputTokens = response.usage.inputTokens;
    const percentage = Math.min(100, (inputTokens / CONTEXT_WINDOW) * 100);
    setContextUsage({ inputTokens, percentage });
} else if (type === "config_change" && response.key === "showContextUsage") {
    setShowContextUsage(response.value);
}
```

Reset on new chat:
```typescript
setContextUsage(null);
```

Pass down to Footer (gated by setting):
```tsx
<Footer
    ...
    contextUsage={showContextUsage ? contextUsage : null}
/>
```

#### 10.6.2 `Footer/index.tsx` — Pass contextUsage to AIChatInput

Add `contextUsage` to `FooterProps`:
```typescript
contextUsage?: { inputTokens: number; percentage: number } | null;
```

Pass it through to `AIChatInput`:
```tsx
<AIChatInput
    ref={aiChatInputRef}
    ...
    contextUsage={contextUsage}
/>
```

No `StatusRow` needed — the widget renders inside `AIChatInput`'s existing `ActionRow`.

#### 10.6.3 `AIChatInput/index.tsx` — Render widget in ActionRow

Add `contextUsage` to `AIChatInput` props. Render after the "Attach Context" button in `ActionRow`:

```tsx
<ActionButton title="Attach Context" onClick={handleAttachClick}>
    <Codicon name="new-file" />
</ActionButton>
{contextUsage && (
    <ContextUsageWidget
        inputTokens={contextUsage.inputTokens}
        percentage={contextUsage.percentage}
    />
)}
```

---

### 10.7 New Component: `ContextUsageWidget`

**Location:** `workspaces/ballerina/ballerina-visualizer/src/views/AIPanel/components/AIChat/compaction/ContextUsageWidget/index.tsx`

**Props:**
```typescript
interface ContextUsageWidgetProps {
    inputTokens: number;
    percentage: number;
    maxTokens?: number;  // default 200_000
}
```

**Behavior:**
- Renders a compact inline block: `[SVG ring] [text label]`
- SVG ring: 36×36, single stroke color (`--vscode-descriptionForeground`), no click handler
- Inline label: `"32%"` (percentage of context window used, rounded to nearest integer)
- `title` attribute on the wrapper shows tooltip: `"~114K tokens until auto-compaction (179K threshold)"`
- No popup, no click interaction, no state
- `tabIndex={-1}` (not keyboard-navigable — purely informational)

**Token formatting helper:**
```typescript
function formatTokenCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return `${n}`;
}
```

---

### 10.8 CSS

Single ring stroke color — no threshold variants:

```typescript
// Emotion styled components (consistent with codebase)
const WidgetContainer = styled.div({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'default',
    userSelect: 'none',
});

const Label = styled.span({
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
});

// SVG arcs use inline stroke props:
// background arc: stroke="var(--vscode-disabledForeground)" strokeOpacity="0.5"
// progress arc:   stroke="var(--vscode-descriptionForeground)"
```

---

### 10.9 Edge Cases

| Case | Behavior |
|------|----------|
| Fresh chat (no turns yet) | Widget hidden (`contextUsage === null`) |
| `ballerina.ai.showContextUsage = false` | Widget hidden; re-appears immediately if setting re-enabled (no reload) |
| First step in progress | Ring updates after first `onStepFinish` fires (incremental during streaming) |
| After pre-turn compaction | Ring drops immediately via post-compaction `usage_metrics` |
| After mid-stream compaction | Ring drops on `compaction_end`, rises again as next step runs |
| After manual `/compact` | `contextUsage` cleared to `null`; re-appears on next agent step |
| `inputTokens = 0` | Widget hidden (guard against zero/invalid data) |
| 100% fill | Ring fully filled; label shows `"100%"`; tooltip shows `"~0K tokens until auto-compaction"` |

---

### 10.10 File Summary

| File | Change |
|------|--------|
| `AgentExecutor.ts` | Emit `usage_metrics` in `onStepFinish` (per-step, incremental updates) |
| `compaction-manager.ts` | Emit `usage_metrics` after successful compaction |
| `events.ts` | Route `usage_metrics` to webview (stop ignoring it) |
| `ai-utils.ts` | Add `sendUsageMetricsNotification()` |
| `ballerina-extension/package.json` | Add `ballerina.ai.showContextUsage` configuration setting |
| `rpc-manager.ts` | Read setting on panel open; emit `config_change` on setting update |
| `state-machine-types.ts` | No change — `UsageMetricsEvent` already defined |
| `AIChat/index.tsx` | Add `contextUsage` + `showContextUsage` states; handle events; pass to Footer |
| `Footer/index.tsx` | Add `contextUsage` prop; pass to `AIChatInput` (no StatusRow needed) |
| `AIChatInput/index.tsx` | Add `contextUsage` prop; render `ContextUsageWidget` after Attach Context button |
| `AIChat/compaction/ContextUsageWidget/index.tsx` | **NEW** — SVG ring + inline label component |

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-03-06 | Initial design |
| 1.1.0 | 2026-03-06 | Package structure update, Claude SDK token counting |
| 1.2.0 | 2026-03-06 | Streamlined for implementation, added manual compaction |
| 2.0.0 | 2026-03-06 | **🔴 Red Team Fixes (Round 1):**<br>• Fixed async token counting (callback-based)<br>• Removed Anthropic SDK dependency (provider-agnostic)<br>• Defined real chatStateStorage integration point (C01)<br>• Fixed continuation message structure (valid user-assistant sequence)<br>• SUMMARIZATION_PROMPT now used as system prompt (not user message)<br>• Added re-compaction loop with max retries<br>• Added concurrency guard<br>• Confirmed Vercel AI SDK usage |
| **2.1.0** | **2026-03-06** | **🔴 Red Team Fixes (Round 2 - Critical Issues):**<br>**C02:** Fixed maxOutputTokens mismatch (20K → 8192 to match AgentExecutor.ts:215)<br>**C03:** System prompt + tools now included in token estimation via TokenEstimationContext<br>**C04:** Hybrid token counting - uses actual `usage.inputTokens` from streamText as ground truth<br>**C05:** Handle tool-call and tool-result messages in prepareMessagesForSummarization<br>**C06:** Strip system role messages from summarization input to avoid conflicts<br>**C08:** MI integration section replaced with architectural investigation notes<br>**C09:** Added ProjectStateContext to preserve modified files, temp paths in continuation<br>**C10:** Graceful degradation - compaction failures don't kill user requests<br>**C11:** Skipped per user request (keep <analysis> thinking in prompt)<br>**C12:** Use SHA-256 hash instead of pseudo-hash to prevent cache collisions<br>**C13:** Documented mid-turn context overflow limitation<br>**C14:** Added message validation at engine boundary<br>**C15:** Added CompactionMetadata for audit trail, stored in generation metadata |
| **2.2.0** | **2026-03-09** | **🔴 Red Team Fixes (Round 3 - Moderate Issues):**<br>**M01:** `/compact` handler redesigned as 4-layer RPC pattern<br>**M02:** Model instance reuse via `bindModel()` — no separate `getAnthropicClient` call<br>**M03:** Budget-aware retry from original messages (no re-summarizing summaries)<br>**M04:** Covered by M02 — `ModelConfig` is configurable per-provider<br>**M05:** AbortSignal threaded through to `generateText` + active execution guard on manual compact<br>**M06:** SDK compatibility documented in Section 2.2<br>**M07:** Pre-compaction backup to `.ballerina/copilot/compaction-backups/` + compacted generation marker<br>**M08:** Stale compiled artifacts deleted (no source files affected) |
| **2.3.0** | **2026-03-09** | **🔴 Red Team Fixes (Round 4 - Minor Issues):**<br>**L01:** Added `versionPolicyName: "copilot-utilities"` to rush.json entry<br>**L02:** Fixed exports to use compiled `./compaction/lib/index.js` path<br>**L03:** Added test specifications with unit + integration test tables and examples<br>**L04:** Replaced `CompactionStateManager` class with `createContinuationMessages()` utility function<br>**L05:** Fixed revision history dates (Rounds 3-4 dated 2026-03-09)<br>**L06:** Removed unused `warningThreshold` and `isAboveWarningThreshold()` from `ModelConfig` and `ThresholdCalculator` |
| 3.0.0 | 2026-03-10 | **🟢 Mid-Stream Compaction (Section 9):**<br>• Leverages Vercel AI SDK v6 `prepareStep` hook for in-stream compaction<br>• `CompactionGuard` component — monitors per-step token usage, triggers compaction when threshold (80%) reached<br>• Custom `contextExhausted` StopCondition — graceful stop if compaction fails<br>• Split compaction — summarizes old messages while preserving recent 6 messages verbatim<br>• Re-injects original user request after compaction for task continuity<br>• Mid-stream context injected into existing SUMMARIZATION_PROMPT via `customInstructions` (no separate prompt)<br>• New ChatNotify events: `compaction_start`, `compaction_end`, `compaction_failed`<br>• Full error handling matrix (abort, failure, max attempts)<br>• Updated AgentExecutor integration with `prepareStep` + `onStepFinish` + dual `stopWhen`<br>• Section 8.1 resolved — mid-turn overflow is no longer a limitation |
| **3.0.1** | **2026-03-10** | **Document consolidation:**<br>• Section 6.2.2 now cross-references Section 9.8 as canonical AgentExecutor integration<br>• Removed duplicate `MID_STREAM_INSTRUCTIONS` from Section 9.6 (single definition in Section 9.4) |
| **3.1.0** | **2026-03-15** | **Section 10: Context Usage Widget (initial design):**<br>• Circular SVG ring in chat footer showing % of 200K context window used<br>• Data sourced from `UsageMetricsEvent` emitted from `AgentExecutor.handleStreamFinish`<br>• Warning/error color states; click-to-expand details popup; `StatusRow` layout in Footer |
| **3.1.1** | **2026-03-15** | **Section 10 revised:**<br>• Single color ring (no threshold color changes)<br>• Placement: `ActionRow` next to Attach Context icon (not `StatusRow` in Footer)<br>• Inline text label `"65K / 200K"` instead of click popup<br>• Tooltip: tokens remaining until auto-compaction threshold (`~XK tokens until auto-compaction`)<br>• `ballerina.ai.showContextUsage` VS Code setting with live toggle via `onDidChangeConfiguration`<br>• Updates per step via `onStepFinish` (incremental during streaming, not just turn end)<br>• Component path: `AIChat/compaction/ContextUsageWidget/index.tsx` |

