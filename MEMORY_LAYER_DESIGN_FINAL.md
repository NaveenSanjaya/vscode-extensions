# Ballerina Copilot - Memory Layer Design Document

**Version**: 2.0
**Date**: December 17, 2025
**Status**: DESIGN REVIEW
**Project**: Memory Layer for Agentic Coding Assistant

---

## Executive Summary

This document presents a comprehensive design for implementing a memory layer in Ballerina Copilot's agent mode. The memory layer addresses four critical problems:

1. **Context Loss** - Long conversations lose early context due to token limits
2. **Repeated Suggestions** - LLM re-suggests code that was already applied
3. **Token Overflow** - Full history sent every turn causes token limit issues (200k+)
4. **No Knowledge Persistence** - Each session starts fresh without learning from past work

### Solution Approach

We propose a **three-layer memory architecture**:

1. **Working Memory (L1)** - Current session context with intelligent compression
2. **Session Memory (L2)** - Project-specific knowledge across sessions
3. **Applied Code Index (L3)** - Git-integrated tracking of what code was actually used

**Expected Impact:**
- 40-60% reduction in prompt tokens through compression
- Zero duplicate code suggestions via applied code tracking
- Improved multi-turn coherence through conversation summaries
- Cross-session knowledge retention for recurring patterns

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Design Principles](#design-principles)
3. [Architecture Overview](#architecture-overview)
4. [Core Components](#core-components)
5. [Data Models](#data-models)
6. [Storage Strategy](#storage-strategy)
7. [Context & Workspace Tracking](#context--workspace-tracking)
8. [Applied-Code Detection & Pruning](#applied-code-detection--pruning)
9. [Conversation Summarization](#conversation-summarization)
10. [Memory Retrieval & Prompt Integration](#memory-retrieval--prompt-integration)
11. [Integration with Existing Code](#integration-with-existing-code)
12. [Implementation Phases](#implementation-phases)
13. [Performance & Cost Analysis](#performance--cost-analysis)
14. [Risk Mitigation](#risk-mitigation)
15. [Success Metrics](#success-metrics)
16. [Appendix](#appendix)

---

## Current State Analysis

### Existing Architecture

**Current Chat Flow:**
```
User Input → RPC Manager → AI Chat State Machine → Build Full Prompt → Claude API → Response
                                   ↓
                            globalState Storage
                            (Full message history)
```

**Key Files:**
- `src/views/ai-panel/aiChatMachine.ts` - Chat state machine (XState)
- `src/views/ai-panel/chatStatePersistence.ts` - Storage layer
- `src/rpc-managers/ai-panel/rpc-manager.ts` - RPC handler (120+ methods)
- `src/features/ai/service/design/design.ts` - Code generation service

### Current Storage Model

```typescript
// Stored in VS Code globalState
// Key: "ballerina.ai.chat.state.{projectId}"
{
  chatHistory: ChatMessage[],      // Unbounded array - PROBLEM
  sessionId: string,
  projectId: string,
  currentPlan: Task[],
  currentTaskIndex: number,
  checkpoints: Checkpoint[],       // Workspace snapshots
  savedAt: number
}
```

### Identified Problems

#### Problem 1: Unbounded Token Growth
```
Turn 1:  10k tokens (system + user + project context)
Turn 5:  50k tokens (+ 4 previous turns)
Turn 10: 100k tokens (+ 9 previous turns)
Turn 15: 207k tokens → EXCEEDS 200k LIMIT ❌
```

**Root Cause:** Every turn sends complete `chatHistory` array to LLM without compression.

**Code Location:** `src/rpc-managers/ai-panel/rpc-manager.ts:generateCode()`
```typescript
// Current problematic pattern:
const allMessages = context.chatHistory.map(msg => ({
  role: msg.role,
  content: msg.content
}));
// ↑ Sends EVERYTHING, every time
```

#### Problem 2: No Applied Code Tracking

Currently, there's **zero awareness** of which suggestions were applied:

```typescript
// After generation, code is shown in UI
// User clicks "Apply" → files written to disk
// BUT: No record kept of what was applied
// RESULT: LLM suggests same code again later
```

**Missing Components:**
- No Git integration to detect commits
- No file watcher to detect manual code insertion
- No hash-based duplicate detection

#### Problem 3: No Conversation Summarization

All messages stored verbatim:

```typescript
{
  content: "Can you create a REST API service with GET and POST endpoints...",
  uiResponse: "Here's a complete REST API service:\n\n```ballerina\nimport ballerina/http;..."
}
// ↑ Full 2000+ character response stored as-is
```

**Problems:**
- Early important decisions buried in message #5 of 30
- No extraction of key facts (ports, libraries, patterns)
- No task/TODO tracking across turns

#### Problem 4: No Cross-Session Memory

Each new session starts completely fresh:

```typescript
// Session 1 (Monday):
User: "Create OAuth2 authentication"
Copilot: [generates OAuth2 code]

// Session 2 (Tuesday):
User: "How do I handle authentication?"
Copilot: [has NO memory of Monday's work]
```

**Storage Isolation:** `globalState` is session-scoped, cleared on extension reload.

---

## Design Principles

### 1. Backward Compatibility
- Existing chat history format remains valid
- Old projects continue working without migration
- Graceful degradation if memory features disabled

### 2. Incremental Enhancement
- Memory layer is **additive**, not replacement
- Existing code flow preserved with new hooks
- Can be enabled/disabled via configuration

### 3. Cost Consciousness
- Every design decision considers token/API costs
- Compression before transmission, not after
- Caching where possible (Anthropic prompt caching)

### 4. Developer Experience
- No manual memory management required
- Automatic capture and retrieval
- Clear debugging and observability

### 5. Performance First
- No blocking operations in critical path
- Async background processing for compression
- Sub-100ms overhead for memory operations

### 6. Privacy & Security
- No sensitive data (passwords, API keys) in memories
- Local-first storage option
- User control over what gets remembered

---

## Architecture Overview

### Three-Layer Memory Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    LAYER 1: WORKING MEMORY                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Current Session Context (In-Memory)                      │   │
│  │  - Recent messages (last 5-10 turns, uncompressed)      │   │
│  │  - Active code context (selected files, cursor position) │   │
│  │  - Current plan & tasks (if in planning mode)           │   │
│  │  - Pending suggestions (not yet applied)                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Storage: XState context (aiChatMachine.context)               │
│  Lifetime: Current session only                                │
│  Size: ~10-20 messages max                                      │
└──────────────────────────────────────────────────────────────────┘
                              ↓ (Compression trigger)
┌─────────────────────────────────────────────────────────────────┐
│                    LAYER 2: SESSION MEMORY                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Compressed History (Persistent)                          │   │
│  │  - Conversation summaries (every 5 turns)               │   │
│  │  - Key decisions & design choices                       │   │
│  │  - Task progression (completed/pending)                 │   │
│  │  - Generated artifacts (files created/modified)         │   │
│  │  - Embeddings for semantic search (optional)           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Storage: VS Code globalState + optional project folder        │
│  Lifetime: Persists across sessions (per project)              │
│  Size: Compressed summaries (~10% of original)                 │
└──────────────────────────────────────────────────────────────────┘
                              ↓ (Query & Retrieval)
┌─────────────────────────────────────────────────────────────────┐
│                LAYER 3: APPLIED CODE INDEX                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Git-Integrated Code Tracking                             │   │
│  │  - Code hashes (SHA256 of suggestions)                  │   │
│  │  - Application status (applied/ignored/pending)         │   │
│  │  - Git commit references                                │   │
│  │  - File modification timestamps                         │   │
│  │  - Similarity index for deduplication                   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Storage: .ballerina/memory/applied-code.json + Git hooks     │
│  Lifetime: Persists with project (version controlled)          │
│  Size: Lightweight index (~1KB per suggestion)                 │
└──────────────────────────────────────────────────────────────────┘
```

### Component Interaction Flow

```
┌─────────────────┐
│  User Message   │
└────────┬────────┘
         │
         v
┌─────────────────────────────────────────┐
│  RPC Manager (rpc-manager.ts)           │
│  - Receives generateCode() request      │
│  - Gathers project context              │
└────────┬────────────────────────────────┘
         │
         v
┌─────────────────────────────────────────┐
│  Context Builder [NEW]                  │
│  - Load recent messages (L1)            │
│  - Load compressed summaries (L2)       │
│  - Load applied code index (L3)         │
│  - Merge into unified context           │
└────────┬────────────────────────────────┘
         │
         v
┌─────────────────────────────────────────┐
│  Prompt Builder [ENHANCED]              │
│  - Build system prompt                  │
│  - Inject recent messages               │
│  - Inject conversation summaries        │
│  - Filter out applied code              │
│  - Add project state                    │
└────────┬────────────────────────────────┘
         │
         v
┌─────────────────────────────────────────┐
│  LLM (Claude Sonnet 4.5)                │
│  - Generates response                   │
│  - Uses tools (ask, library search)     │
└────────┬────────────────────────────────┘
         │
         v
┌─────────────────────────────────────────┐
│  Response Processor [ENHANCED]          │
│  - Extract code suggestions             │
│  - Register in Applied Code Index       │
│  - Update Working Memory                │
└────────┬────────────────────────────────┘
         │
         v
┌─────────────────────────────────────────┐
│  Background Jobs [NEW]                  │
│  - Check if compression needed          │
│  - Summarize old messages (async)       │
│  - Update Session Memory                │
└─────────────────────────────────────────┘
```

---

## Core Components

### Component 1: Memory Manager (Orchestrator)

**File:** `src/features/ai/memory/MemoryManager.ts` (NEW)

**Responsibilities:**
- Coordinate all memory operations
- Decide when to compress, summarize, prune
- Provide unified API for memory access

**Interface:**
```typescript
interface MemoryManager {
  // Working Memory (L1)
  getWorkingContext(): WorkingMemoryContext;
  addMessage(message: ChatMessage): void;

  // Session Memory (L2)
  getSessionSummaries(projectId: string): ConversationSummary[];
  shouldCompress(): boolean;
  compressOldMessages(): Promise<void>;

  // Applied Code Index (L3)
  trackCodeSuggestion(code: GeneratedCode): string;
  markCodeApplied(suggestionId: string): Promise<void>;
  isCodeAlreadyApplied(code: string): boolean;

  // Unified Retrieval
  buildContextForPrompt(userQuery: string): Promise<MemoryContext>;
}
```

### Component 2: Compression Service

**File:** `src/features/ai/memory/CompressionService.ts` (NEW)

**Responsibilities:**
- Summarize conversation segments
- Extract key facts and decisions
- Reduce token footprint while preserving meaning

**Strategy:**
```typescript
interface CompressionService {
  // Summarize multiple messages into compact form
  compressMessages(messages: ChatMessage[]): Promise<CompressedTurn>;

  // Extract structured information
  extractDecisions(messages: ChatMessage[]): KeyDecision[];
  extractTaskList(messages: ChatMessage[]): Task[];

  // Calculate compression stats
  getCompressionRatio(original: ChatMessage[], compressed: CompressedTurn): number;
}
```

**Compression Algorithm:**
```
Input: Messages [6-10] (5 old turns)
Output: CompressedTurn

Step 1: Group Related Messages
  - Group by topic/task (using Haiku for classification)

Step 2: Summarize Each Group
  - Use Claude Haiku (fast, cheap: $0.25/1M tokens)
  - Prompt: "Summarize this conversation segment. Focus on:
    1. What the user asked
    2. What code was generated
    3. Key decisions made (ports, libraries, patterns)
    4. Any errors or corrections
    Output as bullet points, max 200 words."

Step 3: Extract Structured Data
  - Parse mentions of ports, libraries, file names
  - Extract decision statements ("We decided to use...", "Port changed to...")
  - Identify task completions ("Added authentication", "Fixed error handling")

Step 4: Store Compressed Form
  - Save summary text (200 words vs. 2000+ original)
  - Save extracted structured data
  - Keep original message IDs for reference
```

### Component 3: Applied Code Tracker

**File:** `src/features/ai/memory/AppliedCodeTracker.ts` (NEW)

**Responsibilities:**
- Track which code suggestions were applied
- Integrate with Git to detect commits
- Detect duplicate suggestions

**Core Algorithm:**
```typescript
interface AppliedCodeTracker {
  // Register new suggestion
  registerSuggestion(code: GeneratedCode): SuggestionId;

  // Mark as applied (manual or auto-detected)
  markApplied(suggestionId: string, method: 'user_action' | 'git_detected'): void;

  // Check if code already exists
  findSimilarCode(code: string): AppliedCode[];
  isDuplicate(code: string, threshold?: number): boolean;

  // Git integration
  watchGitCommits(): void;
  detectAppliedCodeInCommit(commitHash: string): void;
}
```

**Detection Methods:**

1. **User Action Tracking** (Immediate)
```typescript
// When user clicks "Apply" in UI
rpcManager.applyCodeChanges(suggestionId, fileChanges) {
  // Write files
  await writeFiles(fileChanges);

  // Track application
  appliedCodeTracker.markApplied(suggestionId, 'user_action');
}
```

2. **Git Commit Analysis** (Batch)
```typescript
// Background job: every 30 seconds
async function detectAppliedCode() {
  const recentCommits = await git.log({ maxCount: 10 });

  for (const commit of recentCommits) {
    const diff = await git.diff(`${commit.hash}^`, commit.hash);

    // Compare diff with pending suggestions
    for (const suggestion of pendingSuggestions) {
      const similarity = calculateSimilarity(diff, suggestion.code);

      if (similarity > 0.8) {
        appliedCodeTracker.markApplied(suggestion.id, 'git_detected');
      }
    }
  }
}
```

3. **File Watcher** (Real-time)
```typescript
// Watch .bal files for changes
vscode.workspace.onDidSaveTextDocument(async (doc) => {
  if (doc.languageId !== 'ballerina') return;

  const content = doc.getText();

  // Check against pending suggestions
  for (const suggestion of pendingSuggestions) {
    if (content.includes(normalizeCode(suggestion.code))) {
      appliedCodeTracker.markApplied(suggestion.id, 'file_watch');
    }
  }
});
```

**Similarity Algorithm:**
```typescript
function calculateSimilarity(code1: string, code2: string): number {
  // 1. Normalize (remove whitespace, comments)
  const norm1 = normalizeCode(code1);
  const norm2 = normalizeCode(code2);

  // 2. Calculate metrics
  const exactMatch = norm1 === norm2 ? 1.0 : 0.0;
  const levenshteinSim = 1 - (levenshtein(norm1, norm2) / Math.max(norm1.length, norm2.length));
  const tokenOverlap = calculateTokenOverlap(norm1, norm2);

  // 3. Weighted combination
  return (exactMatch * 0.5) + (levenshteinSim * 0.3) + (tokenOverlap * 0.2);
}
```

### Component 4: Session Memory Store

**File:** `src/features/ai/memory/SessionMemoryStore.ts` (NEW)

**Responsibilities:**
- Persist compressed conversation summaries
- Provide fast retrieval by project ID
- Support semantic search (optional enhancement)

**Interface:**
```typescript
interface SessionMemoryStore {
  // CRUD operations
  saveSummary(projectId: string, summary: ConversationSummary): Promise<void>;
  loadSummaries(projectId: string): Promise<ConversationSummary[]>;

  // Search
  searchByKeywords(projectId: string, keywords: string[]): ConversationSummary[];
  searchByTimeRange(projectId: string, start: Date, end: Date): ConversationSummary[];

  // Maintenance
  pruneOldSummaries(projectId: string, keepCount: number): Promise<void>;
}
```

---

## Data Models

### 1. Working Memory Context (Layer 1)

```typescript
interface WorkingMemoryContext {
  // Recent uncompressed messages
  recentMessages: ChatMessage[];           // Last 5-10 turns

  // Active workspace state
  activeFiles: FileContext[];              // Currently open files
  codeSelection?: CodeSelection;           // Selected text
  cursorPosition?: Position;               // Current cursor

  // Current task state
  currentPlan?: TaskPlan;                  // If in planning mode
  activeTask?: Task;                       // Current task being executed

  // Pending suggestions
  pendingSuggestions: CodeSuggestion[];    // Waiting for user to apply

  // Metadata
  tokenCount: number;                      // Estimated tokens in context
  lastUpdated: number;                     // Timestamp
}

interface FileContext {
  path: string;                            // Relative to workspace
  language: string;                        // 'ballerina'
  content: string;                         // Full content
  modified: boolean;                       // Unsaved changes?
  lineCount: number;
}

interface CodeSuggestion {
  id: string;                              // Unique ID
  code: string;                            // Generated code
  files: FileChange[];                     // Which files to modify
  status: 'pending' | 'applied' | 'ignored';
  createdAt: number;
  messageId: string;                       // Source message
  hash: string;                            // SHA256 for deduplication
}
```

### 2. Compressed Turn (Layer 2)

```typescript
interface CompressedTurn {
  id: string;

  // Time range this represents
  messageIds: string[];                    // Original message IDs
  startIndex: number;                      // Turn number (e.g., 6)
  endIndex: number;                        // Turn number (e.g., 10)
  timestamp: number;

  // Compressed content
  summary: string;                         // 150-300 word summary
  keyPoints: string[];                     // Bullet points of key info

  // Structured extractions
  decisions: KeyDecision[];                // Important choices made
  tasksCompleted: string[];                // What was accomplished

  // Code references
  filesModified: string[];                 // Which files touched
  keyCodeSnippets?: CodeSnippet[];         // Important code (if any)

  // Metadata
  originalTokenCount: number;              // Before compression
  compressedTokenCount: number;            // After compression
  compressionRatio: number;                // Savings %
}

interface KeyDecision {
  type: 'port' | 'library' | 'pattern' | 'architecture' | 'other';
  description: string;                     // "Using port 8080 for API"
  messageId: string;                       // Source message
  timestamp: number;
}

interface CodeSnippet {
  language: string;
  code: string;                            // Short snippet (max 20 lines)
  purpose: string;                         // What this code does
}
```

### 3. Conversation Summary (Layer 2)

```typescript
interface ConversationSummary {
  id: string;
  projectId: string;
  sessionId: string;

  // Time span
  startTime: number;
  endTime: number;
  messageCount: number;

  // High-level overview
  goal: string;                            // "Building REST API with auth"
  status: 'in-progress' | 'completed' | 'abandoned';

  // Compressed turns
  compressedTurns: CompressedTurn[];

  // Aggregated data
  allDecisions: KeyDecision[];             // All decisions across turns
  filesCreated: string[];                  // New files
  filesModified: string[];                 // Modified files
  librariesUsed: string[];                 // ballerina/* imports

  // Task tracking
  completedTasks: string[];
  pendingTasks: string[];

  // Metadata
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  overallCompressionRatio: number;
}
```

### 4. Applied Code Index (Layer 3)

```typescript
interface AppliedCodeIndex {
  projectId: string;
  entries: AppliedCodeEntry[];
  lastUpdated: number;
}

interface AppliedCodeEntry {
  // Identification
  id: string;                              // Suggestion ID
  hash: string;                            // SHA256 of normalized code

  // Content
  code: string;                            // Generated code
  normalizedCode: string;                  // Without whitespace/comments

  // Application tracking
  status: 'pending' | 'applied' | 'ignored' | 'superseded';
  appliedAt?: number;                      // Timestamp
  appliedBy: 'user_action' | 'git_detected' | 'file_watch';

  // Git integration
  gitCommitHash?: string;                  // If committed
  gitCommitMessage?: string;

  // File tracking
  files: {
    path: string;
    lineStart: number;
    lineEnd: number;
    operation: 'create' | 'modify' | 'delete';
  }[];

  // Similarity index (for deduplication)
  similarTo: string[];                     // IDs of similar suggestions

  // Metadata
  messageId: string;                       // Source message
  createdAt: number;
  lastChecked: number;
}
```

### 5. Memory Context (Unified for Prompt Building)

```typescript
interface MemoryContext {
  // Layer 1: Working Memory
  recentMessages: ChatMessage[];           // Last 5-10 turns (full detail)
  activeWorkspace: WorkspaceState;

  // Layer 2: Session Memory
  conversationSummaries: CompressedTurn[]; // Older turns (compressed)
  keyDecisions: KeyDecision[];             // Important choices
  taskHistory: TaskHistory;

  // Layer 3: Applied Code
  appliedCodeSummary: {
    totalSuggestions: number;
    appliedCount: number;
    ignoredCount: number;
    recentlyApplied: string[];             // File names
  };

  // Metadata for prompt builder
  estimatedTokens: number;
  compressionSavings: number;              // Tokens saved vs. sending all
}
```

---

## Storage Strategy

### Layer 1: Working Memory (In-Memory)

**Location:** XState context (`aiChatMachine.context`)

**Lifecycle:** Current session only, cleared on extension reload

**Size Limit:** 10-20 recent messages max

**Implementation:**
```typescript
// aiChatMachine.ts
const aiChatMachine = createMachine({
  context: {
    // Existing fields...
    chatHistory: [],

    // NEW: Working memory fields
    workingMemory: {
      recentMessages: [],              // Last 10 messages
      pendingSuggestions: [],
      tokenCount: 0
    }
  }
});
```

### Layer 2: Session Memory (Persistent)

**Primary Storage:** VS Code `globalState`

**Key Format:** `ballerina.ai.memory.{projectId}`

**Backup Storage:** `.ballerina/memory/session-{sessionId}.json` (optional)

**Size Management:**
- Compressed summaries only (not full messages)
- Auto-prune: keep last 100 summaries max
- Per-project limit: 5MB

**Implementation:**
```typescript
// SessionMemoryStore.ts
class SessionMemoryStore {
  async saveSummary(projectId: string, summary: ConversationSummary) {
    const key = `ballerina.ai.memory.${projectId}`;
    const existing = await this.globalState.get<ConversationSummary[]>(key) || [];

    existing.push(summary);

    // Prune if needed
    if (existing.length > 100) {
      existing.splice(0, existing.length - 100);
    }

    await this.globalState.update(key, existing);

    // Optional: backup to file
    if (config.get('ballerina.memory.backupToFile')) {
      await this.backupToFile(projectId, existing);
    }
  }
}
```

### Layer 3: Applied Code Index (Git-Aware)

**Primary Storage:** `.ballerina/memory/applied-code.json`

**Benefits:**
- Version controlled with project
- Shared across team (if committed)
- Survives extension uninstall

**Structure:**
```json
{
  "projectId": "abc123",
  "lastUpdated": 1734000000,
  "entries": [
    {
      "id": "sugg-001",
      "hash": "a3f2c9d...",
      "status": "applied",
      "appliedAt": 1734000000,
      "appliedBy": "git_detected",
      "gitCommitHash": "e4b7a2c...",
      "files": [
        {
          "path": "main.bal",
          "lineStart": 10,
          "lineEnd": 25,
          "operation": "modify"
        }
      ],
      "createdAt": 1733999000
    }
  ]
}
```

**Gitignore Considerations:**
```gitignore
# .gitignore
.ballerina/memory/session-*.json     # Don't commit sessions (too noisy)
# .ballerina/memory/applied-code.json  # DO commit (shared knowledge)
```

### Storage Size Estimates

| Layer | Per Project | For 100 Projects |
|-------|-------------|------------------|
| L1: Working Memory | ~500KB (in-memory) | N/A |
| L2: Session Memory | ~5MB (compressed) | ~500MB |
| L3: Applied Code | ~100KB | ~10MB |
| **Total** | **~5.6MB** | **~510MB** |

### Migration Strategy

**Existing Projects:**
```typescript
async function migrateExistingProject(projectId: string) {
  // 1. Load old chat history
  const oldKey = `ballerina.ai.chat.state.${projectId}`;
  const oldData = await globalState.get(oldKey);

  if (!oldData) return; // Nothing to migrate

  // 2. Compress old messages
  const compressed = await compressionService.compressMessages(oldData.chatHistory);

  // 3. Save to new format
  await sessionMemoryStore.saveSummary(projectId, {
    compressedTurns: compressed,
    allDecisions: extractDecisions(oldData.chatHistory),
    // ... other fields
  });

  // 4. Keep recent messages uncompressed
  const recentMessages = oldData.chatHistory.slice(-10);

  // 5. Update working memory
  aiChatMachine.send('SET_WORKING_MEMORY', { recentMessages });
}
```

---

## Context & Workspace Tracking

### Objective
Capture relevant conversation history and current project state for use by the agent.

### Implementation

#### 1. Conversation History Tracking

**Enhanced Message Structure:**
```typescript
interface EnhancedChatMessage extends ChatMessage {
  // Existing fields
  id: string;
  content: string;
  uiResponse: string;
  timestamp: number;

  // NEW: Enhanced tracking
  metadata: {
    tokenCount: number;              // Estimated tokens
    wasCompressed: boolean;          // Is this a compressed message?
    compressionRatio?: number;       // If compressed
    sourceMessageIds?: string[];     // If this represents multiple messages

    // Context capture
    workspaceState: {
      openFiles: string[];           // Files open when message sent
      modifiedFiles: string[];       // Unsaved changes
      currentFile?: string;          // Active editor
      cursorPosition?: Position;
    };

    // Code tracking
    generatedSuggestions: string[]; // Suggestion IDs created
    referencedSuggestions: string[]; // Suggestions mentioned/modified
  };
}
```

**Capture Point:**
```typescript
// In rpc-manager.ts: generateCode()
async generateCode(params: GenerateCodeParams) {
  // BEFORE sending to LLM
  const workspaceState = await captureWorkspaceState();
  const message: EnhancedChatMessage = {
    id: generateId(),
    content: params.usecase,
    timestamp: Date.now(),
    metadata: {
      tokenCount: estimateTokens(params.usecase),
      wasCompressed: false,
      workspaceState: workspaceState
    }
  };

  // ... continue with LLM call
}

async function captureWorkspaceState(): Promise<WorkspaceState> {
  const openEditors = vscode.window.visibleTextEditors;

  return {
    openFiles: openEditors.map(e => workspace.asRelativePath(e.document.uri)),
    modifiedFiles: openEditors
      .filter(e => e.document.isDirty)
      .map(e => workspace.asRelativePath(e.document.uri)),
    currentFile: vscode.window.activeTextEditor
      ? workspace.asRelativePath(vscode.window.activeTextEditor.document.uri)
      : undefined,
    cursorPosition: vscode.window.activeTextEditor?.selection.active
  };
}
```

#### 2. Project State Tracking

**Enhanced Project Context:**
```typescript
interface EnhancedProjectContext {
  // Existing fields (from getProjectSource)
  projectName: string;
  sourceFiles: SourceFile[];
  projectModules: Module[];

  // NEW: Memory-aware additions
  recentChanges: {
    timestamp: number;
    changedFiles: string[];
    changeType: 'create' | 'modify' | 'delete';
    triggeredByAI: boolean;          // Was this AI-generated?
  }[];

  appliedAICode: {
    totalSuggestions: number;
    appliedCount: number;
    recentlyApplied: {
      file: string;
      lines: [number, number];
      appliedAt: number;
    }[];
  };

  gitInfo?: {
    branch: string;
    lastCommit: string;
    hasUncommittedChanges: boolean;
  };
}
```

**Capture Implementation:**
```typescript
// NEW: src/features/ai/memory/WorkspaceTracker.ts
class WorkspaceTracker {
  private changeHistory: FileChange[] = [];

  activate() {
    // Watch file changes
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId === 'ballerina') {
        this.recordChange({
          file: workspace.asRelativePath(doc.uri),
          timestamp: Date.now(),
          changeType: 'modify',
          triggeredByAI: this.isFromAISuggestion(doc)
        });
      }
    });

    vscode.workspace.onDidCreateFiles(e => {
      e.files.forEach(uri => {
        this.recordChange({
          file: workspace.asRelativePath(uri),
          timestamp: Date.now(),
          changeType: 'create',
          triggeredByAI: this.isFromAISuggestion(uri)
        });
      });
    });
  }

  private isFromAISuggestion(docOrUri: any): boolean {
    // Check if this file was part of recent AI suggestion
    const recentSuggestions = appliedCodeTracker.getRecentSuggestions(60000); // last minute
    // ... implementation
  }

  getRecentChanges(limit: number = 10): FileChange[] {
    return this.changeHistory.slice(-limit);
  }
}
```

#### 3. Active Context Window

**What Gets Sent to LLM:**
```typescript
interface ActiveContext {
  // 1. Immediate context (always included)
  userQuery: string;                       // Current question
  activeFile?: FileContent;                // File currently editing
  codeSelection?: string;                  // Selected code

  // 2. Recent conversation (last 5-10 turns)
  recentMessages: ChatMessage[];

  // 3. Compressed history (older turns)
  conversationSummary: string;             // Condensed version
  keyDecisions: KeyDecision[];             // Important choices

  // 4. Project state
  projectStructure: FileTree;              // Simplified tree
  recentChanges: FileChange[];             // Last 10 changes
  appliedCodeStatus: AppliedCodeSummary;   // What's been applied

  // 5. Relevant memory (if applicable)
  relevantPastWork?: ConversationSummary; // Related past sessions
}
```

**Token Budget Allocation:**
```
Total Budget: 180,000 tokens (leaving 20k buffer)

Allocation:
- System Prompt:           10,000 tokens  (5.5%)
- Project Structure:       15,000 tokens  (8.3%)
- Recent Messages (full):  80,000 tokens  (44.4%)
- Compressed History:      20,000 tokens  (11.1%)
- Active File Context:     30,000 tokens  (16.7%)
- Applied Code Summary:     5,000 tokens  (2.8%)
- User Query:              15,000 tokens  (8.3%)
- Tool Results:             5,000 tokens  (2.8%)
----------------------------------------
TOTAL:                    180,000 tokens  (90% of limit)
```

---

## Applied-Code Detection & Pruning

### Objective
Detect when suggested code has already been applied and remove or down-weight it from future prompts.

### Three Detection Methods

#### Method 1: User Action Tracking (Immediate, 100% Accuracy)

**Trigger:** User clicks "Apply" button in UI

**Flow:**
```
User clicks "Apply"
    ↓
UI sends RPC request: applyCodeChanges(suggestionId, fileChanges)
    ↓
Extension writes files to disk
    ↓
Applied Code Tracker: markApplied(suggestionId, 'user_action')
    ↓
Update Applied Code Index
    ↓
Notify Memory Manager
```

**Code:**
```typescript
// In rpc-manager.ts
async applyCodeChanges(suggestionId: string, fileChanges: FileChange[]) {
  // 1. Write files
  for (const change of fileChanges) {
    const fullPath = path.join(workspace.rootPath, change.path);
    await fs.writeFile(fullPath, change.content);
  }

  // 2. Track application
  await appliedCodeTracker.markApplied(suggestionId, {
    method: 'user_action',
    timestamp: Date.now(),
    files: fileChanges.map(fc => fc.path)
  });

  // 3. Trigger Git detection (async)
  setTimeout(() => this.detectGitCommit(suggestionId), 5000);
}
```

#### Method 2: Git Commit Analysis (Batch, High Accuracy)

**Trigger:** Background job every 30 seconds

**Flow:**
```
Background Job Timer
    ↓
Get last 10 Git commits
    ↓
For each commit:
  Get diff (added/modified lines)
    ↓
  Compare with pending suggestions
    ↓
  Calculate similarity score
    ↓
  If similarity > 80%: mark as applied
```

**Code:**
```typescript
// NEW: src/features/ai/memory/GitIntegration.ts
class GitIntegration {
  private git: SimpleGit;

  async detectAppliedCode() {
    const pending = appliedCodeTracker.getPendingSuggestions();
    if (pending.length === 0) return;

    const commits = await this.git.log({ maxCount: 10 });

    for (const commit of commits) {
      const diff = await this.git.diff([`${commit.hash}^`, commit.hash]);
      const addedLines = this.extractAddedLines(diff);

      for (const suggestion of pending) {
        const similarity = this.calculateSimilarity(
          addedLines,
          suggestion.normalizedCode
        );

        if (similarity > 0.8) {
          await appliedCodeTracker.markApplied(suggestion.id, {
            method: 'git_detected',
            gitCommitHash: commit.hash,
            gitCommitMessage: commit.message,
            timestamp: Date.now()
          });
        }
      }
    }
  }

  private extractAddedLines(diff: string): string {
    return diff
      .split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .map(line => line.substring(1))
      .join('\n');
  }

  private calculateSimilarity(code1: string, code2: string): number {
    const norm1 = this.normalizeCode(code1);
    const norm2 = this.normalizeCode(code2);

    // Use Levenshtein distance
    const distance = levenshtein(norm1, norm2);
    const maxLength = Math.max(norm1.length, norm2.length);

    return 1 - (distance / maxLength);
  }

  private normalizeCode(code: string): string {
    return code
      .replace(/\/\/.*$/gm, '')          // Remove comments
      .replace(/\s+/g, ' ')              // Normalize whitespace
      .trim()
      .toLowerCase();
  }
}
```

#### Method 3: File Watcher (Real-time, Medium Accuracy)

**Trigger:** File save event

**Flow:**
```
User saves .bal file
    ↓
VS Code: onDidSaveTextDocument event
    ↓
Read file content
    ↓
Compare with pending suggestions
    ↓
If contains suggestion code: mark as applied
```

**Code:**
```typescript
// In WorkspaceTracker.ts
vscode.workspace.onDidSaveTextDocument(async (document) => {
  if (document.languageId !== 'ballerina') return;

  const content = document.getText();
  const pending = appliedCodeTracker.getPendingSuggestions();

  for (const suggestion of pending) {
    // Check if suggestion code appears in file
    if (this.containsCode(content, suggestion.normalizedCode)) {
      await appliedCodeTracker.markApplied(suggestion.id, {
        method: 'file_watch',
        file: workspace.asRelativePath(document.uri),
        timestamp: Date.now()
      });
    }
  }
});

private containsCode(fileContent: string, suggestionCode: string): boolean {
  const normalizedFile = this.normalizeCode(fileContent);
  const normalizedSuggestion = this.normalizeCode(suggestionCode);

  // Check for substring match with some tolerance
  return normalizedFile.includes(normalizedSuggestion.substring(0, Math.min(100, normalizedSuggestion.length)));
}
```

### Pruning Strategy

#### When to Prune

**Before Building Prompt:**
```typescript
// In MemoryManager.ts: buildContextForPrompt()
async buildContextForPrompt(userQuery: string): Promise<MemoryContext> {
  // 1. Load full context
  const rawContext = await this.loadRawContext();

  // 2. Filter out applied code
  const filteredMessages = this.pruneAppliedCode(rawContext.messages);

  // 3. Build final context
  return {
    recentMessages: filteredMessages,
    appliedCodeSummary: {
      totalSuggestions: appliedCodeTracker.getTotalCount(),
      appliedCount: appliedCodeTracker.getAppliedCount(),
      recentlyApplied: appliedCodeTracker.getRecentlyApplied(10)
    }
  };
}
```

#### Pruning Algorithm

```typescript
private pruneAppliedCode(messages: ChatMessage[]): ChatMessage[] {
  const applied = appliedCodeTracker.getAppliedEntries();
  const appliedSet = new Set(applied.map(a => a.messageId));

  return messages.map(msg => {
    // If this message generated applied code
    if (appliedSet.has(msg.id)) {
      // Replace code blocks with summary
      return {
        ...msg,
        uiResponse: this.summarizeAppliedCode(msg, applied)
      };
    }
    return msg;
  });
}

private summarizeAppliedCode(
  message: ChatMessage,
  appliedEntries: AppliedCodeEntry[]
): string {
  const relevant = appliedEntries.filter(a => a.messageId === message.id);

  if (relevant.length === 0) return message.uiResponse;

  // Replace code blocks with summary
  return `[Code from this turn was applied to: ${relevant.map(r => r.files.map(f => f.path).join(', ')).join('; ')}]

Original user request: ${message.content}`;
}
```

### Down-Weighting Strategy

Instead of completely removing, we can down-weight:

```typescript
interface WeightedMessage {
  message: ChatMessage;
  weight: number;  // 0.0 to 1.0
}

function calculateMessageWeight(message: ChatMessage): number {
  const suggestions = message.metadata.generatedSuggestions || [];

  if (suggestions.length === 0) return 1.0; // No code, full weight

  const appliedCount = suggestions.filter(s =>
    appliedCodeTracker.getStatus(s) === 'applied'
  ).length;

  const appliedRatio = appliedCount / suggestions.length;

  // Down-weight based on how much code was applied
  return Math.max(0.2, 1.0 - (appliedRatio * 0.8));
  // Result: 100% applied = 0.2 weight, 0% applied = 1.0 weight
}
```

---

## Conversation Summarization

### Objective
Summarize long chats into concise task summaries, design decisions, and TODOs to keep prompts small but informative.

### When to Summarize

**Trigger Conditions:**
1. **Turn Count:** Every 5 turns
2. **Token Threshold:** When working memory > 150k tokens
3. **Session End:** When user closes AI panel
4. **Manual:** User clicks "Summarize Session"

**Code:**
```typescript
// In aiChatMachine.ts: after message added
actions: {
  addMessage: assign((context, event) => {
    const newHistory = [...context.chatHistory, event.message];

    // Check if summarization needed
    if (newHistory.length % 5 === 0) {
      // Trigger async summarization
      setTimeout(() => memoryManager.compressOldMessages(), 0);
    }

    return { chatHistory: newHistory };
  })
}
```

### Summarization Algorithm

#### Step 1: Grouping

```typescript
function groupMessagesForSummarization(
  messages: ChatMessage[]
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: ChatMessage[] = [];
  let currentTopic: string | undefined;

  for (const msg of messages) {
    const topic = extractTopic(msg);

    if (!currentTopic || topic === currentTopic) {
      currentGroup.push(msg);
      currentTopic = topic;
    } else {
      // Topic changed, create new group
      if (currentGroup.length > 0) {
        groups.push({
          topic: currentTopic,
          messages: currentGroup,
          startIndex: groups.reduce((sum, g) => sum + g.messages.length, 0)
        });
      }
      currentGroup = [msg];
      currentTopic = topic;
    }
  }

  if (currentGroup.length > 0) {
    groups.push({
      topic: currentTopic,
      messages: currentGroup,
      startIndex: groups.reduce((sum, g) => sum + g.messages.length, 0)
    });
  }

  return groups;
}

function extractTopic(message: ChatMessage): string {
  // Simple keyword extraction
  const keywords = ['REST', 'API', 'database', 'authentication', 'test', 'error'];
  const content = message.content.toLowerCase();

  for (const keyword of keywords) {
    if (content.includes(keyword)) return keyword;
  }

  return 'general';
}
```

#### Step 2: Summarization with LLM

**Use Claude Haiku** (fast, cheap):

```typescript
async function summarizeMessageGroup(
  group: MessageGroup
): Promise<CompressedTurn> {
  const prompt = `
Summarize this conversation segment about "${group.topic}".

Messages:
${group.messages.map((m, i) => `
Turn ${i + 1}:
User: ${m.content}
Assistant: ${m.uiResponse}
`).join('\n')}

Provide:
1. Brief Summary (150 words max): What was discussed and what was accomplished
2. Key Points (bullet points):
   - Main questions asked
   - Code generated (brief description)
   - Decisions made (libraries, ports, patterns)
3. Tasks Completed (list)
4. Open TODOs (if any mentioned)
5. Files Modified (list file names only)

Format as JSON:
{
  "summary": "...",
  "keyPoints": ["...", "..."],
  "decisions": [{"type": "library", "description": "..."}, ...],
  "tasksCompleted": ["..."],
  "openTODOs": ["..."],
  "filesModified": ["..."]
}
`;

  const response = await streamText({
    model: anthropicClient('claude-3-5-haiku-20241022'),
    prompt: prompt,
    temperature: 0.3, // Low temperature for factual summary
    maxTokens: 1000
  });

  const result = JSON.parse(response.text);

  return {
    id: generateId(),
    messageIds: group.messages.map(m => m.id),
    startIndex: group.startIndex,
    endIndex: group.startIndex + group.messages.length - 1,
    timestamp: Date.now(),
    summary: result.summary,
    keyPoints: result.keyPoints,
    decisions: result.decisions,
    tasksCompleted: result.tasksCompleted,
    filesModified: result.filesModified,
    originalTokenCount: estimateTokens(group.messages),
    compressedTokenCount: estimateTokens(result.summary),
    compressionRatio: 0 // calculated after
  };
}
```

#### Step 3: Structured Extraction

**Extract Key Information:**

```typescript
function extractDecisions(messages: ChatMessage[]): KeyDecision[] {
  const decisions: KeyDecision[] = [];

  const patterns = {
    port: /port\s+(\d+)/gi,
    library: /import\s+ballerina\/(\w+)/gi,
    pattern: /using\s+(\w+)\s+pattern/gi,
    architecture: /decided.*(?:microservice|monolith|serverless)/gi
  };

  for (const msg of messages) {
    const combined = `${msg.content} ${msg.uiResponse}`;

    // Extract ports
    let match;
    while ((match = patterns.port.exec(combined)) !== null) {
      decisions.push({
        type: 'port',
        description: `Using port ${match[1]}`,
        messageId: msg.id,
        timestamp: msg.timestamp
      });
    }

    // Extract libraries
    while ((match = patterns.library.exec(combined)) !== null) {
      decisions.push({
        type: 'library',
        description: `Using ballerina/${match[1]} library`,
        messageId: msg.id,
        timestamp: msg.timestamp
      });
    }

    // ... other patterns
  }

  // Deduplicate
  return deduplicateDecisions(decisions);
}

function extractTasksCompleted(messages: ChatMessage[]): string[] {
  const tasks: string[] = [];

  const completionPhrases = [
    /(?:added|created|implemented|fixed|updated)\s+(.+?)(?:\.|$)/gi,
    /(?:now have|successfully)\s+(.+?)(?:\.|$)/gi
  ];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const pattern of completionPhrases) {
        let match;
        while ((match = pattern.exec(msg.uiResponse)) !== null) {
          tasks.push(match[1].trim());
        }
      }
    }
  }

  return tasks;
}
```

### Compression Statistics

**Example Results:**

```
Original (5 turns):
- Turn 6-10
- Total tokens: 12,500
- Content: Full user questions + full AI responses

Compressed:
- Summary: 250 words
- Key points: 8 bullets
- Decisions: 3 extracted
- Tasks: 4 completed
- Total tokens: 800

Compression Ratio: 93.6% reduction ✅
```

---

## Memory Retrieval & Prompt Integration

### Objective
Store and retrieve per-project memories and inject them into prompts to improve answer quality in later turns.

### Retrieval Strategy

#### When to Retrieve

1. **Session Start:** Load recent summaries for continuity
2. **Contextual Query:** User asks about past work
3. **Periodic Refresh:** Every 10 turns, refresh relevant memories

#### Retrieval Methods

**Method 1: Recency-Based** (Fast, Simple)

```typescript
async function getRecentSummaries(
  projectId: string,
  limit: number = 5
): Promise<ConversationSummary[]> {
  const allSummaries = await sessionMemoryStore.loadSummaries(projectId);

  return allSummaries
    .sort((a, b) => b.endTime - a.endTime)
    .slice(0, limit);
}
```

**Method 2: Keyword-Based** (Medium Complexity)

```typescript
async function searchByKeywords(
  projectId: string,
  query: string
): Promise<ConversationSummary[]> {
  const keywords = extractKeywords(query);
  const allSummaries = await sessionMemoryStore.loadSummaries(projectId);

  return allSummaries
    .map(summary => ({
      summary,
      score: calculateKeywordScore(summary, keywords)
    }))
    .filter(item => item.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(item => item.summary);
}

function calculateKeywordScore(
  summary: ConversationSummary,
  keywords: string[]
): number {
  const text = [
    summary.goal,
    ...summary.compressedTurns.map(t => t.summary),
    ...summary.allDecisions.map(d => d.description)
  ].join(' ').toLowerCase();

  const matches = keywords.filter(kw => text.includes(kw.toLowerCase()));
  return matches.length / keywords.length;
}
```

**Method 3: Semantic Search** (Optional, High Accuracy)

```typescript
// Requires embeddings (future enhancement)
async function searchBySemantic(
  projectId: string,
  query: string
): Promise<ConversationSummary[]> {
  // 1. Generate embedding for query
  const queryEmbedding = await generateEmbedding(query);

  // 2. Load summaries with embeddings
  const summaries = await sessionMemoryStore.loadSummariesWithEmbeddings(projectId);

  // 3. Calculate cosine similarity
  const scored = summaries.map(summary => ({
    summary,
    similarity: cosineSimilarity(queryEmbedding, summary.embedding)
  }));

  // 4. Return top matches
  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .map(item => item.summary);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}
```

### Prompt Integration

#### Building Enhanced System Prompt

```typescript
async function buildEnhancedSystemPrompt(
  userQuery: string,
  projectContext: ProjectContext,
  memoryContext: MemoryContext
): Promise<string> {
  const sections: string[] = [];

  // 1. Base instructions
  sections.push(`You are an expert Ballerina programming assistant for the Ballerina Copilot agent mode.`);

  // 2. Project context
  sections.push(`
## Current Project: ${projectContext.projectName}

Project Structure:
${formatProjectTree(projectContext.sourceFiles)}

Recent Changes:
${formatRecentChanges(memoryContext.activeWorkspace.recentChanges)}
`);

  // 3. Applied code status (IMPORTANT)
  if (memoryContext.appliedCodeSummary.appliedCount > 0) {
    sections.push(`
## Applied Code Status

You have previously generated ${memoryContext.appliedCodeSummary.totalSuggestions} suggestions.
${memoryContext.appliedCodeSummary.appliedCount} have been applied by the user.

Recently applied code:
${memoryContext.appliedCodeSummary.recentlyApplied.map(f => `- ${f}`).join('\n')}

IMPORTANT: Do NOT re-suggest code that has already been applied.
`);
  }

  // 4. Conversation summaries (compressed history)
  if (memoryContext.conversationSummaries.length > 0) {
    sections.push(`
## Previous Work on This Project

${memoryContext.conversationSummaries.map(turn => `
### Session ${turn.startIndex}-${turn.endIndex}
${turn.summary}

Key Decisions:
${turn.decisions.map(d => `- ${d.description}`).join('\n')}

Tasks Completed:
${turn.tasksCompleted.map(t => `- ${t}`).join('\n')}
`).join('\n')}
`);
  }

  // 5. Key decisions (aggregated)
  if (memoryContext.keyDecisions.length > 0) {
    sections.push(`
## Key Project Decisions

${formatDecisionsByType(memoryContext.keyDecisions)}
`);
  }

  return sections.join('\n\n');
}

function formatDecisionsByType(decisions: KeyDecision[]): string {
  const byType = groupBy(decisions, 'type');

  return Object.entries(byType)
    .map(([type, decs]) => `
${capitalizeFirst(type)}:
${decs.map(d => `- ${d.description}`).join('\n')}
    `)
    .join('\n');
}
```

#### Building User Message with Context

```typescript
async function buildUserMessage(
  userQuery: string,
  workingMemory: WorkingMemoryContext
): Promise<string> {
  const parts: string[] = [];

  // 1. Current workspace state
  if (workingMemory.activeFiles.length > 0) {
    parts.push(`
## Currently Open Files
${workingMemory.activeFiles.map(f => `- ${f.path} (${f.lineCount} lines${f.modified ? ', modified' : ''})`).join('\n')}
`);
  }

  // 2. Code selection (if any)
  if (workingMemory.codeSelection) {
    parts.push(`
## Selected Code
File: ${workingMemory.codeSelection.file}
Lines: ${workingMemory.codeSelection.startLine}-${workingMemory.codeSelection.endLine}

\`\`\`ballerina
${workingMemory.codeSelection.code}
\`\`\`
`);
  }

  // 3. Current task (if in planning mode)
  if (workingMemory.currentPlan) {
    parts.push(`
## Current Plan Progress
${workingMemory.currentPlan.tasks.map((t, i) =>
  `${i + 1}. [${t.status === 'completed' ? 'x' : ' '}] ${t.description}`
).join('\n')}

Currently working on: ${workingMemory.activeTask?.description}
`);
  }

  // 4. User query
  parts.push(`
## User Request
${userQuery}
`);

  return parts.join('\n\n');
}
```

#### Final Message Array

```typescript
async function buildCompleteMessageArray(
  userQuery: string,
  memoryContext: MemoryContext
): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [];

  // 1. Enhanced system prompt
  messages.push({
    role: 'system',
    content: await buildEnhancedSystemPrompt(userQuery, projectContext, memoryContext),
    providerOptions: {
      cache_control: { type: 'ephemeral' } // Anthropic prompt caching
    }
  });

  // 2. Recent messages (last 5-10 turns, full detail)
  for (const msg of memoryContext.recentMessages) {
    messages.push(
      { role: 'user', content: msg.content },
      { role: 'assistant', content: msg.uiResponse }
    );
  }

  // 3. Current user message (with context)
  messages.push({
    role: 'user',
    content: await buildUserMessage(userQuery, memoryContext.activeWorkspace)
  });

  return messages;
}
```

### Token Budget Management

```typescript
class TokenBudgetManager {
  private readonly MAX_TOKENS = 180_000; // 90% of 200k limit

  async optimizeContext(
    memoryContext: MemoryContext
  ): Promise<MemoryContext> {
    let currentTokens = estimateTokens(memoryContext);

    if (currentTokens <= this.MAX_TOKENS) {
      return memoryContext; // Under budget, no changes
    }

    // Strategy 1: Reduce recent messages
    if (memoryContext.recentMessages.length > 5) {
      const removed = memoryContext.recentMessages.splice(0, 5);
      // Compress removed messages
      const compressed = await compressionService.compressMessages(removed);
      memoryContext.conversationSummaries.unshift(compressed);
      currentTokens = estimateTokens(memoryContext);
    }

    if (currentTokens <= this.MAX_TOKENS) return memoryContext;

    // Strategy 2: Reduce conversation summaries
    if (memoryContext.conversationSummaries.length > 10) {
      memoryContext.conversationSummaries.splice(0, memoryContext.conversationSummaries.length - 10);
      currentTokens = estimateTokens(memoryContext);
    }

    if (currentTokens <= this.MAX_TOKENS) return memoryContext;

    // Strategy 3: Reduce active file content
    for (const file of memoryContext.activeWorkspace.activeFiles) {
      if (file.content.length > 5000) {
        file.content = this.truncateFile(file.content, 5000);
      }
    }

    return memoryContext;
  }

  private truncateFile(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;

    return content.substring(0, maxChars) + '\n\n[... truncated ...]';
  }
}
```

---

## Integration with Existing Code

### Integration Points

#### 1. AI Chat State Machine (`aiChatMachine.ts`)

**Add Memory-Aware States:**

```typescript
// BEFORE: Simple states
states: {
  Idle: {},
  GeneratingPlan: {},
  ExecutingPlan: {}
}

// AFTER: Memory-aware states
states: {
  Idle: {
    entry: ['loadWorkingMemory']
  },

  AddingMessage: {
    entry: ['addToWorkingMemory', 'checkCompressionNeeded']
  },

  GeneratingPlan: {
    entry: ['buildMemoryContext'],
    invoke: {
      src: 'generateWithMemory',
      onDone: 'ExecutingPlan'
    }
  },

  CompressionInProgress: {  // NEW STATE
    invoke: {
      src: 'compressOldMessages',
      onDone: 'Idle',
      onError: 'Idle'
    }
  }
}
```

**Add Memory Context:**

```typescript
// BEFORE
context: {
  chatHistory: [],
  currentPlan: undefined
}

// AFTER
context: {
  chatHistory: [],           // Still kept for UI display
  currentPlan: undefined,

  // NEW: Memory layer context
  workingMemory: {
    recentMessages: [],
    pendingSuggestions: [],
    tokenCount: 0
  },
  memoryStats: {
    totalMessages: 0,
    compressedCount: 0,
    compressionRatio: 0,
    appliedSuggestions: 0
  }
}
```

#### 2. RPC Manager (`rpc-manager.ts`)

**Enhanced generateCode Method:**

```typescript
// BEFORE: Simple flow
async generateCode(params: GenerateCodeParams) {
  const chatHistory = await loadChatState(projectId);
  const messages = buildMessages(chatHistory);
  const response = await claude.message({ messages });
  await saveChatState({ ...chatHistory, newMessage });
}

// AFTER: Memory-aware flow
async generateCode(params: GenerateCodeParams) {
  // 1. Load memory context (replaces simple chatHistory load)
  const memoryContext = await memoryManager.buildContextForPrompt(params.usecase);

  // 2. Build optimized messages (with compression, pruning)
  const messages = await buildMemoryAwareMessages(memoryContext);

  // 3. Call LLM
  const response = await claude.message({ messages });

  // 4. Track generated code
  const suggestionId = await appliedCodeTracker.registerSuggestion({
    code: extractCode(response),
    messageId: generateId()
  });

  // 5. Save with memory metadata
  await memoryManager.addMessage({
    content: params.usecase,
    uiResponse: response.content,
    metadata: {
      tokenCount: response.usage.input_tokens,
      generatedSuggestions: [suggestionId],
      workspaceState: await captureWorkspaceState()
    }
  });

  // 6. Trigger async compression if needed
  if (memoryManager.shouldCompress()) {
    setTimeout(() => memoryManager.compressOldMessages(), 0);
  }
}
```

#### 3. Chat Persistence (`chatStatePersistence.ts`)

**Enhanced Save/Load:**

```typescript
// BEFORE: Simple save
async function saveChatState(state: ChatState) {
  const key = `ballerina.ai.chat.state.${state.projectId}`;
  await globalState.update(key, state);
}

// AFTER: Memory-aware save
async function saveChatState(state: ChatState) {
  // Save chat state (existing)
  const chatKey = `ballerina.ai.chat.state.${state.projectId}`;
  await globalState.update(chatKey, state);

  // Save memory context (new)
  const memoryKey = `ballerina.ai.memory.${state.projectId}`;
  const memoryState = memoryManager.getSessionMemory(state.projectId);
  await globalState.update(memoryKey, memoryState);

  // Save applied code index to file (new)
  await appliedCodeTracker.persistToFile(state.projectId);
}

// BEFORE: Simple load
async function loadChatState(projectId: string) {
  const key = `ballerina.ai.chat.state.${projectId}`;
  return await globalState.get(key);
}

// AFTER: Memory-aware load
async function loadChatState(projectId: string) {
  // Load chat state
  const chatKey = `ballerina.ai.chat.state.${projectId}`;
  const chatState = await globalState.get(chatKey);

  // Load memory context
  const memoryKey = `ballerina.ai.memory.${projectId}`;
  const memoryState = await globalState.get(memoryKey);

  // Load applied code index
  const appliedCode = await appliedCodeTracker.loadFromFile(projectId);

  // Initialize memory manager
  memoryManager.initialize({
    chatState,
    memoryState,
    appliedCode
  });

  return chatState;
}
```

#### 4. Extension Activation (`extension.ts`)

**Initialize Memory Layer:**

```typescript
export async function activate(context: ExtensionContext) {
  // Existing initialization...

  // NEW: Initialize memory layer
  const memoryManager = new MemoryManager(context);
  const appliedCodeTracker = new AppliedCodeTracker(context);
  const compressionService = new CompressionService(getAnthropicClient);
  const workspaceTracker = new WorkspaceTracker();
  const gitIntegration = new GitIntegration(workspace.rootPath);

  // Register memory components globally
  registerMemoryComponents({
    memoryManager,
    appliedCodeTracker,
    compressionService,
    workspaceTracker,
    gitIntegration
  });

  // Start background jobs
  gitIntegration.startWatching();
  workspaceTracker.activate();

  // Cleanup on deactivation
  context.subscriptions.push({
    dispose: () => {
      gitIntegration.stopWatching();
      workspaceTracker.deactivate();
    }
  });

  // Rest of activation...
}
```

### File Structure Changes

**New Files to Create:**

```
src/features/ai/memory/
├── MemoryManager.ts              [Main orchestrator]
├── CompressionService.ts         [Message compression]
├── AppliedCodeTracker.ts         [Code tracking]
├── SessionMemoryStore.ts         [Persistent storage]
├── WorkspaceTracker.ts           [File/workspace watching]
├── GitIntegration.ts             [Git commit analysis]
├── TokenBudgetManager.ts         [Token optimization]
└── types.ts                      [Type definitions]

src/features/ai/memory/backends/  [Future: pluggable backends]
├── VSCodeStateBackend.ts         [GlobalState (default)]
├── FileSystemBackend.ts          [.ballerina/ folder]
└── CloudBackend.ts               [Future: team sharing]

.ballerina/memory/                [Project-level storage]
├── applied-code.json             [Applied code index]
└── sessions/                     [Optional backups]
    └── session-{id}.json
```

**Modified Files:**

```
src/views/ai-panel/
├── aiChatMachine.ts              [Add memory states]
├── chatStatePersistence.ts       [Enhance save/load]
└── codeContextUtils.ts           [Add workspace capture]

src/rpc-managers/ai-panel/
└── rpc-manager.ts                [Memory-aware generateCode]

src/extension.ts                  [Initialize memory layer]
```

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Set up core infrastructure without breaking existing functionality

**Tasks:**
1. Create memory component structure
2. Implement basic MemoryManager (empty methods)
3. Add memory context to aiChatMachine
4. Enhance chatStatePersistence with memory hooks
5. Write comprehensive tests for data models

**Deliverables:**
- [ ] Memory folder structure created
- [ ] TypeScript interfaces defined
- [ ] Integration points identified and stubbed
- [ ] Tests passing for data models
- [ ] No regressions in existing functionality

**Success Criteria:**
- Extension still works exactly as before
- Memory components exist but don't affect behavior yet
- Code compiles and all tests pass

---

### Phase 2: Applied Code Tracking (Weeks 3-4)

**Goal:** Implement detection and tracking of applied code

**Tasks:**
1. Implement AppliedCodeTracker core
2. Add user action tracking (applyCodeChanges RPC)
3. Implement file watcher for real-time detection
4. Add Git integration (simple commit analysis)
5. Create applied-code.json persistence
6. Add UI indicators for applied code

**Deliverables:**
- [ ] AppliedCodeTracker fully functional
- [ ] All three detection methods working
- [ ] Applied code persisted to file
- [ ] UI shows "Code Applied" status
- [ ] Tests for all detection methods

**Success Criteria:**
- 95%+ accuracy on user action tracking
- 80%+ accuracy on Git commit detection
- Zero false positives on file watching
- Performance: <50ms overhead per file save

**Metrics to Track:**
```
Applied Code Detection Accuracy:
- User Actions: X/Y detected correctly
- Git Commits: X/Y detected correctly
- File Watching: X/Y detected correctly

False Positive Rate: X%
False Negative Rate: X%
```

---

### Phase 3: Conversation Compression (Weeks 5-6)

**Goal:** Implement message compression to prevent token overflow

**Tasks:**
1. Implement CompressionService
2. Add message grouping algorithm
3. Integrate with Claude Haiku for summarization
4. Implement structured extraction (decisions, tasks)
5. Add compression triggers to aiChatMachine
6. Create compression statistics dashboard (debug view)

**Deliverables:**
- [ ] CompressionService working
- [ ] Automatic compression every 5 turns
- [ ] Summaries saved to session memory
- [ ] Token usage reduced by 30-40%
- [ ] Compression stats visible in UI

**Success Criteria:**
- Compression ratio: 80-90% reduction
- Summarization quality: preserves key information
- No loss of important context
- Compression happens in background (<2 seconds)

**Metrics to Track:**
```
Compression Statistics (per session):
- Original tokens: X
- Compressed tokens: Y
- Compression ratio: Z%
- Information loss: Manual evaluation (1-5 scale)

Performance:
- Compression time: X ms
- Background processing: Yes/No
- User-perceived latency: X ms
```

---

### Phase 4: Prompt Integration (Weeks 7-8)

**Goal:** Use memory layer to build optimized prompts

**Tasks:**
1. Implement buildContextForPrompt in MemoryManager
2. Enhance system prompt with memory context
3. Implement applied code pruning in prompt building
4. Add token budget management
5. Integrate with existing generateCode flow
6. Test multi-turn conversations (20+ turns)

**Deliverables:**
- [ ] Memory-aware prompt building working
- [ ] Applied code filtered from prompts
- [ ] Token budget enforced
- [ ] Multi-turn conversations stable
- [ ] No token overflow errors

**Success Criteria:**
- Can handle 30+ turn conversations without overflow
- Applied code never re-suggested
- Context stays relevant across turns
- Response quality maintained or improved

**Metrics to Track:**
```
Prompt Statistics:
- Average prompt size (tokens): X
- Token budget utilization: X%
- Overflow incidents: 0

Quality:
- Duplicate suggestions: 0
- Context relevance: Manual evaluation
- User satisfaction: Survey
```

---

### Phase 5: Session Memory (Weeks 9-10)

**Goal:** Implement cross-session memory persistence

**Tasks:**
1. Implement SessionMemoryStore
2. Add session summarization (on close)
3. Implement memory retrieval (recency, keyword)
4. Add memory loading on session start
5. Create memory UI (browse, search, delete)
6. Add memory export/import

**Deliverables:**
- [ ] Session summaries persist across restarts
- [ ] Memory loaded on new session
- [ ] Memory browser UI functional
- [ ] Export/import working
- [ ] Memory pruning to prevent bloat

**Success Criteria:**
- Session memory survives VS Code restart
- Relevant memories retrieved in <100ms
- Memory size stays under 5MB per project
- UI intuitive and fast

---

### Phase 6: Testing & Optimization (Weeks 11-12)

**Goal:** Ensure reliability, performance, and user experience

**Tasks:**
1. Write comprehensive integration tests
2. Performance profiling and optimization
3. Security audit (no PII in memories)
4. User acceptance testing (internal)
5. Documentation (architecture, API, user guide)
6. Bug fixes and polish

**Deliverables:**
- [ ] 90%+ code coverage
- [ ] Performance benchmarks met
- [ ] Security review passed
- [ ] User documentation complete
- [ ] Known issues resolved

**Success Criteria:**
- Zero memory leaks
- <100ms overhead on all operations
- No security vulnerabilities
- Positive feedback from beta users

---

## Performance & Cost Analysis

### Token Cost Analysis

**Current (Without Memory Layer):**
```
Turn 1:  10,000 tokens × $0.003/1k = $0.030
Turn 5:  50,000 tokens × $0.003/1k = $0.150
Turn 10: 100,000 tokens × $0.003/1k = $0.300
Turn 15: 200,000 tokens × $0.003/1k = $0.600 (FAILS)

20-turn session cost: ~$4.50
```

**With Memory Layer:**
```
Turn 1:  10,000 tokens × $0.003/1k = $0.030
Turn 5:  50,000 tokens × $0.003/1k = $0.150
Turn 10: 65,000 tokens × $0.003/1k = $0.195 (compressed)
Turn 15: 70,000 tokens × $0.003/1k = $0.210 (compressed)
Turn 20: 75,000 tokens × $0.003/1k = $0.225 (compressed)

20-turn session cost: ~$2.70

Savings: 40% reduction ✅
```

**Compression Costs:**
```
Using Claude Haiku for summarization:
- Cost: $0.00025 per 1k tokens
- Per compression (5 turns): ~10k tokens = $0.0025
- 20-turn session: 3 compressions = $0.0075

Total session cost WITH compression: $2.70 + $0.01 = $2.71
Still 40% cheaper than without ✅
```

### Performance Benchmarks

**Target Performance:**

| Operation | Target | Acceptable | Unacceptable |
|-----------|--------|------------|--------------|
| Load working memory | <50ms | <100ms | >200ms |
| Save message | <100ms | <200ms | >500ms |
| Compress messages | <2s | <5s | >10s |
| Detect applied code | <50ms | <100ms | >200ms |
| Build prompt context | <200ms | <500ms | >1s |
| Search memories | <100ms | <200ms | >500ms |

**Expected Performance:**
```
Load working memory:       ~30ms   ✅
Save message:             ~80ms   ✅
Compress messages:         ~1.5s  ✅ (background)
Detect applied code:       ~40ms  ✅
Build prompt context:      ~150ms ✅
Search memories:           ~90ms  ✅
```

### Storage Requirements

**Per-Project Storage:**
```
Working Memory (in-memory):      ~500KB
Session Memory (globalState):   ~5MB
Applied Code Index (file):      ~100KB
---------------------------------------------
Total per project:              ~5.6MB
```

**For 100 Projects:**
```
Session Memory:   500MB
Applied Code:     10MB
---------------------
Total:            510MB (acceptable)
```

**VS Code Limits:**
- globalState limit: ~50MB per extension (we use ~50MB for 10 projects)
- Workspace storage: unlimited

---

## Risk Mitigation

### Risk 1: Compression Loses Important Context

**Probability:** Medium
**Impact:** High

**Mitigation:**
1. **Preserve Recent Messages:** Never compress last 5-10 turns
2. **Structured Extraction:** Extract decisions, tasks explicitly
3. **Reference Links:** Keep message IDs in compressed turns
4. **Fallback:** If quality degrades, reduce compression ratio
5. **User Control:** Setting to disable compression

**Testing:**
- Manual evaluation of compression quality
- A/B testing: responses with/without compression
- Track: "Did LLM forget important context?" incidents

---

### Risk 2: Applied Code Detection False Positives

**Probability:** Medium
**Impact:** Medium

**Scenario:** Code marked as "applied" when user actually rejected it

**Mitigation:**
1. **Require High Similarity:** 80%+ threshold for Git detection
2. **User Override:** UI to mark code as "not applied"
3. **Time Window:** Only check recent commits (last 10)
4. **Manual Trigger:** User explicitly clicks "Apply"
5. **Logging:** Track all detections for debugging

**Testing:**
- Test with similar but not identical code
- Test with partial application
- Test with manual edits after application

---

### Risk 3: Token Budget Overflow (Still Happens)

**Probability:** Low
**Impact:** High

**Scenario:** Even with compression, very long sessions hit limits

**Mitigation:**
1. **Hard Limit:** TokenBudgetManager enforces 180k cap
2. **Aggressive Compression:** If near limit, compress more aggressively
3. **Session Splitting:** Suggest starting new session after 50 turns
4. **Emergency Truncation:** If all else fails, truncate oldest content
5. **User Warning:** Show token usage in UI

**Fallback Strategy:**
```typescript
if (estimatedTokens > 180_000) {
  // Emergency measures
  context.conversationSummaries = context.conversationSummaries.slice(-5);
  context.recentMessages = context.recentMessages.slice(-3);
  context.activeFiles = context.activeFiles.slice(0, 2);

  if (estimatedTokens > 180_000) {
    throw new Error('Session too long. Please start a new conversation.');
  }
}
```

---

### Risk 4: Performance Degradation

**Probability:** Low
**Impact:** Medium

**Scenario:** Memory operations add noticeable latency

**Mitigation:**
1. **Async Operations:** All compression/saving in background
2. **Caching:** Cache frequently accessed memories
3. **Lazy Loading:** Only load memories when needed
4. **Profiling:** Regular performance monitoring
5. **Budget:** Track operation times, alert if >target

**Performance Budget:**
```
Total overhead per generateCode call: <500ms
- Load memory: 50ms
- Build context: 150ms
- Track suggestion: 50ms
- Save: 100ms
- Background jobs: 0ms (async)
Total: 350ms ✅
```

---

### Risk 5: Storage Bloat

**Probability:** Medium
**Impact:** Low

**Scenario:** Memory storage grows unbounded over time

**Mitigation:**
1. **Auto-Pruning:** Keep max 100 summaries per project
2. **Size Limits:** 5MB per project in globalState
3. **Cleanup Tool:** UI button to "Clear Old Memories"
4. **Compression:** Compressed summaries much smaller
5. **File Backup:** Offload to files if globalState full

**Monitoring:**
```typescript
async function monitorStorageUsage() {
  const projects = await getAllProjectIds();

  for (const projectId of projects) {
    const size = await getStorageSize(projectId);

    if (size > 5_000_000) { // 5MB
      console.warn(`Project ${projectId} storage exceeds 5MB`);
      await pruneOldSummaries(projectId, 50); // Keep only 50 summaries
    }
  }
}

// Run every hour
setInterval(monitorStorageUsage, 3600000);
```

---

### Risk 6: Git Integration Fails

**Probability:** Medium
**Impact:** Low

**Scenario:** No Git repo, or Git operations fail

**Mitigation:**
1. **Graceful Degradation:** Git detection is optional enhancement
2. **Check Git Availability:** Test for .git folder before using
3. **Fallback:** Use file watcher and user actions only
4. **Error Handling:** Catch all Git errors, log and continue
5. **User Notification:** Inform if Git detection disabled

**Code:**
```typescript
class GitIntegration {
  private gitAvailable: boolean = false;

  async initialize() {
    try {
      const gitDir = path.join(workspace.rootPath, '.git');
      this.gitAvailable = await fs.pathExists(gitDir);

      if (!this.gitAvailable) {
        console.info('Git not available. Applied code detection will use file watching only.');
      }
    } catch (error) {
      console.error('Git initialization failed:', error);
      this.gitAvailable = false;
    }
  }

  async detectAppliedCode() {
    if (!this.gitAvailable) return; // Skip silently

    try {
      // ... Git operations
    } catch (error) {
      console.error('Git detection failed:', error);
      // Continue without Git detection
    }
  }
}
```

---

## Success Metrics

### Primary Metrics (MVP)

**1. Token Reduction**
```
Target: 40-60% reduction in average prompt tokens after turn 10

Measurement:
- Track tokens per turn (before/after memory layer)
- Compare 20-turn sessions: old vs. new
- Report average savings

Success: >40% reduction ✅
```

**2. Applied Code Detection Accuracy**
```
Target: 95%+ accuracy on user actions, 80%+ on Git detection

Measurement:
- True positives: Correctly marked as applied
- False positives: Incorrectly marked as applied
- False negatives: Applied but not detected
- Calculate precision & recall

Success: Precision >95%, Recall >90% ✅
```

**3. Duplicate Suggestion Prevention**
```
Target: Zero duplicate code suggestions

Measurement:
- Count suggestions per session
- Count duplicates (similarity >80%)
- Calculate duplicate rate

Success: <5% duplicate rate ✅
```

**4. Performance Overhead**
```
Target: <500ms total overhead per generateCode call

Measurement:
- Time all memory operations
- Compare generateCode latency: before/after
- Ensure no blocking operations

Success: Average overhead <500ms ✅
```

---

### Secondary Metrics (Nice to Have)

**5. Conversation Length**
```
Target: Support 30+ turn conversations without failure

Measurement:
- Track max turns before token overflow
- Compare: old (fails at ~15) vs. new (succeeds at 30+)

Success: Handle 50+ turns ✅
```

**6. User Satisfaction**
```
Target: 80%+ user satisfaction

Measurement:
- Survey internal users
- Questions:
  1. Does copilot remember context better?
  2. Are suggestions more relevant?
  3. Do you see duplicate code less often?
  4. Is performance acceptable?

Success: >4/5 average rating ✅
```

**7. Cost Savings**
```
Target: 30-40% reduction in API costs

Measurement:
- Track total tokens per session (input + output)
- Calculate cost: tokens × $0.003/1k
- Compare: before/after

Success: >30% cost reduction ✅
```

---

### Debug Metrics (Development)

**8. Compression Quality**
```
Measurement:
- Compression ratio per turn
- Information loss (manual evaluation)
- Token reduction

Goal: 80-90% compression, minimal information loss
```

**9. Storage Usage**
```
Measurement:
- Track storage size per project
- Monitor globalState usage
- Alert if approaching limits

Goal: <5MB per project, <50MB total
```

**10. Error Rate**
```
Measurement:
- Count memory-related errors
- Track: compression failures, detection failures, storage failures
- Monitor error logs

Goal: <1% error rate
```

---

## Appendix

### A. Configuration Options

**VS Code Settings (`settings.json`):**

```json
{
  "ballerina.copilot.memory": {
    // Enable/disable memory layer
    "enabled": true,

    // Working Memory (L1)
    "workingMemory": {
      "maxRecentMessages": 10,
      "tokenThreshold": 150000
    },

    // Compression
    "compression": {
      "enabled": true,
      "triggerEveryNTurns": 5,
      "useHaikuForSummaries": true,
      "compressionRatio": 0.9
    },

    // Applied Code Tracking (L3)
    "appliedCodeTracking": {
      "enabled": true,
      "trackUserActions": true,
      "trackGitCommits": true,
      "trackFileChanges": true,
      "gitDetectionInterval": 30000,
      "similarityThreshold": 0.8
    },

    // Session Memory (L2)
    "sessionMemory": {
      "enabled": true,
      "maxSummariesPerProject": 100,
      "backupToFile": false,
      "pruneOldSummaries": true
    },

    // Storage
    "storage": {
      "maxSizePerProject": 5242880,
      "useProjectFolder": false
    },

    // Debug
    "debug": {
      "showTokenUsage": true,
      "showCompressionStats": true,
      "logMemoryOperations": false
    }
  }
}
```

---

### B. API Reference

**Memory Manager:**

```typescript
interface MemoryManager {
  // Initialization
  initialize(context: ExtensionContext): Promise<void>;
  dispose(): void;

  // Working Memory (L1)
  getWorkingContext(): WorkingMemoryContext;
  addMessage(message: EnhancedChatMessage): void;

  // Session Memory (L2)
  getSessionSummaries(projectId: string): Promise<ConversationSummary[]>;
  shouldCompress(): boolean;
  compressOldMessages(): Promise<void>;

  // Applied Code (L3)
  trackCodeSuggestion(code: GeneratedCode): string;
  markCodeApplied(suggestionId: string, method: DetectionMethod): Promise<void>;
  isCodeAlreadyApplied(code: string): boolean;

  // Context Building
  buildContextForPrompt(userQuery: string): Promise<MemoryContext>;

  // Statistics
  getMemoryStats(projectId: string): MemoryStatistics;
}
```

**Applied Code Tracker:**

```typescript
interface AppliedCodeTracker {
  // Registration
  registerSuggestion(code: GeneratedCode): SuggestionId;

  // Status Management
  markApplied(suggestionId: string, info: ApplicationInfo): Promise<void>;
  markIgnored(suggestionId: string): Promise<void>;
  getStatus(suggestionId: string): SuggestionStatus;

  // Querying
  getPendingSuggestions(): AppliedCodeEntry[];
  getAppliedSuggestions(): AppliedCodeEntry[];
  findSimilarCode(code: string, threshold: number): AppliedCodeEntry[];

  // Persistence
  persistToFile(projectId: string): Promise<void>;
  loadFromFile(projectId: string): Promise<AppliedCodeIndex>;
}
```

---

### C. Testing Strategy

**Unit Tests:**
- CompressionService: message grouping, summarization
- AppliedCodeTracker: similarity calculation, detection
- TokenBudgetManager: budget enforcement, optimization
- SessionMemoryStore: CRUD operations

**Integration Tests:**
- Full flow: message → compression → storage → retrieval
- Applied code detection: user action → Git commit → file watch
- Prompt building: memory context → optimized messages
- Multi-turn conversations: 30+ turns without overflow

**Performance Tests:**
- Benchmark all operations against targets
- Load testing: 100 projects, 1000 messages each
- Memory leak detection: run for 24 hours
- Concurrent operations: multiple projects

**User Acceptance Tests:**
- Internal dogfooding: use for 2 weeks
- Beta program: 10 external users
- Feedback collection: surveys + interviews
- Bug bounty: encourage edge case discovery

---

### D. Migration Plan

**Existing Projects:**

1. **Automatic Detection:** On extension start, detect old chat state
2. **Backward Compatible:** Old format still works
3. **Lazy Migration:** Convert to new format on first use
4. **Preserve History:** All old messages kept
5. **Gradual Enhancement:** Memory features enabled incrementally

**Migration Script:**

```typescript
async function migrateProject(projectId: string) {
  const oldKey = `ballerina.ai.chat.state.${projectId}`;
  const oldData = await globalState.get(oldKey);

  if (!oldData || oldData.migrated) return;

  console.log(`Migrating project ${projectId}...`);

  // 1. Keep old data as-is
  const recentMessages = oldData.chatHistory.slice(-10);
  const oldMessages = oldData.chatHistory.slice(0, -10);

  // 2. Compress old messages
  let compressed: CompressedTurn[] = [];
  if (oldMessages.length > 0) {
    compressed = await compressionService.compressMessages(oldMessages);
  }

  // 3. Save to new format
  await sessionMemoryStore.saveSummary(projectId, {
    compressedTurns: compressed,
    allDecisions: extractDecisions(oldData.chatHistory),
    filesCreated: [],
    filesModified: [],
    librariesUsed: []
  });

  // 4. Mark as migrated
  await globalState.update(oldKey, {
    ...oldData,
    migrated: true,
    migratedAt: Date.now()
  });

  console.log(`✅ Migration complete for ${projectId}`);
}
```

---

### E. Rollout Plan

**Phase 1: Internal Alpha (Week 1-2)**
- Deploy to development team only
- Gather feedback, fix critical bugs
- Monitor performance and costs

**Phase 2: Internal Beta (Week 3-4)**
- Deploy to all WSO2 engineers using Ballerina
- Optional opt-in feature flag
- Collect metrics and feedback

**Phase 3: Limited Public Beta (Week 5-8)**
- Deploy to 10% of public users (random selection)
- Feature flag: `ballerina.copilot.memory.beta: true`
- Monitor error rates, performance

**Phase 4: General Availability (Week 9+)**
- Deploy to all users
- Feature enabled by default
- Documentation and announcement

**Rollback Plan:**
- Keep old code path intact
- Feature flag to disable memory layer
- Can roll back in <1 hour if critical issues

---

### F. Open Questions for Review

1. **Compression Trigger:** Every 5 turns or token threshold? Both?
2. **Applied Code Storage:** Commit to Git or keep in .ballerina/? (Recommendation: .ballerina/)
3. **Session Memory Size Limit:** 5MB or 10MB per project? (Recommendation: 5MB)
4. **Git Detection Interval:** 30 seconds or 60 seconds? (Recommendation: 30s)
5. **Semantic Search:** Include in MVP or Phase 2? (Recommendation: Phase 2)
6. **User-Facing Memory UI:** Essential or nice-to-have? (Recommendation: Phase 5)
7. **Memory Sharing:** Support team sharing across machines? (Recommendation: Future)
8. **Claude Memory Tool:** Integrate as optional backend? (Recommendation: No, use local-first)

---

## Conclusion

This design provides a comprehensive, implementable memory layer for Ballerina Copilot that addresses all four key requirements:

1. ✅ **Context & Workspace Tracking** - Captured in WorkingMemoryContext with file watching
2. ✅ **Applied-Code Detection & Pruning** - Three detection methods with 95%+ accuracy
3. ✅ **Conversation Summarization** - Compression service with 80-90% token reduction
4. ✅ **Memory Retrieval & Prompt Integration** - Unified context building with optimization

**Expected Benefits:**
- 40-60% token cost savings
- Zero duplicate suggestions
- Support for 30+ turn conversations
- Cross-session knowledge retention
- <500ms performance overhead

**Implementation Timeline:** 12 weeks (3 months)

**Risk Level:** Low (backward compatible, incremental rollout, fallback options)

---

**Next Steps:**
1. Review this design with stakeholders
2. Get approval on open questions (Appendix F)
3. Create detailed task breakdown (GitHub issues)
4. Begin Phase 1 implementation
5. Schedule weekly sync meetings to track progress

---

**Document Metadata:**
- Version: 2.0
- Last Updated: December 17, 2025
- Authors: Development Team
- Status: Ready for Review
- Next Review: After Phase 1 completion
