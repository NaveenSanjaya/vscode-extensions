# Ballerina Copilot - Memory Functionality Testing Guide

This guide helps you test the current memory capabilities of the Ballerina Copilot to establish a baseline before implementing the enhanced memory layer.

---

## Test Results Summary

| Feature | Expected | Actual | Status |
|---------|----------|--------|--------|
| Chat history (same session) | Remember previous messages | Remembered the HTTP service I asked about and added endpoint to it | ✅ |
| Code context awareness | Use selected code | Modified the selected function correctly with error handling | ✅ |
| Multi-turn conversation | Maintain context | After 4 messages, still knew we were talking about database connections | ✅ |
| Cross-session memory | Remember after reload | After reloading window, have memory of previous conversation | ✅ |
| Semantic search | Find related concepts | Asked about "login security" after "authentication" discussion - didn't connect them | ❌ |
| Applied code tracking | Know what code was used | No applied code tracking | ❌ |
| Workspace Snapshot/Checkpoint System | Checkpoint functionality in checkpoints array | Memory is only in RAM (session-only) | ⚠️ |
| Long Conversation Handling | How the system handles large conversation history | forgotten early messages due to context window limits | ⚠️ |

**Status Key:**
- ✅ Works as expected
- ❌ Doesn't work or doesn't exist
- ⚠️ Works partially with limitations

Note: Cross-session memory showed as working in your run. This may be due to a reused session or backend rehydration. To double‑check persistence, fully close the Extension Development Host, relaunch with F5, start a new chat session, and confirm whether prior messages are still available. You can also open DevTools (F12) and verify there is no `localStorage`/`sessionStorage` usage for chat history.

---

## Test 1: Chat History Memory (Short-term)

**What it tests:** `chatHistory` in XState context - whether the Copilot remembers messages in the current session.

