# Implementation Plan: ChatStateStorage Persistence Layer

## Executive Summary

Add disk persistence to the existing `ChatStateStorage` class to prevent 100% data loss when VS Code closes. Currently all chat history, threads, and review states are stored in-memory only and lost on restart.

**Goal**: Persist the existing `WorkspaceChatState` structure to `.ballerina/copilot-memory/` as JSON files.

**Timeline**: 1-2 weeks

---

## Architecture Overview

### Current State (bi-1.6.x branch)
```
ChatStateStorage (in-memory only)
└── Map<workspaceId, WorkspaceChatState>
    └── WorkspaceChatState
        ├── workspaceId: string
        ├── threads: Map<threadId, ChatThread>
        │   └── ChatThread
        │       ├── id, name, createdAt, updatedAt
        │       └── generations: Generation[]
        │           └── Generation (userPrompt, modelMessages, reviewState, checkpoint?, plan?, etc.)
        └── activeThreadId: string
```

### Target State
```
ChatStateStorage (hybrid: memory + disk)
├── In-memory cache: Map<workspaceId, WorkspaceChatState>
└── Disk persistence: .ballerina/copilot-memory/workspace-{workspaceId}.json
    └── Debounced writes (1-2 seconds)
    └── Automatic load on initialization
    └── Backup on corruption
```

---

## Implementation Tasks

### Task 1: Create JsonFileStorage Module
**File**: `workspaces/ballerina/ballerina-extension/src/views/ai-panel/jsonFileStorage.ts` (NEW)

**Responsibilities**:
- Serialize/deserialize `WorkspaceChatState` to/from JSON
- Handle Map → Array conversion (threads are stored as Map but JSON needs arrays)
- Debouncing: Wait 1-2 seconds after last change before writing
- Corruption handling: Backup corrupted files and start fresh
- Size monitoring: Warn at 5MB per workspace file
- Git exclusion: Auto-add `.ballerina/copilot-memory` to `.git/info/exclude`

**Key Methods**:
```typescript
class JsonFileStorage {
    // Core persistence
    async saveWorkspace(state: WorkspaceChatState, immediate?: boolean): Promise<void>
    async loadWorkspace(workspaceId: string): Promise<WorkspaceChatState | null>

    // Utilities
    private serializeWorkspace(state: WorkspaceChatState): SerializableWorkspace
    private deserializeWorkspace(data: SerializableWorkspace): WorkspaceChatState
    private getFilePath(workspaceId: string): string
    private validateAndBackup(filePath: string): Promise<boolean>
    private checkSize(filePath: string): Promise<void>
    private ensureGitExclude(): Promise<void>
}
```

**Storage Location**: `.ballerina/copilot-memory/workspace-{workspaceId}.json`

**File Format**:
```json
{
  "workspaceId": "abc123",
  "threads": [
    ["default", {
      "id": "default",
      "name": "Default Thread",
      "generations": [...],
      "createdAt": 1704672000000,
      "updatedAt": 1704672000000
    }]
  ],
  "activeThreadId": "default",
  "savedAt": 1704672000000,
  "version": "1.0"
}
```

**Debouncing Strategy**:
- Maintain `Map<workspaceId, NodeJS.Timeout>` for pending saves
- Clear previous timer when new save requested
- Wait 1500ms of inactivity before writing
- Provide `immediate` flag for critical saves (on deactivation)

**Corruption Handling**:
1. Attempt to parse JSON
2. If parse fails → rename to `.workspace-{id}.json.backup.{timestamp}`
3. Create new empty workspace state
4. Show VS Code warning notification to user

**Size Monitoring**:
- Check file size after each save
- If > 5MB → show warning notification
- Suggest: "Your chat history is large (X MB). Consider clearing old conversations or archiving threads."

---

### Task 2: Integrate JsonFileStorage into ChatStateStorage
**File**: `workspaces/ballerina/ballerina-extension/src/views/ai-panel/chatStateStorage.ts` (MODIFY)

**Changes**:

