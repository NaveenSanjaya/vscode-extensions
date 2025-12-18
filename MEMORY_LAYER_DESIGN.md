## Proposed Memory Layer — Narrative Design

### Objectives
Our goal is to make Ballerina Copilot feel continuously informed, responsive, and efficient without overwhelming the LLM context window. We will:
- Strengthen short‑term memory so multi‑turn work stays coherent and within token limits.
- Offer an optional, pluggable long‑term memory that persists knowledge across sessions.
- Provide a clean integration path for Claude’s Memory Tool while keeping a local, vendor‑agnostic alternative.

### Tier 1: Short‑Term Memory (Primary Focus)
Short‑term memory is the assistant’s working memory during an active session. Today, it is a raw chat buffer plus ad‑hoc context (selected code, workspace state). We will formalize and optimize this layer:
- Conversation condensation: After every few turns, the assistant will summarize prior exchanges into compact “session notes” that capture intent, decisions, constraints, and next actions. These notes replace long transcripts, cutting tokens while preserving meaning.
- Decision tracking: Key choices (ports, libraries, patterns) are extracted into a structured “session decisions” map so the assistant can consistently reference them without re‑parsing full history.
- Code‑aware context: Selected code is normalized (only the relevant function, signature, and comments) and indexed as “active focus,” reducing accidental context bloat.
- Token budgeting: The prompt builder enforces a soft budget—prioritizing session notes, active focus, and immediate inputs; less relevant turns are collapsed or elided dynamically when nearing limits.
- Lightweight checkpoints: File diffs produced within the session are captured as reversible patches so the assistant can refer to “what changed” and quickly roll back if needed. These are in‑memory by default, with an option to serialize temporarily.

Outcome: Multi‑turn conversations remain coherent for typical development tasks (10–20 turns) without crossing token limits. The assistant remembers what matters, forgets what doesn’t, and keeps code edits aligned with decisions.

### Tier 2: Long‑Term Memory (Optional, Pluggable)
Long‑term memory persists knowledge across sessions. It is opt‑in and pluggable:
- Memory model: Each memory entry records type (episodic/semantic/procedural), source messages, compact content, optional embedding, tags, and timestamps. This mirrors the research report and keeps retrieval flexible.
- Backends: Start with two providers—Local JSON/SQLite for private and offline use, and an adapter for Claude’s Memory Tool when teams prefer hosted agent memory. The adapter boundary lets us swap providers without changing the rest of the system.
- Retrieval: When a new session begins, the assistant pulls a small, ranked set of memories (by recency, tag match, semantic similarity) and integrates them into the first prompt as “project backdrop.” Subsequent prompts fetch additional memories only when relevant to the current intent.
- Hygiene: Memories can be pinned, edited, or deleted via a simple UI. System summaries are human‑readable, and nothing is stored without user consent.

Outcome: Important project facts and workflows survive beyond a single session, improving continuity while remaining under user control.

### Claude Memory Tool — Integration Option
Claude’s Memory Tool can serve as the long‑term memory provider for teams using Anthropic’s agent stack:
- Use cases: Persisting chat‑derived facts, decisions, and summaries with semantic retrieval out‑of‑the‑box.
- Boundaries: It does not track applied code or workspace diffs; those remain in our short‑term/extension scope.
- Configuration: A provider flag enables Claude memory; if disabled, we use local storage. Switching is non‑disruptive to the rest of the architecture.
- Privacy: Users can keep data local or opt in to hosted memory. We document data flow and make consent explicit.

### Prompt Assembly — Source of Truth
All prompts are assembled from explicit sources so behavior is predictable and auditable:
- Immediate input: The current user message and any selected code.
- Session notes: Compact summaries updated every 3–5 turns.
- Session decisions: Structured map of key choices (e.g., “DB=PostgreSQL, Auth=JWT”).
- Applied edits: Short list of file patches produced this session.
- Project backdrop (optional): Long‑term memories relevant to the current intent.
The builder orders and truncates these components to fit the token budget, preferring decisions and active focus over raw transcript.

### Risks and Guardrails
- Token overflow: Mitigated by tiered condensation, strict budgets, and dynamic elision.
- Drift/misremembering: Summaries include citations to original turns; users can expand details on demand.
- Privacy: Long‑term memory is opt‑in; providers and data paths are transparent. Sensitive content can be excluded via tags.
- Vendor lock‑in: The provider interface prevents coupling; Claude is optional.

### Rollout Plan
1. Implement session notes, decision tracking, and token budgeting in the short‑term layer. Measure token savings and response coherence.
2. Add lightweight checkpoints for applied edits and reversible patches.
3. Introduce the pluggable long‑term memory interface with Local JSON/SQLite first; then add Claude adapter.
4. Ship a minimal Memory UI to browse, pin, and delete entries. Keep it simple and privacy‑first.
5. Document behavior, surface settings (enable/disable providers), and collect feedback.

### Success Metrics
- 30–40% prompt token reduction on multi‑turn sessions with equal or better response quality.
- Fewer repeated suggestions after applied edits (measured by duplicate recommendation rate).
- Faster ramp‑up in new sessions when long‑term memory is enabled (fewer clarifying turns needed).
- Positive user feedback on control and transparency of memory.

### Approval Questions
- Do we prioritize Local JSON/SQLite first, then Claude adapter, or ship both together?
- What default privacy posture should we enforce (opt‑in only, with explicit prompts)?
- Which tags/categories should be first‑class (e.g., auth, db, logging) to aid retrieval?
- What token budget targets are acceptable for common flows (e.g., 12k, 32k, 100k contexts)?