**Steps:**
1. Open the Copilot panel in the Extension Development Host
2. Ask: `Create a simple HTTP service on port 8080`
3. Wait for the complete response
4. Then ask: `Add a GET endpoint to the service` (don't specify which service)
5. Observe if it knows you're referring to the service from step 2

**Expected Result:** ✅ Should remember and add the endpoint to the previously created service

**Record your findings:**
- **Actual:** _____________________________________
- **Status:** ___

---

## Test 2: Code Context Memory

**What it tests:** `codeContext` - whether the Copilot uses selected code as context.

**Steps:**
1. Create a new file `service.bal` with this code:
   ```ballerina
   import ballerina/http;
   
   service /api on new http:Listener(9090) {
       resource function get users() returns json {
           return {users: []};
       }
   }
   ```
2. **Select the entire `resource function get users()` block** (highlight with mouse)
3. With the code still selected, ask in Copilot: `Add error handling to this function`
4. Check if the response specifically addresses the selected function

**Expected Result:** ✅ Should add error handling specifically to the selected `get users()` function

**Record your findings:**
- **Actual:** _____________________________________
- **Status:** ___

---

## Test 3: Multi-turn Conversation Continuity

**What it tests:** Context retention across multiple related questions.

**Steps:**
1. Ask: `What's the best way to handle database connections in Ballerina?`
2. Wait for response
3. Ask: `Show me an example` (don't say "example of database connections")
4. Wait for response
5. Ask: `How do I handle connection errors?` (don't repeat full context)

**Expected Result:** ✅ Should maintain context and know you're still talking about database connections in all 3 questions

**Record your findings:**
- **Actual:** _____________________________________
- **Status:** ___

---

## Test 4: Session Persistence (Cross-session Memory)

**What it tests:** Whether memory persists after closing/reloading the extension.

**Steps:**
1. In the Copilot, ask: `Create a user authentication service with JWT tokens`
2. Get the full response and note what was discussed
3. **Close the Copilot panel** or reload the window:
   - Press `Ctrl+Shift+P`
   - Type and select: "Developer: Reload Window"
4. After reload, reopen the Copilot panel
5. Ask: `Can you remind me about the authentication service we discussed?`

**Expected Result:** ❌ Should NOT remember (no long-term persistence in current implementation)

**Record your findings:**
- **Actual:** _____________________________________
- **Status:** ___

---

## Test 5: Semantic Search (Related Concepts)

**What it tests:** Whether the Copilot can connect related concepts using different terminology.

**Steps:**
1. Have a conversation about authentication:
   - Ask: `How do I implement OAuth2 authentication in Ballerina?`
   - Get response
2. Clear the topic by asking something unrelated:
   - Ask: `How do I read a CSV file?`
   - Get response
3. Now ask about a related concept using different words:
   - Ask: `Tell me about login security best practices`
4. Check if it connects this to the earlier OAuth2 discussion

**Expected Result:** ❌ Likely won't connect the two concepts (no semantic memory/embeddings)

**Record your findings:**
- **Actual:** _____________________________________
- **Status:** ___

---

## Test 6: Applied Code Tracking

**What it tests:** Whether the Copilot knows which code suggestions were actually used.

**Steps:**
1. Ask: `Create a function to validate email addresses`
2. Get the generated code
3. **Copy and paste** the code into your `.bal` file
4. Save the file
5. Go back to the Copilot and ask: `What code have I actually used from our conversation?`

**Expected Result:** ❌ Won't know what code was applied (no Git integration or code tracking)

**Record your findings:**
- **Actual:** _____________________________________
- **Status:** ___

---

## Test 7: Workspace Snapshot/Checkpoint System

**What it tests:** The checkpoint functionality described in `checkpoints` array.

**Steps:**
1. Generate some code with the Copilot
2. Apply it to your project files
3. Check if checkpoints are being created:
   - Open DevTools in the Extension Development Host (F12)
   - Go to **Console** tab
   - Run: `localStorage` and look for checkpoint-related keys
   - Or run: `Object.keys(localStorage).filter(k => k.includes('ballerina'))`

**Expected Result:** ⚠️ Checkpoints may exist but are primarily for undo/redo, not for memory recall

**Record your findings:**
- **Actual:** _____________________________________
- **Status:** ___

---

## Test 8: Long Conversation Handling

**What it tests:** How the system handles large conversation history.

**Steps:**
1. Have a very long conversation (15-20 messages back and forth)
2. Ask a question that references something from the first few messages
3. Check if it still remembers or if context was truncated

**Expected Result:** ⚠️ May have forgotten early messages due to context window limits

**Record your findings:**
- **Actual:** _____________________________________
- **Status:** ___

---

## Advanced Testing: Inspecting Memory State

### View XState Context

**Option 1: Add Logging (Requires code change)**

1. Open [`workspaces/ballerina/ballerina-extension/src/views/ai-panel/aiChatMachine.ts`](workspaces/ballerina/ballerina-extension/src/views/ai-panel/aiChatMachine.ts)
2. Find where messages are processed
3. Add: `console.log('Current context:', context);`
4. Save and let watch mode rebuild
5. Reload the extension
6. Check DevTools Console to see the context state

**Option 2: Use DevTools**

1. In the Extension Development Host, open DevTools (F12)
2. Go to **Console** tab
3. Run these commands to check storage:
   ```javascript
   // Check localStorage
   Object.keys(localStorage).filter(k => k.includes('ballerina'))
   
   // Check sessionStorage
   Object.keys(sessionStorage).filter(k => k.includes('ballerina'))
   
   // View specific item
   localStorage.getItem('ballerina-copilot-chat-history')
   ```

### Check Network Requests

1. Open DevTools (F12) in Extension Development Host
2. Go to **Network** tab
3. Send a message to the Copilot
4. Look for requests to `dev-tools.wso2.com`
5. Click on the request and check:
   - **Payload tab:** See what context is being sent to the LLM
   - **Response tab:** See what the LLM returns

---

## What to Look For

### ✅ Features That Should Work

Based on the current implementation:
- Short-term chat history within a session
- Code context from selected text
- Workspace state awareness (open files, project info)
- Basic conversation continuity

### ❌ Features That Likely Don't Work

Based on the research report:
- Long-term memory across sessions
- Semantic search for related concepts
- Applied code tracking (Git integration)
- Conversation summarization
- Memory management UI
- Explicit memory retrieval by concept/tag

### ⚠️ Features That May Be Partial

- Checkpoint system exists but limited to undo/redo
- Context may be truncated in very long conversations
- Some workspace awareness but not comprehensive

---

## Comparing with the Research Report

After testing, compare your results with [MEMORY_LAYER_RESEARCH_REPORT.md](MEMORY_LAYER_RESEARCH_REPORT.md):

### Current State (From Report)
```typescript
context: {
    chatHistory: ChatMessage[],      // ← Short-term buffer
    currentSnapshot: Checkpoint,      // ← Current workspace state
    selectedCode: CodeContext,        // ← Current selection
}
```

### Proposed Enhancement (From Report)
```typescript
interface ProjectMemory {
    projectId: string;
    memories: MemoryEntry[];
}

interface MemoryEntry {
    id: string;
    type: 'episodic' | 'semantic' | 'procedural';
    content: string;
    embedding: number[];
    sourceMessages: string[];
    createdAt: timestamp;
    relevanceScore?: number;
    tags: string[];
}
```

---

## Test Summary Template

After completing all tests, fill out this summary:

### Working Features
1. _____________________________________
2. _____________________________________
3. _____________________________________

### Missing Features
1. _____________________________________
2. _____________________________________
3. _____________________________________

### Partially Working Features
1. _____________________________________
2. _____________________________________

### Priority Implementation Areas
Based on your testing, what should be implemented first?

1. _____________________________________
2. _____________________________________
3. _____________________________________

---

## Next Steps

1. ✅ Complete all tests above
2. ✅ Fill in the results table at the top
3. ✅ Document findings in the summary section
4. ✅ Review [MEMORY_LAYER_RESEARCH_REPORT.md](MEMORY_LAYER_RESEARCH_REPORT.md)
5. ✅ Compare current state vs. proposed architecture
6. ✅ Identify which features from the roadmap to implement first

---

**Testing Date:** ________________

**Tester:** ________________

**Extension Version:** ________________

**Notes:**
_____________________________________________
_____________________________________________
_____________________________________________