#### 2.1: Add JsonFileStorage Instance
```typescript
export class ChatStateStorage {
    private storage: Map<string, WorkspaceChatState> = new Map();
    private activeExecutions: Map<string, Map<string, ActiveExecution>> = new Map();
    private fileStorage = new JsonFileStorage(); // ADD THIS
}
```

#### 2.2: Modify `initializeWorkspace()` to Load from Disk
**Current (line 62-86)**:
```typescript
initializeWorkspace(workspaceId: string): WorkspaceChatState {
    let workspaceState = this.storage.get(workspaceId);

    if (!workspaceState) {
        // Creates default thread from scratch
    }

    return workspaceState;
}
```

**New**:
```typescript
async initializeWorkspace(workspaceId: string): Promise<WorkspaceChatState> {
    let workspaceState = this.storage.get(workspaceId);

    if (!workspaceState) {
        // TRY TO LOAD FROM DISK FIRST
        workspaceState = await this.fileStorage.loadWorkspace(workspaceId);

        if (!workspaceState) {
            // Create default thread if not found on disk
            // ... existing creation logic ...
        }

        this.storage.set(workspaceId, workspaceState);
        console.log(`[ChatStateStorage] Initialized workspace: ${workspaceId} (loaded from disk: ${!!workspaceState})`);
    }

    return workspaceState;
}
```

**⚠️ BREAKING CHANGE**: This method signature changes from synchronous to async!

#### 2.3: Add Auto-Save After State Mutations

Add private save method:
```typescript
private async saveWorkspace(workspaceId: string, immediate: boolean = false): Promise<void> {
    const state = this.storage.get(workspaceId);
    if (state) {
        await this.fileStorage.saveWorkspace(state, immediate);
    }
}
```

Modify these methods to trigger saves:

**Lines to modify**:
- `addGeneration()` (line 196-236) → Add save at line 235
- `updateGeneration()` (line 276-295) → Add save at line 294
- `updateReviewState()` (line 386-404) → Add save at line 403
- `acceptAllReviews()` (line 412-425) → Add save at line 424
- `declineAllReviews()` (line 433-447) → Add save at line 446
- `addCheckpointToGeneration()` (line 502-523) → Add save at line 522
- `restoreThreadToCheckpoint()` (line 573-601) → Add save at line 600

**Pattern**:
```typescript
// At end of each method, add:
await this.saveWorkspace(workspaceId).catch(error => {
    console.error('[ChatStateStorage] Failed to save:', error);
});
```

#### 2.4: Checkpoint Persistence Configuration

Add checkpoint persistence flag:
```typescript
export class ChatStateStorage {
    private persistCheckpoints: boolean = false; // Default OFF (user decision)

    setPersistCheckpoints(enabled: boolean): void {
        this.persistCheckpoints = enabled;
    }
}
```

Modify serialization in JsonFileStorage to conditionally exclude checkpoints:
```typescript
private serializeWorkspace(state: WorkspaceChatState): SerializableWorkspace {
    return {
        workspaceId: state.workspaceId,
        threads: Array.from(state.threads.entries()).map(([id, thread]) => [
            id,
            {
                ...thread,
                generations: thread.generations.map(gen => ({
                    ...gen,
                    // Exclude checkpoint if not persisting
                    checkpoint: this.persistCheckpoints ? gen.checkpoint : undefined
                }))
            }
        ]),
        activeThreadId: state.activeThreadId,
        savedAt: Date.now(),
        version: '1.0'
    };
}
```

---

### Task 3: Update Call Sites (Async Migration)

Since `initializeWorkspace()` becomes async, update all call sites:

**Files to update**:

1. **chatStateStorage.ts** (internal methods):
   - `getOrCreateThread()` (line 151) → Make async, await initializeWorkspace
   - `getActiveThread()` (line 176) → Make async
   - All methods calling `getOrCreateThread()` → Make async

2. **rpc-managers/ai-panel/rpc-manager.ts**:
   - Any direct calls to chatStateStorage methods → Add await
   - Lines: 259, 407, 433, 455, 470, 510, 539, 548, 561, 570, 602, 619, 623

