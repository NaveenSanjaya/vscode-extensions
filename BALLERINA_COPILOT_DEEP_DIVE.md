# Ballerina Copilot: Complete System Deep Dive

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture Layers](#architecture-layers)
3. [Data Flow Diagrams](#data-flow-diagrams)
4. [Key Components & Responsibilities](#key-components--responsibilities)
5. [Conversation Lifecycle](#conversation-lifecycle)
6. [LLM Integration Pattern](#llm-integration-pattern)
7. [State Management](#state-management)
8. [RPC Communication](#rpc-communication)
9. [Code Generation Pipeline](#code-generation-pipeline)

---

## System Overview

Ballerina Copilot is a **multi-layered agentic coding assistant** for building integrations. It spans:

- **VS Code Extension** (TypeScript) - Backend logic, LLM calls, file system access
- **Web-based UI** (React) - Visualization layer, chat interface
- **Backend Services** (Cloud API) - Documentation, vectorized search, authentication
- **Ballerina Language Server** (LS) - Code analysis, project introspection

### Key Capabilities
- **Code Generation** - From natural language prompts, requirements files, templates
- **Conversation Memory** - Multi-turn chats with persistent history per project
- **Context Awareness** - Understands open files, project structure, code selections
- **Tool-Based AI** - LLM can call tools to search docs, analyze code, select libraries
- **Multiple Auth Methods** - GitHub/WSO2 OAuth, API keys, AWS Bedrock

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                      VS Code UI Layer                           │
│  (Ballerina VS Code Extension - built-in Ballerina support)    │
└─────────────────────────────────────────────────────────────────┘
                              ↕ (Commands, Webview API)
┌─────────────────────────────────────────────────────────────────┐
│                 VS Code Extension Layer                         │
│  ┌──────────────────────┬──────────────────────────────────────┐
│  │  Feature Managers    │     RPC Managers                     │
│  │  - AI Features       │  - AI Panel RPC Manager              │
│  │  - Commands          │  - Visualizer RPC Manager            │
│  │  - Auth Flow         │  - Handles request/response          │
│  └──────────────────────┴──────────────────────────────────────┘
│                              ↕
│  ┌──────────────────────────────────────────────────────────────┐
│  │              Service Layer                                   │
│  │  ┌──────────┬─────────┬──────────┬──────────┬──────────┐    │
│  │  │  Code    │  Ask    │ DataMapper│ Design  │  Test   │    │
│  │  │Generation│Service  │ Service  │ Service │ Service │    │
│  │  └──────────┴─────────┴──────────┴──────────┴──────────┘    │
│  │                              ↕                               │
│  │  ┌──────────────────────────────────────────────────────┐   │
│  │  │         Connection & LLM Layer                       │   │
│  │  │  - Anthropic Claude API Client                       │   │
│  │  │  - AWS Bedrock Integration                           │   │
│  │  │  - Tool definitions & execution                      │   │
│  │  │  - Cache control & streaming                         │   │
│  │  └──────────────────────────────────────────────────────┘   │
│  └──────────────────────────────────────────────────────────────┘
│                              ↕ (HTTP/Fetch)
│  ┌──────────────────────────────────────────────────────────────┐
│  │          Storage Layer                                       │
│  │  - VS Code Secrets API (credentials, tokens)                │
│  │  - VS Code Global State (chat history per project)          │
│  │  - Workspace file system (project analysis)                 │
│  └──────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
                              ↕ (Messenger RPC)
┌─────────────────────────────────────────────────────────────────┐
│                  Visualizer (React Web View)                    │
│  ┌──────────────────────────────────────────────────────────────┐
│  │  AI Panel Component                                          │
│  │  - Chat UI (conversation display)                            │
│  │  - Input field (user prompts)                                │
│  │  - Settings panel (auth, model selection)                    │
│  │  - Document output (rendered code/docs)                      │
│  └──────────────────────────────────────────────────────────────┘
│                              ↕ (localStorage)
│  ┌──────────────────────────────────────────────────────────────┐
│  │  Client-side Storage                                         │
│  │  - Chat history (display cache)                              │
│  │  - Session state                                             │
│  │  - User preferences                                          │
│  └──────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
                              ↕ (HTTP/Fetch)
┌─────────────────────────────────────────────────────────────────┐
│                   Backend Services (Cloud)                      │
│  ┌────────────────────────────────────────────────────────────┐
│  │  - Documentation API (/learn-docs-api/v1.0)               │
│  │  - Central API Docs (/central-api-docs)                   │
│  │  - Context Upload API (/context-upload-api/v1.0)          │
│  │  - User Token Management                                   │
│  └────────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│              External Services                                  │
│  - Anthropic Claude (LLM)                                      │
│  - AWS Bedrock (Alternative LLM provider)                      │
│  - GitHub OAuth / WSO2 Auth                                    │
│  - Vector Database (for docs/API search)                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagrams

### 1. User Opens AI Panel & Authenticates

```
User clicks "AI" in sidebar
         ↓
VS Code triggers OPEN_AI_PANEL command
         ↓
aiMachine.ts: Initialize state
         ↓
Invoke checkToken() service
         ↓
checkToken attempts to load:
  ├─ localStorage.get('login_method')
  ├─ VS Code Secrets.get('BallerinaAuthCredentials')
  └─ Validates token expiry
         ↓
[IF NO VALID TOKEN]
     ↓
State → Unauthenticated
AiPanelWebview opens with LoginPanel
     ↓
User clicks "Sign in with GitHub"
     ↓
initiateInbuiltAuth() opens OAuth popup
     ↓
Browser redirects to GitHub OAuth → Returns code
     ↓
Code → sent to backend → Returns access_token
     ↓
access_token → stored in VS Code Secrets
     ↓
COMPLETE_AUTH event
     ↓
State → Authenticated
     ↓
[IF VALID TOKEN]
     ↓
State → Authenticated
AI Panel displays chat interface
```

### 2. User Sends Prompt → Code Generation

```
User types prompt: "Create a REST API with GET and POST"
         ↓
ChatInput component captures text
         ↓
User clicks Send
         ↓
AIPanel.tsx → sendAIChatRequest() (RPC call)
         ↓
Extension: rpc-manager.ts → handleGenerateCode()
         ↓
[1] Extract Context:
    ├─ getCurrentProjectSource() - analyze workspace
    ├─ getChatHistory() - load previous messages
    ├─ extractCodeContext() - get selected code/cursor position
    └─ loadFileAttachments() - user-uploaded files
         ↓
[2] Prepare Request:
    ├─ Rewrite prompt with context
    ├─ Transform project source into SourceFiles[]
    ├─ Create GenerateCodeRequest
    └─ Build ModelMessage[] with chat history
         ↓
[3] Call generateCodeCore():
    ├─ Create system prompt with:
    │  ├─ Current project structure
    │  ├─ Available libraries & tools
    │  └─ Code generation guidelines
    ├─ Include chat history as context
    ├─ Define tools the LLM can call:
    │  ├─ LibraryProviderTool (search libraries)
    │  ├─ File read/write tools
    │  └─ Project analysis tools
    └─ Stream response from Claude Sonnet-4.5
         ↓
[4] LLM Response Processing:
    ├─ Parse streamed content
    ├─ Detect tool calls (e.g., "select_libraries")
    ├─ Execute tools:
    │  └─ Search backend for matching libraries
    ├─ Inject tool results back into conversation
    └─ Continue LLM stream until done
         ↓
[5] Post-Processing:
    ├─ Extract code blocks from response
    ├─ Map to file changes
    ├─ Run postProcess() for validation:
    │  ├─ Check syntax (Ballerina compiler)
    │  ├─ Detect conflicts
    │  └─ Generate diagnostics
    └─ Emit events to UI
         ↓
[6] UI Updates:
    ├─ Send ChatNotify event with response text
    ├─ Send code preview event
    ├─ Display "Apply Changes" button
    └─ User clicks "Apply" → files written to workspace
         ↓
[7] Persistence:
    ├─ Store message in globalState
    │  └─ chatHistory[projectId][sessionId].push(message)
    ├─ Store in localStorage (visualizer layer)
    └─ Emit artifact updated notification
```

### 3. Ask Service: Retrieving Documentation Context

```
generateCodeCore() builds messages array
         ↓
Message includes user question + code context
         ↓
LLM (Claude) decides: "I need to search documentation"
         ↓
LLM executes tool: extract_learn_pages({ query: "REST API" })
         ↓
Tool handler in ask.ts:
  ├─ Call fetchDocumentationFromVectorStore()
  ├─ POST to BACKEND_URL/learn-docs-api/v1.0/topK
  ├─ Backend searches vector DB with embeddings
  └─ Returns top-K docs: [{ document: "...", metadata: {...} }]
         ↓
Also executes: extract_central_api_docs({ query: "http:Client" })
         ↓
Tool handler:
  ├─ Call extractApiDocumentation()
  ├─ POST to BACKEND_URL/central-api-docs
  ├─ Backend searches library catalogs
  └─ Returns API signatures + examples
         ↓
LLM receives tool results
         ↓
LLM generates code using:
  ├─ Knowledge base (training)
  ├─ Retrieved docs (context)
  ├─ Previous chat turns
  └─ Current project state
         ↓
Response includes code + references
         ↓
UI shows: [Generated Code] and [References to docs]
```

---

## Key Components & Responsibilities

### Extension Layer Components

#### 1. **AI Feature Manager** (`src/features/ai/activator.ts`)
- **Responsibility**: Register AI-related commands, initialize services
- **On Activate**:
  - `activateCopilotLoginCommand()` - listen for login events
  - `resetBIAuth()` - clean auth state
  - Register test commands (if AI_TEST_ENV)
- **Exports**:
  - `langClient` - Extended Language Client for LS communication

#### 2. **Code Generation Service** (`src/features/ai/service/code/code.ts`)
- **Responsibility**: Core code generation pipeline
- **Key Functions**:
  - `generateCodeCore(params, eventHandler)`:
    - Get project source from LS
    - Build LLM messages array
    - Stream from Claude Sonnet-4.5
    - Execute tool calls (library search, file I/O)
    - Emit events to UI
  - `getSystemPromptPrefix/Suffix()` - Build system prompts
  - `getUserPrompt()` - Format user prompt with context
- **Tools Available to LLM**:
  - `LibraryProviderTool` - search/select Ballerina libraries
  - `FileWriteTool`, `FileReadTool`, `FileEditTool` - manipulate workspace files

#### 3. **Ask Service** (`src/features/ai/service/ask/ask.ts`)
- **Responsibility**: Tool-based documentation retrieval for LLM
- **Tools Defined**:
  - `extract_learn_pages` - search Ballerina Learn Pages (concepts, syntax, best practices)
  - `extract_central_api_docs` - search Central API docs (library functions, types)
- **Flow**:
  1. LLM decides it needs docs
  2. LLM calls tool with query
  3. Service fetches from backend vector DB
  4. Returns documents with metadata & links
  5. LLM embeds docs in next response

#### 4. **Connection Layer** (`src/features/ai/service/connection.ts`)
- **Responsibility**: LLM provider abstraction
- **Clients**:
  - Anthropic Claude (primary) - models: HAIKU (fast), SONNET-4.5 (powerful)
  - AWS Bedrock (alternative)
- **Features**:
  - Automatic token refresh
  - Provider cache control (for prompt caching)
  - Auth header injection via `fetchWithAuth()`
- **Models**:
  - HAIKU: Fast for simple tasks (ask service)
  - SONNET-4.5: Powerful for complex code generation

#### 5. **RPC Manager** (`src/rpc-managers/ai-panel/rpc-manager.ts`)
- **Responsibility**: Bridge between Extension and Visualizer (React UI)
- **Exposed Methods** (to visualizer):
  - `generateCode(params)` - initiate code generation
  - `generateAgentCode(params)` - agentic planning + code gen
  - `getProjectSource()` - get current project state
  - `postProcess()` - validate generated code
  - `searchDocumentation()` - get doc context
  - `getAiPanelContext()` - load chat history, project info
- **Size**: 978 lines - largest RPC handler

#### 6. **State Machine** (`src/views/ai-panel/aiMachine.ts`)
- **Responsibility**: Authentication state management
- **States**:
  ```
  Initialize
    ├─ (success) → Authenticated
    ├─ (no token) → Unauthenticated
    └─ (error) → Disabled
  
  Unauthenticated
    ├─ LOGIN → Authenticating (SSO flow)
    ├─ AUTH_WITH_API_KEY → Authenticating (API key flow)
    └─ AUTH_WITH_AWS_BEDROCK → Authenticating (AWS flow)
  
  Authenticating
    ├─ ssoFlow: Browser → GitHub/WSO2 OAuth
    ├─ apiKeyFlow: Validate Anthropic API key
    └─ awsBedrockFlow: Validate AWS credentials
    └─ (success) → COMPLETE_AUTH → Authenticated
    └─ (cancel) → CANCEL_LOGIN → Unauthenticated
  
  Authenticated
    ├─ Can access all AI features
    └─ LOGOUT → Unauthenticated
  
  Disabled: Fatal error state
  ```

### Visualizer (React) Components

#### 1. **AIPanel.tsx**
- Chat interface - displays conversation
- Input field - user prompts
- Send button - triggers `sendAIChatRequest()` RPC
- Streaming response display

#### 2. **SettingsPanel/index.tsx**
- GitHub Copilot authorization
- Model selection
- Provider configuration
- Token management

#### 3. **LoginPanel**
- OAuth flow UI
- API key input
- AWS Bedrock credentials form

---

## Conversation Lifecycle

### Persistent Storage (Multi-turn Support)

```
Project 1 (workspace folder)
  └─ Session 1 (conversation instance)
     ├─ Message 1: User "Generate REST API"
     │  └─ assistantResponse: generated code
     │  └─ timestamp: 1702000000
     │  └─ checkpointId: "ckpt_001" (snapshot of workspace)
     ├─ Message 2: User "Add authentication"
     │  └─ assistantResponse: updated code
     │  └─ timestamp: 1702001000
     │  └─ checkpointId: "ckpt_002"
     └─ Message 3: User "Create unit tests"
        └─ assistantResponse: test code
        └─ timestamp: 1702002000
        └─ checkpointId: "ckpt_003"

Project 2 (different workspace folder)
  └─ Session 1 (separate conversation)
     └─ Message 1: User "Create GraphQL server"
```

### Storage Mechanisms

**1. Extension State (globalState)**
```typescript
// Key: `ballerina-ai-chat-${projectHash}`
interface ConversationState {
  sessionId: string;
  messages: ChatMessage[];
  checkpoints: Checkpoint[];
  metadata: {
    createdAt: timestamp;
    lastModified: timestamp;
    projectUri: string;
  }
}

interface ChatMessage {
  id: string;                    // unique message ID
  content: string;               // user prompt
  uiResponse: string;            // assistant response
  modelMessages: ModelMessage[]; // raw LLM responses (from 'ai' library)
  timestamp: number;
  checkpointId?: string;         // link to workspace snapshot
}

interface Checkpoint {
  id: string;
  timestamp: number;
  workspaceSnapshot: {
    [filePath: string]: string;  // file contents
  }
}
```

**2. Visualizer State (localStorage)**
```typescript
// Key: `chatArray-AIGenerationChat-${projectUuid}`
interface UIConversationState {
  messages: UIChatHistoryMessage[];
  lastQuestion: string;
  integrationStatus: {
    messageId: string;
    isIntegrated: boolean;
  }[];
}

interface UIChatHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}
```

### Memory in Recent Context

When user sends a message:

1. **Retrieve history**:
   - Load globalState: `ballerina-ai-chat-${projectHash}`
   - Extract last N messages (e.g., last 10 for context window)

2. **Build context**:
   ```typescript
   const chatHistory = previousMessages.map(m => ({
     role: 'user',
     content: m.userPrompt
   }, {
     role: 'assistant',
     content: m.assistantResponse
   }));
   
   const modelMessages = [
     { role: 'system', content: systemPrompt },
     ...chatHistory,  // Previous turns
     { role: 'user', content: currentUserInput }  // Current turn
   ];
   ```

3. **Send to LLM**:
   - Claude Sonnet-4.5 receives full context
   - Can reference previous messages
   - Generates contextual response

4. **Store result**:
   ```typescript
   const newMessage: ChatMessage = {
     id: generateId(),
     content: userPrompt,
     uiResponse: assistantResponse,
     modelMessages: llmMessages,  // Full conversation
     timestamp: Date.now(),
     checkpointId: capturedCheckpoint.id
   };
   
   globalState.set(
     `ballerina-ai-chat-${projectHash}`,
     [...previousMessages, newMessage]
   );
   ```

### Issues with Current Approach (Why Memory Layer Needed)

1. **Context Window Pressure**
   - Each turn sends FULL history to LLM
   - Long conversations quickly hit token limits
   - Costs increase linearly with conversation length

2. **Redundant Code Suggestions**
   - No detection if code was already applied
   - LLM suggests same code again in later turns
   - No pruning of stale suggestions

3. **No Summarization**
   - Raw message history isn't semantic
   - LLM can't distinguish important insights from noise
   - No task/design decision tracking

4. **Search & Retrieval Gap**
   - Can't query "What was our decision about error handling?"
   - No semantic search over past turns
   - All history treated equally (FIFO)

---

## LLM Integration Pattern

### Current Setup

**LLM Provider**: Anthropic Claude
```typescript
const client = createAnthropic({
  apiKey: await getAccessToken()
});
```

**Models**:
- `claude-3-5-haiku-20241022` - Fast, cheap (for Ask service)
- `claude-sonnet-4-5-20250929` - Powerful, expensive (for code generation)

**Streaming with Tool Support**:
```typescript
const stream = streamText({
  model: client(ANTHROPIC_SONNET_4),
  system: systemPrompt,
  tools: {
    LibraryProviderTool: {
      description: "Search and select Ballerina libraries",
      parameters: z.object({
        query: z.string(),
        limit: z.number()
      })
    },
    FileReadTool: {
      description: "Read a file from the workspace",
      parameters: z.object({
        filePath: z.string()
      })
    }
    // ... more tools
  },
  messages: modelMessages,  // Chat history
  maxSteps: 10,            // Max tool calls per response
  temperature: 0.7         // Creativity level
});
```

**Tool Execution Flow**:
1. LLM generates tool call (e.g., `{"type": "tool_call", "name": "LibraryProviderTool", "input": {...}}`)
2. Extension intercepts, verifies tool is in allowed set
3. Executes tool (e.g., searches library database)
4. Wraps result: `{"type": "tool_result", "content": "...results..."}`
5. Sends back to LLM for next generation step
6. Repeats until LLM emits text or `maxSteps` exceeded

### Prompt Engineering

**System Prompt Structure**:
```
You are an expert Ballerina programming assistant...

Current Project Structure:
[file tree]

Available Libraries:
[list with descriptions]

Code Generation Guidelines:
1. Always import used modules
2. Use error handling patterns
3. Follow Ballerina naming conventions
...

Previous Conversation Context:
[last N messages summarized or raw]
```

**User Prompt Format**:
```
CONTEXT:
- Current file: main.bal
- Selection: [highlighted code]
- Project: my-integration

TASK:
Generate a REST API with GET and POST endpoints

FILES TO MODIFY:
- main.bal (append new service)
```

---

## State Management

### XState Machine (Authentication)

```typescript
const aiMachine = createMachine({
  id: 'ballerina-ai',
  initial: 'Initialize',
  context: {
    loginMethod: undefined,
    userToken: undefined,
    errorMessage: undefined
  },
  
  // Transitions happen via AIStateMachine.service().send(event)
  // Example: AIStateMachine.sendEvent(AIMachineEventType.LOGIN)
});

// Service instance
const interpreter = interpret(aiMachine)
  .onTransition((state) => {
    // Update UI based on state
    console.log('Machine state:', state.value);
  })
  .start();

// Global access
export const AIStateMachine = {
  service: () => interpreter,
  sendEvent: (event) => interpreter.send(event)
};
```

### Context/State Data

```typescript
interface AIMachineContext {
  loginMethod: LoginMethod | undefined;  // Which auth method
  userToken: AIUserToken | undefined;    // Current access token + expiry
  errorMessage: string | undefined;      // Any error during auth
}

interface AIUserToken {
  token: string;
  expiresAt?: number;  // Unix timestamp
  refreshToken?: string;
}
```

### Event Types

```typescript
enum AIMachineEventType {
  LOGIN = 'LOGIN',                         // Initiate OAuth
  AUTH_WITH_API_KEY = 'AUTH_WITH_API_KEY',
  AUTH_WITH_AWS_BEDROCK = 'AUTH_WITH_AWS_BEDROCK',
  COMPLETE_AUTH = 'COMPLETE_AUTH',        // Auth succeeded
  CANCEL_LOGIN = 'CANCEL_LOGIN',          // User cancelled
  SUBMIT_API_KEY = 'SUBMIT_API_KEY',
  LOGOUT = 'LOGOUT',
  DISPOSE = 'DISPOSE'                     // Clean up
}
```

---

## RPC Communication

### Protocol

**Technology**: vscode-messenger (JSON-RPC wrapper for VS Code webview API)

**Direction**: Bidirectional (Extension ↔ Visualizer)

### Request/Response Examples

**Code Generation Request**:
```typescript
// From Visualizer:
const response = await rpcClient.generateCode({
  usecase: "Create REST API",
  chatHistory: [
    { role: 'user', content: 'Add authentication' },
    { role: 'assistant', content: 'Here is the code...' }
  ],
  operationType: OperationType.CODE_GENERATION,
  fileAttachmentContents: [],
  codeContext: {
    type: 'selection',
    startPosition: { line: 10, character: 0 },
    endPosition: { line: 20, character: 0 },
    filePath: 'main.bal'
  }
});

// Extension processes → calls generateCodeCore() → streams response
// Response sent back via:
//   - ChatNotify events (streaming text)
//   - PostProcessResponse (validation results)
//   - Artifact updates (file changes)
```

**Chat History Retrieval**:
```typescript
// From Visualizer:
const history = await rpcClient.getAiPanelContext();

// Extension returns:
{
  state: { value: 'Authenticated' },
  context: { loginMethod: 'BI_INTEL', userToken: {...} },
  chatHistory: ChatMessage[],
  checkpoints: Checkpoint[]
}
```

### Event Streaming

**ChatNotify Events** (sent from Extension during generation):
```typescript
interface ChatNotify {
  type: 'start' | 'delta' | 'finish' | 'error';
  content: string;
  metadata?: {
    toolName?: string;
    toolInput?: any;
    toolOutput?: any;
  }
}

// Example:
onChatNotify(event => {
  if (event.type === 'start') {
    setIsGenerating(true);
  } else if (event.type === 'delta') {
    setResponse(prev => prev + event.content);  // Stream text
  } else if (event.type === 'finish') {
    setIsGenerating(false);
    saveChatMessage();  // Persist
  }
});
```

---

## Code Generation Pipeline

### Step-by-Step Flow (Detailed)

#### Step 1: Extract Project Source
```typescript
const project: ProjectSource = await getProjectSource(operationType);

// Returns:
{
  projectName: 'my-integration',
  sourceFiles: [
    { filePath: 'main.bal', content: '...' },
    { filePath: 'utils.bal', content: '...' },
    { filePath: 'tests/test_main.bal', content: '...' }
  ],
  projectModules: [
    {
      moduleName: 'payment',
      sourceFiles: [...],
      isGenerated: false
    }
  ]
}
```

#### Step 2: Create Temp Project Copy
```typescript
const { path: tempProjectPath, modifications } = await getTempProject(
  project,
  hasHistory  // true = continuing session, copy current state
);

// Rationale: 
// - LLM can read/write to temp files
// - Not affecting live project during generation
// - Can rollback if generation fails
```

#### Step 3: Build LLM Message Array
```typescript
const allMessages: ModelMessage[] = [
  {
    role: 'system',
    content: getSystemPromptPrefix(sourceFiles, operationType)
    // Includes: project structure, file tree, coding guidelines
  },
  {
    role: 'system',
    content: getSystemPromptSuffix(LANGLIBS),  // Library descriptions
    providerOptions: {
      cache_control: { type: 'ephemeral' }  // Use Anthropic cache
    }
  },
  ...populateHistory(params.chatHistory),  // Previous turns
  {
    role: 'user',
    content: getUserPrompt(prompt, sourceFiles)  // Current user input
  }
];
```

#### Step 4: Stream Response with Tools
```typescript
const stream = await streamText({
  model: client(ANTHROPIC_SONNET_4),
  system: allMessages.filter(m => m.role === 'system'),
  tools: {
    [SEARCH_LIBRARY_TOOL_NAME]: getLibraryProviderTool(),
    [FILE_WRITE_TOOL_NAME]: createWriteTool(tempProjectPath),
    [FILE_READ_TOOL_NAME]: createReadTool(tempProjectPath),
    [FILE_EDIT_TOOL_NAME]: createEditTool(tempProjectPath),
    // ... more file manipulation tools
  },
  messages: allMessages.filter(m => m.role !== 'system'),
  maxSteps: 10,
  onStepFinish: (event) => {
    // After each tool call completes
    sendDeltaNotification(event);
  }
});

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') {
    eventHandler({ type: 'delta', content: chunk.text });
  } else if (chunk.type === 'tool-result') {
    // Tool call executed, process result
  }
}
```

#### Step 5: Post-Process Generated Code
```typescript
const result = await postProcess({
  generatedFiles: extractedFiles,
  originalProject: project,
  diagnostics: diagnosticCollector.getDiagnostics()
});

// Validates:
// - Syntax correctness (via Ballerina LS)
// - Import statement validity
// - No file conflicts
// - Module structure integrity
```

#### Step 6: Apply Changes to Workspace
```typescript
if (result.isValid) {
  await addToIntegration(workspaceFolderPath, result.fileChanges);
  
  // This:
  // 1. Creates/modifies files in workspace
  // 2. Calls workspace.saveAll()
  // 3. Notifies Language Server
  // 4. Triggers artifact update
}
```

#### Step 7: Persist to Storage
```typescript
const newMessage: ChatMessage = {
  id: generateUniqueId(),
  content: userPrompt,
  uiResponse: assistantResponse,
  modelMessages: completedMessages,
  timestamp: Date.now(),
  checkpointId: lastCheckpoint?.id
};

await extension.context.globalState.update(
  `ballerina-ai-chat-${projectId}`,
  [...previousMessages, newMessage]
);
```

---

## Key Insights for Memory Layer Integration

### Where Memory Should Hook In

1. **Applied-Code Detection**
   - Hook after `postProcess()` succeeds
   - Compare generated files with actual workspace commits
   - Mark code as "applied" in storage
   - Index applied code with embedding for future de-duplication

2. **Conversation Summarization**
   - After every N messages (e.g., 5) or on session end
   - Call LLM with Haiku (fast): "Summarize this conversation into: Task, Design decisions, Open TODOs"
   - Store summary with vector embedding
   - Keep raw messages for retrieval, but inject summaries into system prompt

3. **Memory Retrieval**
   - Modify `getUserPrompt()` to include injected memories
   - Before sending to LLM, query memory store:
     - Search: "What have we decided about error handling?"
     - Retrieve top-K relevant memories
     - Format as: "From previous conversation: ..."
   - Keeps context small, focused, and informative

4. **Storage Location**
   - Extend `globalState`:
     - `ballerina-ai-chat-${projectId}` - raw chat (current)
     - `ballerina-ai-memory-${projectId}` - new memory store
       - Task summaries
       - Design decisions
       - Applied code index
       - Vector embeddings for search

### Expected Benefits

- **Token Savings**: 40-60% reduction per turn (fewer raw messages sent)
- **Coherence**: LLM maintains consistent design decisions across turns
- **De-duplication**: No repeated code suggestions
- **Searchability**: "What was our API auth approach?" can be answered from memory
- **Scalability**: Conversations can span 50+ turns without context explosion

---

## Quick Reference: File Locations

| Component | Path | LOC | Purpose |
|-----------|------|-----|---------|
| Code Generation | `src/features/ai/service/code/code.ts` | 629 | Core generation pipeline |
| Ask Service | `src/features/ai/service/ask/ask.ts` | 299 | Tool-based doc retrieval |
| Connection | `src/features/ai/service/connection.ts` | 199 | LLM client abstraction |
| RPC Manager | `src/rpc-managers/ai-panel/rpc-manager.ts` | 978 | Visualizer bridge |
| AI Machine | `src/views/ai-panel/aiMachine.ts` | 441 | Auth state machine |
| Utils | `src/rpc-managers/ai-panel/utils.ts` | 300+ | Context, storage, validation |
| Activator | `src/features/ai/activator.ts` | 150 | Feature initialization |
| Webview | `src/views/ai-panel/webview.ts` | 300+ | VS Code webview lifecycle |

---

## Glossary

- **Checkpoint**: Snapshot of entire workspace at a point in conversation
- **OperationType**: Code generation mode (CODE_GENERATION, TEST_GENERATION, etc.)
- **Model Message**: LLM message format from 'ai' library (role: 'user'/'assistant'/'system'/'tool')
- **Chat Entry**: Application-level chat message type (user input + assistant response)
- **Tool Call**: LLM requesting execution of a function (e.g., search libraries)
- **Post-Processing**: Validation of generated code before applying to workspace
- **Prompt Caching**: Anthropic feature to cache expensive system prompts
- **RPC**: Remote Procedure Call (Extension ↔ Visualizer communication)
- **globalState**: VS Code API for persistent extension storage (per workspace)
- **Webview**: Embedded browser window in VS Code for UI