This design strengthens short‑term memory immediately and makes long‑term memory a clean, optional upgrade. It’s pragmatic, privacy‑aware, and minimizes vendor coupling while enabling Claude for teams who want it.
# Ballerina Copilot Memory Layer - Design Document

**Version**: 1.0  
**Date**: December 16, 2025  
**Status**: DESIGN REVIEW  
**Author**: Development Team  

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [Design Principles](#design-principles)
4. [Architecture Overview](#architecture-overview)
5. [Short-Term Memory Enhancement](#short-term-memory-enhancement)
6. [Optional Long-Term Memory (Pluggable)](#optional-long-term-memory-pluggable)
7. [Claude Memory Tool Integration](#claude-memory-tool-integration)
8. [Data Models](#data-models)
9. [Storage Strategy](#storage-strategy)
10. [API Design](#api-design)
11. [Implementation Phases](#implementation-phases)
12. [Considerations & Risks](#considerations--risks)
13. [Open Questions](#open-questions)

---

## Executive Summary

This document proposes a **two-tier memory architecture** for Ballerina Copilot:

### Tier 1: Short-Term Memory (Primary Focus)
Enhance the current in-memory chat history system to:
- Prevent token overflow by implementing intelligent context compression
- Track applied code suggestions via Git integration
- Detect and avoid repeating suggestions
- Optimize conversation history for LLM consumption
- Provide better context awareness within a session

**Implementation Scope**: Improve existing `chatHistory` and checkpoint system  
**Timeline**: 2-3 weeks  
**Impact**: 40-60% token reduction, better coherence, de-duplication

### Tier 2: Long-Term Memory (Optional, Pluggable)
Add extensible memory persistence layer:
- Save conversation summaries, design decisions, code patterns
- Semantic search across past projects
- Optional Claude Memory Tool integration as one backend option
- Allow swapping memory backends (Claude Memory, local DB, cloud storage)
- Enable "memory export" for knowledge reuse across projects

**Implementation Scope**: New optional module, configurable via settings  
**Timeline**: 4-6 weeks (after Tier 1)  
**Impact**: Cross-session learning, searchable knowledge base, reduced context loss

### Why This Approach?

1. **Immediate Value**: Tier 1 fixes current token overflow and coherence issues NOW
2. **Flexibility**: Tier 2 allows teams to adopt long-term memory at their pace
3. **Provider Agnostic**: Pluggable architecture means Claude Memory Tool is ONE option, not a requirement
4. **Backward Compatible**: Existing projects work without changes; opt-in for Tier 2

---

## Current State Analysis

### Test Results Summary

From [MEMORY_TESTING_GUIDE.md](MEMORY_TESTING_GUIDE.md):

| Feature | Status | Issue |
|---------|--------|-------|
| Chat history (same session) | ✅ | Works, but grows unbounded |
| Code context awareness | ✅ | Works well |
| Multi-turn conversation | ✅ | Works for ~4-5 turns before quality degrades |
| Cross-session memory | ✅ | Partially works (sessionStorage exists but limited) |
| Semantic search | ❌ | No semantic similarity detection |
| Applied code tracking | ❌ | Can't distinguish applied vs. ignored suggestions |
| Long conversation handling | ⚠️ | Token overflow at ~15 messages with full code context |

### Key Problems

**Problem 1: Token Overflow**
```
Current approach: Send FULL chat history to LLM every turn
Turn 5:  ~50k tokens (history + context + prompt)
Turn 10: ~100k tokens (2x history + context + prompt)
Turn 15: ~207k tokens (EXCEEDS LIMIT) ❌
```

**Problem 2: Context Compression**
- No distinction between important vs. noise
- Early decisions buried in raw messages
- LLM spends tokens reviewing repetitive context

**Problem 3: Code Suggestion De-duplication**
- No tracking of which suggestions were applied
- LLM re-suggests same code patterns
- User confusion: "Didn't I already apply this?"

**Problem 4: Context Loss on Reload**
- sessionStorage cleared on window reload
- User loses conversation context mid-task
- Only globalState persists (but not queryable)

**Problem 5: No Cross-Project Knowledge**
- Each project is isolated silo
- Can't learn patterns from past projects
- Repeated explanation of same concepts

---

## Design Principles

### 1. **Progressive Enhancement**
- Tier 1 improves existing system without breaking changes
- Tier 2 adds capabilities without impacting Tier 1
- Users can use just Tier 1 or both tiers

### 2. **Token Efficiency**
- Every design decision considers token impact
- Compression before transmission, not after
- Streaming + caching to reduce redundant computation

### 3. **Provider Flexibility**
- Claude Memory Tool is ONE backend option, not a requirement
- Architecture allows swapping backends
- Local-first option available (no external dependencies)

### 4. **User Control**
- Memory settings are configurable
- Users can enable/disable Tier 2
- Explicit control over what gets stored long-term

### 5. **Performance First**
- No noticeable latency increase
- Compression happens asynchronously
- Async storage writes don't block user interaction

---

## Architecture Overview

### High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    User Interaction Layer                        │
│  (Chat Input → Send → Receive Response → Apply Code)           │
└──────────────────────┬──────────────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        │                             │
┌───────▼────────────────┐   ┌───────▼────────────────┐
│  TIER 1: Short-Term    │   │  TIER 2: Long-Term     │
│  Memory (Always On)    │   │  Memory (Optional)     │
│                        │   │                        │
│ ┌──────────────────┐   │   │ ┌──────────────────┐   │
│ │ Context Manager  │   │   │ │ Memory Manager   │   │
│ │ - Compression    │   │   │ │ - Summarization  │   │
│ │ - De-duplication │   │   │ │ - Semantic Index │   │
│ │ - Token tracking │   │   │ │ - Cross-project  │   │
│ └──────────────────┘   │   │ └──────────────────┘   │
│           │            │   │           │            │
│ ┌─────────▼──────────┐ │   │ ┌─────────▼────────┐  │
│ │ Chat History       │ │   │ │ Memory Store     │  │
│ │ (Enhanced)         │ │   │ │ (Backend plugin) │  │
│ │                    │ │   │ │                  │  │
│ │ - Raw messages     │ │   │ │ ┌──────────────┐ │  │
│ │ - Compressed form  │ │   │ │ │Claude Memory │ │  │
│ │ - Applied tracking │ │   │ │ │Tool (native) │ │  │
│ │ - Checkpoints      │ │   │ │ └──────────────┘ │  │
│ └────────────────────┘ │   │ │                  │  │
│                        │   │ │ ┌──────────────┐ │  │
└────────┬───────────────┘   │ │ │Local JSON DB │ │  │
         │                   │ │ └──────────────┘ │  │
         │                   │ │                  │  │
         │                   │ │ ┌──────────────┐ │  │
         │                   │ │ │Cloud Storage │ │  │
         │                   │ │ └──────────────┘ │  │
         │                   │ └──────────────────┘  │
         │                   └──────────────────────┘
         │
    ┌────▼────────────────────────────────────────┐
    │  Storage Layer                              │
    │  - VS Code globalState (existing)           │
    │  - VS Code localStorage (visualizer)        │
    │  - Optional: Project .ballerina/ folder     │
    │  - Optional: Cloud backend                  │
    └─────────────────────────────────────────────┘
```

---

## Short-Term Memory Enhancement

### Current Implementation (Simplified)

```typescript
// Current: Raw history stored as-is
globalState.set('ballerina-ai-chat-${projectId}', {
  messages: [
    { role: 'user', content: 'Create REST API' },
    { role: 'assistant', content: '...long response...' },
    { role: 'user', content: 'Add authentication' },
    { role: 'assistant', content: '...very long response...' },
    // ... continues
  ]
});

// When generating next response:
const allMessages = loadChatHistory(); // Load ALL messages
const llmRequest = {
  system: systemPrompt,
  messages: allMessages  // ALL history sent to LLM
};
await claude.message(llmRequest);  // Token cost = O(n) where n = number of turns
```

### Proposed Enhancement

#### 1. **Intelligent Context Window Management**

```typescript
interface OptimizedChatHistory {
  // Raw messages (for UI display)
  messages: ChatMessage[];
  
  // Optimized for LLM (compressed)
  optimizedContext: {
    systemSummary?: string;        // Project + goals summary
    keyDecisions: string[];         // Important decisions made
    recentMessages: ChatMessage[];  // Last N turns (full)
    oldMessages: CompressedTurn[];  // Earlier turns (summarized)
  };
  
  // Applied code tracking
  appliedCodeIndex: {
    [suggestionId: string]: {
      status: 'applied' | 'ignored' | 'pending';
      gitCommitHash?: string;
      appliedAt?: timestamp;
    }
  };
  
  // Token accounting
  tokenMetadata: {
    lastLLMRequest: {
      inputTokens: number;
      outputTokens: number;
      timestamp: timestamp;
    };
    estimatedTotalTokens: number;
    compressionRatio: number;  // Before/after
  };
}

interface CompressedTurn {
  summary: string;          // 1-2 line summary of what was discussed
  keyCode?: string;         // Important code snippet (if any)
  decisions?: string[];     // Decisions made in this turn
  timestamp: timestamp;
  turnIndex: number;        // Original turn number for reference
}
```

#### 2. **Compression Strategy**

**When to Compress?**
```typescript
// After every N turns (e.g., 5) OR when token usage exceeds threshold
if (chatHistory.messages.length % 5 === 0 || estimatedTokens > 150000) {
  await compressOldTurns();
}
```

**Compression Process** (Async, non-blocking):
```typescript
async function compressOldTurns() {
  // Keep last 5 turns uncompressed (full detail)
  const recentTurns = chatHistory.messages.slice(-10);
  const oldTurns = chatHistory.messages.slice(0, -10);
  
  if (oldTurns.length === 0) return;
  
  // Batch old turns into groups
  const groups = chunkArray(oldTurns, 4);  // Group 4 turns together
  
  // Use Haiku (fast, cheap) to summarize each group
  for (const group of groups) {
    const summary = await summarizeWithHaiku({
      prompt: `Summarize this conversation segment in 1-2 sentences, focusing on:
        - What the user asked
        - What code was generated
        - Any key decisions made
        
        Messages: ${JSON.stringify(group)}`
    });
    
    // Store compressed version
    chatHistory.optimizedContext.oldMessages.push({
      summary,
      keyCode: extractImportantCode(group),
      decisions: extractDecisions(group),
      timestamp: group[0].timestamp,
      turnIndex: group[0].index
    });
  }
  
  // Mark original messages as compressed (keep for audit trail)
  oldTurns.forEach(m => m.isCompressed = true);
  
  // Update token estimate
  chatHistory.tokenMetadata.compressionRatio = 
    calculateCompressionRatio(oldTurns, chatHistory.optimizedContext.oldMessages);
}
```

#### 3. **LLM Prompt Injection**

When building next request to LLM:

```typescript
function buildOptimizedPrompt(chatHistory: OptimizedChatHistory) {
  const messages = [];
  
  // 1. System prompt (cached with Anthropic's prompt caching)
  messages.push({
    role: 'system',
    content: systemPrompt,
    providerOptions: {
      cache_control: { type: 'ephemeral' }
    }
  });
  
  // 2. Inject project summary (optional, if exists)
  if (chatHistory.optimizedContext.systemSummary) {
    messages.push({
      role: 'system',
      content: `Project Context:\n${chatHistory.optimizedContext.systemSummary}`
    });
  }
  
  // 3. Inject key decisions (compressed context)
  if (chatHistory.optimizedContext.keyDecisions.length > 0) {
    messages.push({
      role: 'assistant',
      content: `Key decisions we made so far:\n${chatHistory.optimizedContext.keyDecisions.join('\n')}`
    });
  }
  
  // 4. Inject old turns (summarized)
  for (const compressed of chatHistory.optimizedContext.oldMessages) {
    messages.push({
      role: 'user',
      content: compressed.summary
    });
    messages.push({
      role: 'assistant',
      content: compressed.keyCode ? 
        `Generated code:\n${compressed.keyCode}` : 
        'Code generation step'
    });
  }
  
  // 5. Include recent full turns (last N)
  for (const msg of chatHistory.optimizedContext.recentMessages) {
    messages.push({
      role: msg.role,
      content: msg.content
    });
  }
  
  // 6. Current user message
  messages.push({
    role: 'user',
    content: currentUserPrompt
  });
  
  return messages;
}
```

**Token Savings Example**:
```
Before compression:
- Turn 1-5 (old): 15k tokens
- Turn 6-10 (recent): 25k tokens
- Total: 40k tokens per request

After compression:
- Turn 1-5 (compressed): 2k tokens (87% reduction!)
- Turn 6-10 (recent): 25k tokens (kept full)
- Total: 27k tokens per request
- Savings: 13k tokens (32% overall) ✅
```

#### 4. **Applied Code Tracking**

Track which suggestions were actually used:

```typescript
interface AppliedCodeEntry {
  suggestionId: string;
  generatedCode: string;
  filesPaths: string[];
  status: 'applied' | 'ignored' | 'pending';
  
  // Git integration
  gitCommitHash?: string;
  appliedAt?: timestamp;
  
  // De-duplication
  codeHash: string;          // SHA256 of code
  semanticSimilarity?: {
    [otherId: string]: number;  // 0-1 score to similar suggestions
  };
}

// When code is generated:
async function trackSuggestion(suggestion: GeneratedCode) {
  const entry: AppliedCodeEntry = {
    suggestionId: generateId(),
    generatedCode: suggestion.code,
    filesPaths: suggestion.files,
    status: 'pending',
    codeHash: hashCode(suggestion.code),
    gitCommitHash: undefined
  };
  
  chatHistory.appliedCodeIndex[entry.suggestionId] = entry;
  notifyCodeTracking(entry);
}

// After files are applied to workspace:
async function markCodeApplied(suggestionId: string, commitHash: string) {
  const entry = chatHistory.appliedCodeIndex[suggestionId];
  if (entry) {
    entry.status = 'applied';
    entry.gitCommitHash = commitHash;
    entry.appliedAt = Date.now();
  }
}

// When LLM suggests similar code again (de-duplication):
async function detectAndWarnDuplicate(newSuggestion: GeneratedCode) {
  const newHash = hashCode(newSuggestion.code);
  
  // Check for similar code already suggested
  for (const [id, entry] of Object.entries(chatHistory.appliedCodeIndex)) {
    if (entry.status === 'applied') {
      const similarity = calculateSimilarity(newHash, entry.codeHash);
      if (similarity > 0.8) {
        // Warn user: "This is similar to suggestion ${id} which was already applied"
        notifyDuplicateSuggestion(id, similarity);
        return true;
      }
    }
  }
  return false;
}
```

---

## Optional Long-Term Memory (Pluggable)

### Overview

Long-term memory persists across sessions and projects, enabling:
- "What patterns have we used for authentication?"
- "What libraries work well for data mapping?"
- "How did we handle error scenarios last time?"

### Architecture: Pluggable Backend

```typescript
interface MemoryBackend {
  // CRUD operations
  save(memory: MemoryEntry): Promise<string>;     // Returns ID
  load(id: string): Promise<MemoryEntry>;
  delete(id: string): Promise<void>;
  
  // Search operations
  searchByText(query: string, limit: number): Promise<MemoryEntry[]>;
  searchBySemantic(embedding: number[], limit: number): Promise<MemoryEntry[]>;
  searchByTag(tags: string[], limit: number): Promise<MemoryEntry[]>;
  
  // Batch operations
  saveMany(memories: MemoryEntry[]): Promise<string[]>;
  deleteMany(ids: string[]): Promise<void>;
  
  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

// Memory managers for each backend
type MemoryBackendType = 'claude-native' | 'local-json' | 'cloud-postgres';

function createMemoryBackend(type: MemoryBackendType): MemoryBackend {
  switch (type) {
    case 'claude-native':
      return new ClaudeMemoryBackend(claudeClient);
    case 'local-json':
      return new LocalJsonBackend(workspaceFolder);
    case 'cloud-postgres':
      return new CloudPostgresBackend(dbConfig);
    default:
      throw new Error(`Unknown backend: ${type}`);
  }
}
```

### Memory Entry Structure

```typescript
interface MemoryEntry {
  // Identifiers
  id: string;
  projectId: string;
  
  // Classification
  type: 'episodic' | 'semantic' | 'procedural' | 'design-decision';
  
  // Content
  title: string;           // Human-readable title
  content: string;         // Full text
  
  // Vector representation
  embedding?: number[];    // For semantic search (1024 dims typical)
  
  // Metadata
  sourceType: 'conversation' | 'code-analysis' | 'user-annotation';
  sourceMessages?: string[];  // IDs of messages that generated this
  createdAt: timestamp;
  lastAccessed: timestamp;
  
  // Categorization
  tags: string[];          // e.g., ['authentication', 'oauth2', 'security']
  relatedMemories?: string[];  // IDs of related memory entries
  
  // Relevance
  accessCount: number;     // How many times retrieved
  relevanceScore?: number; // Updated by LLM feedback
  
  // Optional: Applied code tracking
  codeContext?: {
    language: string;
    snippet: string;
    filesPaths?: string[];
  };
}
```

### Claude Memory Tool Backend Implementation

```typescript
class ClaudeMemoryBackend implements MemoryBackend {
  private client: Anthropic;
  
  constructor(client: Anthropic) {
    this.client = client;
  }
  
  async save(memory: MemoryEntry): Promise<string> {
    // Claude Memory Tool: Agent saves memory using built-in tool
    const result = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      tools: [{
        type: 'memory',
        name: 'save_memory',
        description: 'Save important information to memory'
      }],
      messages: [{
        role: 'user',
        content: `Save this to memory:\n\n${memory.content}\n\nMetadata: tags=[${memory.tags.join(', ')}]`
      }]
    });
    
    // Claude returns memory ID
    // In production, would parse response for ID
    return memory.id;
  }
  
  async searchBySemantic(embedding: number[], limit: number): Promise<MemoryEntry[]> {
    // Claude Memory Tool: Query with semantic search
    const result = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      tools: [{
        type: 'memory',
        name: 'search_memory',
        description: 'Search memory for relevant information'
      }],
      messages: [{
        role: 'user',
        content: 'Find memories related to authentication patterns'
      }]
    });
    
    // Parse Claude's response with memory search results
    return this.parseSearchResults(result);
  }
  
  // ... other methods
}
```

### Local JSON Backend Implementation

```typescript
class LocalJsonBackend implements MemoryBackend {
  private memoryFile: string;
  private memories: Map<string, MemoryEntry>;
  
  constructor(workspaceFolder: string) {
    this.memoryFile = path.join(workspaceFolder, '.ballerina', 'memory.json');
    this.memories = new Map();
  }
  
  async initialize() {
    // Load existing memories from file
    if (fs.existsSync(this.memoryFile)) {
      const data = fs.readFileSync(this.memoryFile, 'utf-8');
      const entries = JSON.parse(data) as MemoryEntry[];
      entries.forEach(e => this.memories.set(e.id, e));
    }
  }
  
  async save(memory: MemoryEntry): Promise<string> {
    memory.id ||= generateId();
    this.memories.set(memory.id, memory);
    await this.persist();
    return memory.id;
  }
  
  async searchBySemantic(embedding: number[], limit: number): Promise<MemoryEntry[]> {
    // Use simple cosine similarity (no external deps)
    const entries = Array.from(this.memories.values());
    const scored = entries
      .map(e => ({
        entry: e,
        score: e.embedding ? cosineSimilarity(embedding, e.embedding) : 0
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return scored.map(s => s.entry);
  }
  
  private async persist() {
    const data = Array.from(this.memories.values());
    fs.writeFileSync(this.memoryFile, JSON.stringify(data, null, 2));
  }
  
  // ... other methods
}
```

### Memory Manager (Orchestrator)

```typescript
class MemoryManager {
  private backend: MemoryBackend;
  private embeddingService: EmbeddingService;  // Generates embeddings
  
  constructor(backend: MemoryBackend) {
    this.backend = backend;
    this.embeddingService = new EmbeddingService();  // Uses Anthropic API
  }
  
  /**
   * Save a conversation turn as a memory entry
   */
  async captureFromConversation(
    projectId: string,
    turn: ChatTurn,
    metadata: { topic?: string; decisions?: string[] }
  ): Promise<void> {
    // Summarize the turn
    const summary = await summarizeWithHaiku(turn);
    
    // Extract tags
    const tags = extractTags(turn, metadata);
    
    // Generate embedding for semantic search
    const embedding = await this.embeddingService.embed(summary);
    
    const memory: MemoryEntry = {
      id: generateId(),
      projectId,
      type: 'episodic',
      title: metadata.topic || 'Conversation turn',
      content: summary,
      embedding,
      sourceType: 'conversation',
      sourceMessages: [turn.id],
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      tags,
      accessCount: 0
    };
    
    await this.backend.save(memory);
  }
  
  /**
   * Retrieve relevant memories for current conversation
   */
  async retrieveRelevant(
    projectId: string,
    query: string,
    limit: number = 5
  ): Promise<MemoryEntry[]> {
    // 1. Generate embedding for query
    const queryEmbedding = await this.embeddingService.embed(query);
    
    // 2. Search by semantic similarity
    const semanticResults = await this.backend.searchBySemantic(queryEmbedding, limit);
    
    // 3. Filter by projectId
    const filtered = semanticResults.filter(m => m.projectId === projectId);
    
    // 4. Update access metadata
    for (const memory of filtered) {
      memory.lastAccessed = Date.now();
      memory.accessCount++;
      await this.backend.save(memory);
    }
    
    return filtered;
  }
  
  /**
   * Inject retrieved memories into LLM prompt
   */
  buildMemoryInjectionPrompt(memories: MemoryEntry[]): string {
    if (memories.length === 0) return '';
    
    const sections = memories.map(m => 
      `### ${m.title}\n${m.content}\n(Tags: ${m.tags.join(', ')})`
    ).join('\n\n');
    
    return `## Relevant Context from Memory\n\n${sections}`;
  }
}
```

### When to Create Long-Term Memories

```typescript
// Option 1: Auto-capture important conversations
async function maybeCaptureTurnAsMemory(turn: ChatTurn) {
  // Heuristics to decide if this is "important"
  const isImportant = 
    turn.type === 'code_generation' &&
    turn.complexity > 0.7 &&  // Complex code generated
    turn.feedback === 'user_applied';  // User actually applied it
  
  if (isImportant) {
    await memoryManager.captureFromConversation(projectId, turn, {
      topic: extractTopic(turn),
      decisions: extractDecisions(turn)
    });
  }
}

// Option 2: User explicitly marks memory
function createMemoryFromSelection(selectedText: string) {
  const memory: MemoryEntry = {
    type: 'user-annotation',
    content: selectedText,
    // ... other fields
  };
  memoryManager.save(memory);
}

// Option 3: Periodic automatic capture (e.g., end of session)
async function captureSessionSummary(session: ConversationSession) {
  const summary = await summarizeSession(session);
  
  const memory: MemoryEntry = {
    type: 'semantic',
    title: `Session: ${session.goal}`,
    content: summary,
    // ...
  };
  
  await memoryManager.save(memory);
}
```

---

## Claude Memory Tool Integration

### Decision: Optional Backend, Not Required

**Recommendation**: Use Claude Memory Tool as **ONE OPTIONAL BACKEND** for long-term memory, not as the sole implementation.

### Why?

**Pros of Claude Memory Tool**:
- ✅ Built-in to Claude API (native support)
- ✅ Automatic memory management (no schema to define)
- ✅ Semantic search included
- ✅ Zero infrastructure needed
- ✅ Pay-per-token (aligned with existing costs)

**Cons of Claude Memory Tool**:
- ❌ Vendor lock-in (only works with Claude)
- ❌ Less control over storage format
- ❌ Unclear persistence guarantees (depends on Anthropic backend)
- ❌ Rate limits on memory operations
- ❌ No cross-model compatibility (if team wants to try GPT-4, etc.)
- ❌ Overkill for simple projects (adds latency/cost)

### Integration Points

If Claude Memory Tool is enabled:

```typescript
// User enables in settings:
{
  "ballerina.memory.tier2Enabled": true,
  "ballerina.memory.backend": "claude-native",
  "ballerina.memory.autoCapture": true
}

// Claude Memory Tool is used for:
// 1. Storing episodic memories (conversation summaries)
// 2. Semantic search over past memories
// 3. Generating memory-augmented prompts

// Short-term memory (Tier 1) is ALWAYS local to avoid costs/latency
// Long-term memory (Tier 2) is optional via chosen backend
```

### Alternative Backends

Teams can choose:

| Backend | Pros | Cons | Best For |
|---------|------|------|----------|
| **Claude Memory Tool** | Native, auto-managed | Vendor lock-in | Teams deeply invested in Claude |
| **Local JSON** | Simple, no deps, free | Not searchable, no sync | Single-user local dev |
| **PostgreSQL** | Scalable, queryable, standards | Requires setup | Teams, enterprise |
| **Pinecone/Weaviate** | Vector DB, mature | Monthly cost | Projects needing fast semantic search |

---

## Data Models

### Chat Message (Enhanced)

```typescript
interface ChatMessage {
  // Identifiers
  id: string;
  conversationId: string;
  
  // Content
  role: 'user' | 'assistant';
  content: string;
  
  // Metadata
  timestamp: number;
  tokenCount?: number;  // For accounting
  
  // Compression state
  isCompressed?: boolean;
  compressedSummary?: string;
  
  // Code tracking
  appliedCodeSuggestions?: {
    suggestionId: string;
    status: 'pending' | 'applied' | 'ignored';
  }[];
  
  // Memory linkage
  linkedMemories?: string[];  // IDs of long-term memories related to this message
}
```

### Conversation State (Enhanced)

```typescript
interface ConversationState {
  // Session info
  id: string;
  projectId: string;
  createdAt: number;
  lastModified: number;
  
  // Messages
  messages: ChatMessage[];
  
  // Optimization
  optimization: {
    compressionEnabled: boolean;
    lastCompressionAt?: number;
    compressionRatio: number;  // 0-1
    estimatedTokens: number;
  };
  
  // Code tracking
  appliedCode: {
    [suggestionId: string]: {
      status: 'applied' | 'ignored' | 'pending';
      appliedAt?: number;
      gitCommitHash?: string;
    }
  };
  
  // Long-term memory linkage
  relatedMemories?: string[];  // IDs from long-term store
  
  // Metadata
  goalSummary?: string;  // What user is trying to accomplish
  decisions: string[];   // Key decisions made in this session
}
```

---

## Storage Strategy

### Tier 1 Storage (Always Local)

```typescript
// VS Code globalState
// Key: `ballerina-ai-chat-${projectHash}`
// Scope: Per workspace/project
// Persistence: Automatic (VS Code API)
// Size limit: ~50MB per workspace (VS Code limit)

globalState.update('ballerina-ai-chat-${projectId}', conversationState);
```

### Tier 2 Storage (Optional, Backend-specific)

```typescript
// Option 1: Local JSON
// Location: ${workspaceFolder}/.ballerina/memory.json
// Scope: Per workspace
// Persistence: Manual (file write)
// Size limit: Unlimited (disk space)

// Option 2: Claude Memory Tool
// Location: Anthropic backend
// Scope: Per workspace/project (metadata)
// Persistence: Automatic (Claude API)
// Size limit: 10MB per conversation (Anthropic default)

// Option 3: Cloud (PostgreSQL)
// Location: Cloud database
// Scope: Cross-workspace (user account)
// Persistence: Automatic (DB transactions)
// Size limit: Depends on plan
```

### Migration Strategy

```typescript
// When user enables Tier 2 for first time:
async function initializeLongTermMemory() {
  // 1. Create memory backend (prompt for choice)
  const backend = createMemoryBackend(userSelectedType);
  await backend.initialize();
  
  // 2. Scan existing Tier 1 conversations
  const existingConversations = loadAllConversations();
  
  // 3. Migrate summaries to long-term memory
  for (const conversation of existingConversations) {
    const summary = await summarizeConversation(conversation);
    const memory = createMemoryEntry(summary);
    await backend.save(memory);
  }
  
  console.log(`Migrated ${existingConversations.length} conversations to long-term memory`);
}
```

---

## API Design

### User-Facing Configuration

```typescript
// VS Code settings.json
{
  "ballerina.memory": {
    // Tier 1: Short-term Memory
    "tier1": {
      "enabled": true,                    // Always on
      "compressionThreshold": 150000,     // Compress when tokens > this
      "recentTurnsKept": 5,              // Keep last 5 turns uncompressed
      "groupSize": 4,                    // Compress groups of 4 turns
      "trackAppliedCode": true           // Track which suggestions are used
    },
    
    // Tier 2: Long-term Memory (Optional)
    "tier2": {
      "enabled": false,                  // User opt-in
      "backend": "claude-native",        // Options: claude-native, local-json, postgres
      "autoCapture": true,               // Auto-save important conversations
      "captureThreshold": 0.7,           // Complexity threshold
      "semanticSearchLimit": 5,          // Top-K results for retrieval
      "crossProjectSearch": false        // Don't include memories from other projects
    }
  }
}
```

### Extension API for Developers

```typescript
interface MemoryLayerAPI {
  // Tier 1: Context Management
  tier1: {
    getCurrentContext(): OptimizedChatHistory;
    compressHistory(): Promise<void>;
    trackCodeSuggestion(suggestion: GeneratedCode): string;
    markCodeApplied(suggestionId: string, commitHash: string): Promise<void>;
    getTokenEstimate(): number;
  };
  
  // Tier 2: Memory Management (optional)
  tier2?: {
    captureMemory(entry: MemoryEntry): Promise<string>;
    searchMemories(query: string, limit?: number): Promise<MemoryEntry[]>;
    retrieveMemoriesForContext(projectId: string): Promise<MemoryEntry[]>;
    deleteMemory(id: string): Promise<void>;
  };
  
  // Configuration
  getConfig(): MemoryConfig;
  updateConfig(config: Partial<MemoryConfig>): Promise<void>;
}

// Usage in code generation:
async function generateCode(prompt: string) {
  const context = memoryAPI.tier1.getCurrentContext();
  
  const messages = buildOptimizedPrompt(context);
  const response = await claude.message({ messages });
  
  const suggestionId = memoryAPI.tier1.trackCodeSuggestion(generatedCode);
  
  // Optional: Also save to long-term memory
  if (memoryAPI.tier2?.isEnabled) {
    await memoryAPI.tier2.captureMemory({
      type: 'episodic',
      content: `Generated ${generatedCode.type} for: ${prompt}`,
      sourceMessages: [suggestionId]
    });
  }
}
```

---

## Implementation Phases

### Phase 1: Short-Term Memory Enhancement (Weeks 1-3)

**Goal**: Fix token overflow and improve session coherence

**Tasks**:
1. Enhance `ChatMessage` type with optimization metadata
2. Implement `compressOldTurns()` async job
3. Build `buildOptimizedPrompt()` for LLM requests
4. Add applied code tracking with suggestion IDs
5. Create token accounting dashboard (debug view)
6. Write tests for compression logic
7. Update UI to show compression status

**Deliverables**:
- [ ] Compression reduces token usage by 30-40%
- [ ] No breaking changes to existing API
- [ ] Applied code tracking works for 100% of suggestions
- [ ] Full test coverage (>90%)

**Metrics to Track**:
- Before/after token usage per turn
- Compression ratio achieved
- Applied code detection accuracy

---

### Phase 2: Optional Long-Term Memory (Weeks 4-6)

**Goal**: Add optional cross-session memory with pluggable backends

**Tasks**:
1. Define `MemoryBackend` interface
2. Implement Claude Memory Tool backend
3. Implement Local JSON backend
4. Build `MemoryManager` orchestrator
5. Add embedding service (via Anthropic API)
6. Create memory retrieval in prompt building
7. Add memory settings to VS Code UI
8. Implement memory export/import

**Deliverables**:
- [ ] Memory backends pluggable and testable
- [ ] Claude Memory Tool backend working (if enabled)
- [ ] Local JSON backend for offline use
- [ ] Semantic search functional
- [ ] Settings UI intuitive and discoverable

**Metrics to Track**:
- Memory retrieval latency
- Embedding generation cost
- Cross-project knowledge reuse rate

---

### Phase 3: Memory UI & Dashboard (Weeks 7-8)

**Goal**: Help users understand and manage memory

**Tasks**:
1. Build memory viewer panel (tree of memories)
2. Add memory search interface
3. Create memory statistics dashboard
4. Implement memory export functionality
5. Add memory cleanup/deletion tools
6. Create memory audit trail

**Deliverables**:
- [ ] Users can browse all memories
- [ ] Users can search by text/tag
- [ ] Memory stats visible (size, age, usage)
- [ ] Clean UI design (matches Ballerina theme)

---

### Phase 4: Testing & Optimization (Weeks 9-10)

**Goal**: Ensure reliability and performance

**Tasks**:
1. Load testing (conversations with 100+ turns)
2. Performance profiling (memory usage, latency)
3. Security review (no PII leaked in memories)
4. User acceptance testing (internal + beta users)
5. Documentation (architecture guide, API reference)
6. Migration guide for existing users

**Deliverables**:
- [ ] Zero memory leaks detected
- [ ] Compression/retrieval <100ms
- [ ] E2E tests cover happy paths + edge cases
- [ ] Performance benchmarks published

---

## Considerations & Risks

### Performance Risks

**Risk 1: Embedding Generation Latency**
- Generating embeddings for each memory adds 2-5 seconds
- **Mitigation**: 
  - Batch embedding generation (async, non-blocking)
  - Cache embeddings (don't regenerate same text)
  - Use fast embedding model (Anthropic's text-embedding-small)

**Risk 2: Memory Search Slowness**
- Semantic search over large memory store could be slow
- **Mitigation**:
  - Index by tags first (fast filtering)
  - Limit search to current project
  - Cache popular searches
  - Consider vector DB for scale (Phase 2+)

**Risk 3: Storage Bloat**
- Long-term memory could grow unbounded
- **Mitigation**:
  - Implement memory TTL (expire old memories)
  - Add archival functionality
  - Set per-project memory quotas
  - Provide cleanup tools

### Security & Privacy Risks

**Risk 1: Sensitive Data in Memories**
- Passwords, API keys, PII might be captured
- **Mitigation**:
  - PII scanner before saving to long-term memory
  - Users can mark content as "private" (not saved)
  - Encryption for stored memories (local)
  - Audit trail of what was saved

**Risk 2: Cross-Project Leakage**
- Memory from one project visible to others
- **Mitigation**:
  - Memories tagged with projectId
  - Search filtered by project (unless explicitly cross-project)
  - Access controls if using shared backend

### Compatibility Risks

**Risk 1: Claude Model Changes**
- Claude Memory Tool API might change
- **Mitigation**:
  - Use abstract `MemoryBackend` interface
  - Pin Claude API version
  - Maintain alternative backends
  - Monitor Anthropic release notes

**Risk 2: VS Code globalState Limits**
- Tier 1 might hit size limits
- **Mitigation**:
  - Monitor globalState size
  - Archive old conversations to Tier 2
  - Split by project (already doing this)

### Cost Risks

**Risk 1: API Costs (Embeddings)**
- Each memory requires embedding generation (~1 cent per embedding)
- Auto-capture could be expensive
- **Mitigation**:
  - Batch embedding generation (more efficient)
  - User controls auto-capture threshold
  - Show cost estimate in settings

**Risk 2: LLM Token Usage**
- Larger prompts = higher costs
- **Mitigation**:
  - Compression reduces this significantly
  - Memory retrieval is selective (don't blindly add all)
  - Cache system prompts (Anthropic's prompt caching)

---

## Open Questions

### Q1: Should Tier 1 compression be automatic or user-configurable?
**Options**:
- A. Auto (behind the scenes, always on)
- B. User opt-in (in settings, requires awareness)
- C. Adaptive (auto if tokens > threshold)

**Recommendation**: **C. Adaptive** - Transparent to users, but configurable for power users.

---

### Q2: What should be the default Tier 2 backend?
**Options**:
- A. Claude Memory Tool (native, easiest)
- B. Local JSON (simple, no external deps)
- C. None (user must choose)

**Recommendation**: **C. None** - Let users opt-in and choose. Makes it clear it's optional and doesn't add latency/cost by default.

---

### Q3: How do we handle very long conversations (1000+ turns)?
**Options**:
- A. Just compress more aggressively
- B. Archive old conversations (archive to separate storage)
- C. Split into sub-conversations (automatic breakpoints)

**Recommendation**: **B. Archive** - After N turns, auto-archive conversation and start fresh. Keep archive queryable via Tier 2 search.

---

### Q4: Should users be able to manually merge memories?
**Options**:
- A. Yes (explicit UI for merging)
- B. No (auto-merge via LLM)
- C. Future work

**Recommendation**: **C. Future** - Phase 3 enhancement. Not MVP.

---

### Q5: How do we measure success?
**Metrics**:
1. Token usage per turn (should ↓ 30-40%)
2. Conversation coherence (user satisfaction survey)
3. Code suggestion de-duplication rate
4. Memory retrieval accuracy (found relevant memories?)
5. Performance (no latency regressions)

---

## Summary

This design proposes a **two-tier memory architecture**:

1. **Tier 1** (Short-term, always-on): Enhances existing system
   - Intelligent compression to avoid token overflow
   - Applied code tracking for de-duplication
   - ~30-40% token savings per turn
   - Ready for Phase 1 implementation

2. **Tier 2** (Long-term, optional): Adds cross-session knowledge
   - Pluggable memory backends
   - Claude Memory Tool as one option (not required)
   - Semantic search over past conversations
   - Configurable via settings
   - Ready for Phase 2-4 after Tier 1 is stable

**Next Steps**:
1. **Get stakeholder approval** on this design
2. **Clarify open questions** (Q1-Q5)
3. **Define success metrics** for Tier 1
4. **Start Phase 1 implementation** (compression, code tracking)
5. **Schedule design review** after Tier 1 MVP

---

**Document Version**: 1.0  
**Last Updated**: December 16, 2025  
**Status**: Ready for Review  