3. **features/ai/agent/AgentExecutor.ts**:
   - Lines: 198, 203, 206, 288, 292, 339, 351, 362

4. **features/ai/agent/index.ts**:
   - Line: 76

5. **features/ai/executors/base/AICommandExecutor.ts**:
   - Lines: 149-152

**Pattern for updates**:
```typescript
// Before
const thread = chatStateStorage.getOrCreateThread(workspaceId, threadId);

// After
const thread = await chatStateStorage.getOrCreateThread(workspaceId, threadId);
```

---

### Task 4: Add Extension Deactivation Hook
**File**: `workspaces/ballerina/ballerina-extension/src/extension.ts` (MODIFY)

**Current deactivate() function (lines 270-278)**:
```typescript
export function deactivate(): Thenable<void> | undefined {
    debug('Deactive the Ballerina VS Code extension.');

    if (!langClient) {
        return;
    }
    extension.ballerinaExtInstance.telemetryReporter.dispose();
    return langClient.stop();
}
```

**Modified**:
```typescript
export async function deactivate(): Promise<void> {
    debug('Deactivate the Ballerina VS Code extension.');

    // FLUSH PENDING SAVES BEFORE DEACTIVATION
    try {
        await flushPendingSaves();
    } catch (error) {
        console.error('[Extension] Failed to flush pending saves on deactivation:', error);
    }

    if (!langClient) {
        return;
    }
    extension.ballerinaExtInstance.telemetryReporter.dispose();
    await langClient.stop();
}

async function flushPendingSaves(): Promise<void> {
    const { chatStateStorage } = await import('./views/ai-panel/chatStateStorage');
    const workspaceIds = chatStateStorage.getAllWorkspaceIds();

    const savePromises = workspaceIds.map(id =>
        chatStateStorage.saveWorkspace(id, true) // immediate = true
    );

    await Promise.all(savePromises);
    console.log('[Extension] Flushed all pending chat state saves');
}
```

Add method to ChatStateStorage:
```typescript
getAllWorkspaceIds(): string[] {
    return Array.from(this.storage.keys());
}

async saveWorkspace(workspaceId: string, immediate: boolean = false): Promise<void> {
    const state = this.storage.get(workspaceId);
    if (state) {
        await this.fileStorage.saveWorkspace(state, immediate);
    }
}
```

---

### Task 5: Git Integration
**File**: `workspaces/ballerina/ballerina-extension/src/views/ai-panel/jsonFileStorage.ts`

**Add to JsonFileStorage constructor or initialization**:
```typescript
private async ensureGitExclude(): Promise<void> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        const gitInfoExcludePath = path.join(
            workspaceFolder.uri.fsPath,
            '.git',
            'info',
            'exclude'
        );

        // Check if .git exists
        if (!fs.existsSync(path.dirname(gitInfoExcludePath))) {
            return; // Not a git repo
        }

        // Read existing exclude file
        let excludeContent = '';
        if (fs.existsSync(gitInfoExcludePath)) {
            excludeContent = await fs.promises.readFile(gitInfoExcludePath, 'utf-8');
        }

        // Add our entry if not present
        const excludePattern = '.ballerina/copilot-memory/';
        if (!excludeContent.includes(excludePattern)) {
            excludeContent += `\n# Ballerina Copilot chat history (session data)\n${excludePattern}\n`;
            await fs.promises.writeFile(gitInfoExcludePath, excludeContent);
            console.log('[JsonFileStorage] Added copilot-memory to git exclude');
        }
    } catch (error) {
        console.error('[JsonFileStorage] Failed to update git exclude:', error);
        // Non-critical, don't throw
    }
}
```

**Call during initialization**:
```typescript
async saveWorkspace(state: WorkspaceChatState, immediate: boolean = false): Promise<void> {
    // Ensure git exclude on first save
    await this.ensureGitExclude();

    // ... rest of save logic
}
```

---

## Critical Files to Modify

### New Files (Create)
1. `workspaces/ballerina/ballerina-extension/src/views/ai-panel/jsonFileStorage.ts`

### Modified Files
1. `workspaces/ballerina/ballerina-extension/src/views/ai-panel/chatStateStorage.ts`
   - Add fileStorage instance
   - Make initializeWorkspace() async
   - Add saveWorkspace() calls after mutations
   - Add checkpoint persistence configuration

2. `workspaces/ballerina/ballerina-extension/src/extension.ts`
   - Modify deactivate() to flush pending saves
   - Add flushPendingSaves() helper function

3. `workspaces/ballerina/ballerina-extension/src/rpc-managers/ai-panel/rpc-manager.ts`
   - Add await to async chatStateStorage calls

4. `workspaces/ballerina/ballerina-extension/src/features/ai/agent/AgentExecutor.ts`
   - Add await to async chatStateStorage calls

5. `workspaces/ballerina/ballerina-extension/src/features/ai/agent/index.ts`
   - Add await to async chatStateStorage calls

6. `workspaces/ballerina/ballerina-extension/src/features/ai/executors/base/AICommandExecutor.ts`
   - Add await to async chatStateStorage calls

---

## Type Definitions Needed

### SerializableWorkspace Interface
```typescript
interface SerializableWorkspace {
    workspaceId: string;
    threads: Array<[string, SerializableChatThread]>;
    activeThreadId: string;
    savedAt: number;
    version: string;
}

interface SerializableChatThread {
    id: string;
    name: string;
    generations: Generation[];
    sessionId?: string;
    createdAt: number;
    updatedAt: number;
}
```

**Note**: Generation already has all serializable types, but modelMessages (any[]) needs careful handling to filter out functions/symbols.

---

## Testing Strategy

### Manual Testing Checklist
1. **Basic Persistence**:
   - [ ] Start VS Code, open Ballerina workspace
   - [ ] Send message to copilot
   - [ ] Close VS Code
   - [ ] Reopen VS Code
   - [ ] Verify chat history restored

2. **Multi-Thread Persistence**:
   - [ ] Create multiple threads (when feature available)
   - [ ] Send messages to different threads
   - [ ] Close and reopen VS Code
   - [ ] Verify all threads restored with correct activeThreadId

3. **Debouncing**:
   - [ ] Send multiple messages rapidly (< 1.5 seconds apart)
   - [ ] Verify only one file write occurs after last message
   - [ ] Check console logs for debounce activity

4. **Corruption Handling**:
   - [ ] Manually corrupt the JSON file (invalid JSON)
   - [ ] Restart VS Code
   - [ ] Verify backup file created (.backup.{timestamp})
   - [ ] Verify new clean state created
   - [ ] Verify user notification shown

5. **Size Warning**:
   - [ ] Create large chat history (> 5MB)
   - [ ] Verify warning notification shown
   - [ ] Test suggested actions (clear/archive)

6. **Git Exclusion**:
   - [ ] In git repo, send message to copilot
   - [ ] Verify `.git/info/exclude` contains `.ballerina/copilot-memory/`
   - [ ] Verify `git status` doesn't show memory files

7. **Deactivation Flush**:
   - [ ] Send message
   - [ ] Immediately close VS Code (< 1.5 seconds)
   - [ ] Reopen VS Code
   - [ ] Verify last message persisted (immediate save on deactivation)

8. **Review State Persistence**:
   - [ ] Generate code that requires review
   - [ ] Close VS Code during review
   - [ ] Reopen VS Code
   - [ ] Verify review state preserved (under_review status, modifiedFiles, tempProjectPath)

9. **Checkpoint Persistence** (when enabled):
   - [ ] Enable checkpoint persistence
   - [ ] Generate code with checkpoints
   - [ ] Close and reopen VS Code
   - [ ] Verify checkpoints restored
   - [ ] Test undo/restore functionality

---

## Error Handling

### Scenarios to Handle
1. **File write permission denied** → Log error, show notification, continue in-memory only
2. **Disk full** → Log error, show notification, continue in-memory only
3. **Invalid JSON on load** → Create backup, start fresh, notify user
4. **Directory creation fails** → Log error, continue in-memory only
5. **Git exclude update fails** → Log warning, continue (non-critical)

### Error Notification Pattern
```typescript
vscode.window.showWarningMessage(
    'Failed to persist chat history to disk. Your conversations will be lost on restart.',
    'View Logs'
).then(selection => {
    if (selection === 'View Logs') {
        vscode.commands.executeCommand('workbench.action.toggleDevTools');
    }
});
```

---

## Performance Considerations

### Memory Impact
- **Current**: In-memory Map only (~1-5 MB per workspace)
- **New**: In-memory Map + debounced writes (no additional memory, just I/O)

### Disk I/O
- **Without debouncing**: 10-20 writes per conversation (heavy)
- **With debouncing (1.5s)**: 1-2 writes per conversation (80-90% reduction)

### Startup Time
- **Current**: Instant (no loading)
- **New**: +50-200ms per workspace (one async file read)
- **Mitigation**: Load happens lazily on first access, not at extension activation

---

## Migration Path

### Version 1.0 (This Implementation)
- Basic persistence with debouncing
- Corruption handling with backups
- Size warnings at 5MB
- Checkpoint persistence configurable (default OFF)

### Future Enhancements (Not in Scope)
- Conversation summarization (compress old generations)
- Applied code tracking (extend reviewState)
- Prompt caching integration
- Export/import functionality
- Compression (gzip) for large files
- Automatic archiving of old threads

---

## User-Facing Changes

### Positive Changes
✅ Chat history persists across VS Code restarts
✅ No data loss on crashes
✅ Undo history preserved (if checkpoints enabled)
✅ Review state preserved during restarts

### Potential Issues
⚠️ Disk space usage (~1-10 MB per project)
⚠️ Slight startup delay (50-200ms) on first chat access
⚠️ Warning notifications for large files (> 5MB)

### User Actions
- Can manually delete `.ballerina/copilot-memory/` to clear history
- Can configure checkpoint persistence via settings (future)
- Can export/archive threads (future enhancement)

---

## Implementation Order

1. **Week 1, Days 1-2**: Create JsonFileStorage with serialization/deserialization
2. **Week 1, Days 3-4**: Integrate into ChatStateStorage, add debouncing
3. **Week 1, Day 5**: Add corruption handling and size warnings
4. **Week 2, Days 1-2**: Update all call sites (async migration)
5. **Week 2, Days 3-4**: Add deactivation flush and git exclusion
6. **Week 2, Day 5**: Testing and bug fixes

---

## Success Criteria

✅ 0% data loss on VS Code restart (down from 100%)
✅ All chat history, threads, and review states persist
✅ Debouncing reduces disk writes by 80-90%
✅ Corrupted files handled gracefully with backups
✅ User notified at 5MB file size
✅ `.ballerina/copilot-memory/` excluded from git
✅ No regression in existing functionality
✅ Manual testing checklist 100% passed

---

## Dependencies

**NPM Packages** (already in package.json):
- `fs/promises` - Native Node.js
- `path` - Native Node.js
- `crypto` - Native Node.js (for hashing)

**VS Code APIs**:
- `vscode.workspace.workspaceFolders`
- `vscode.window.showWarningMessage`
- File system operations

**Internal Dependencies**:
- `@wso2/ballerina-core` - Type definitions (WorkspaceChatState, ChatThread, Generation)
- `chatStateStorage` singleton - Main integration point

---

## Timeline Estimate

**Total**: 7-10 working days

| Task | Time | Risk |
|------|------|------|
| Create JsonFileStorage | 2 days | Low |
| Integrate into ChatStateStorage | 2 days | Medium |
| Update call sites (async) | 1.5 days | Medium |
| Deactivation + Git | 1 day | Low |
| Testing + Bug Fixes | 2-3 days | Medium |

**Risk Factors**:
- Async migration might reveal unexpected synchronous dependencies
- Testing across different workspace scenarios
- Edge cases in serialization (especially modelMessages any[] type)
