/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceChatState, ChatThread, Generation } from '@wso2/ballerina-core/lib/state-machine-types';

/**
 * Interface for serializable workspace state
 * Maps are converted to arrays for JSON storage
 */
interface SerializableWorkspace {
    workspaceId: string;
    threads: Array<[string, ChatThread]>;
    activeThreadId: string;
    savedAt: number;
    version: string;
}

/**
 * Handles persistence of chat state to JSON files
 * Features:
 * - Debounced writes (1.5s)
 * - Automatic backup on corruption
 * - Size warnings (>5MB)
 * - Git ignore management
 */
export class JsonFileStorage {
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly STORAGE_DIR = '.ballerina/copilot-memory';
    private readonly DEBOUNCE_MS = 1500;
    private readonly MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
    private gitExcludeChecked = false;

    /**
     * Save workspace state to disk
     * @param state The workspace state to save
     * @param immediate If true, skips debouncing (e.g., on deactivation)
     */
    async saveWorkspace(state: WorkspaceChatState, immediate: boolean = false): Promise<void> {
        // Ensure .ballerina/copilot-memory is in .git/info/exclude
        if (!this.gitExcludeChecked) {
            await this.ensureGitExclude();
            this.gitExcludeChecked = true;
        }

        if (immediate) {
            if (this.debounceTimers.has(state.workspaceId)) {
                clearTimeout(this.debounceTimers.get(state.workspaceId)!);
                this.debounceTimers.delete(state.workspaceId);
            }
            await this.performSave(state);
        } else {
            if (this.debounceTimers.has(state.workspaceId)) {
                clearTimeout(this.debounceTimers.get(state.workspaceId)!);
            }

            const timer = setTimeout(async () => {
                this.debounceTimers.delete(state.workspaceId);
                await this.performSave(state);
            }, this.DEBOUNCE_MS);

            this.debounceTimers.set(state.workspaceId, timer);
        }
    }

    /**
     * Load workspace state from disk
     * @param workspaceId Workspace identifier
     * @returns Workspace state or null if not found/error
     */
    async loadWorkspace(workspaceId: string): Promise<WorkspaceChatState | null> {
        const filePath = this.getFilePath(workspaceId);

        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const data: SerializableWorkspace = JSON.parse(content);
            return this.deserializeWorkspace(data);
        } catch (error) {
            console.error(`[JsonFileStorage] Failed to load workspace ${workspaceId}:`, error);
            await this.handleCorruption(filePath, workspaceId);
            return null;
        }
    }

    /**
     * Perform the actual file write
     */
    private async performSave(state: WorkspaceChatState): Promise<void> {
        try {
            const filePath = this.getFilePath(state.workspaceId);
            const dirPath = path.dirname(filePath);

            if (!fs.existsSync(dirPath)) {
                await fs.promises.mkdir(dirPath, { recursive: true });
            }

            const serializable = this.serializeWorkspace(state);
            const content = JSON.stringify(serializable, null, 2);

            await fs.promises.writeFile(filePath, content, 'utf-8');
            console.log(`[JsonFileStorage] Saved workspace: ${state.workspaceId}`);

            // Check size after save
            this.checkSize(filePath);

        } catch (error) {
            console.error(`[JsonFileStorage] Failed to save workspace ${state.workspaceId}:`, error);
        }
    }

    /**
     * Handle corrupted JSON file
     */
    private async handleCorruption(filePath: string, workspaceId: string): Promise<void> {
        try {
            const backupPath = `${filePath}.backup.${Date.now()}`;
            await fs.promises.rename(filePath, backupPath);

            vscode.window.showWarningMessage(
                `Ballerina Copilot: Chat history for workspace '${workspaceId}' was corrupted and has been backed up. A new history will be started.`,
                'View Logs'
            ).then(selection => {
                if (selection === 'View Logs') {
                    vscode.commands.executeCommand('workbench.action.toggleDevTools');
                }
            });

            console.warn(`[JsonFileStorage] Corrupted file backed up to: ${backupPath}`);
        } catch (error) {
            console.error('[JsonFileStorage] Failed to handle corruption:', error);
        }
    }

    /**
     * Check file size and warn if too large
     */
    private async checkSize(filePath: string): Promise<void> {
        try {
            const stats = await fs.promises.stat(filePath);
            if (stats.size > this.MAX_FILE_SIZE_BYTES) {
                // Throttle warnings? For now just log, maybe warn once per session
                // We could use a static set to track warned files
                if (!JsonFileStorage.warnedFiles.has(filePath)) {
                    vscode.window.showWarningMessage(
                        'Ballerina Copilot: Your chat history is getting large (>5MB). Consider clearing old conversations.'
                    );
                    JsonFileStorage.warnedFiles.add(filePath);
                }
            }
        } catch (error) {
            // Ignore stat errors
        }
    }
    private static warnedFiles: Set<string> = new Set();


    /**
     * Ensure storage directory is excluded from git
     */
    private async ensureGitExclude(): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) { return; }

            // We handle the primary workspace for now, or loop through all?
            // Usually the storage writes to the specific workspace folder.
            // But here we are writing inside the workspace folder.
            // Let's assume the first one involves the .git or we check closest .git

             // Note: In a multi-root workspace, we might need more logic.
             // But usually vscode.workspace.workspaceFolders[0] is the main one.
             // Or we should derive it from the workspaceId if it maps to a path.
             // BUT: chatStateStorage workspaceId is usually a uuid or folder path hash.
             // We'll stick to the first workspace folder for the .git check for simplicity,
             // or check current workspace root if available.

            const rootPath = workspaceFolders[0].uri.fsPath;
            const gitInfoExcludePath = path.join(rootPath, '.git', 'info', 'exclude');

            // Check if .git/info exists (is a git repo)
            const gitInfoDir = path.dirname(gitInfoExcludePath);
            if (!fs.existsSync(gitInfoDir)) {
                return;
            }

            let excludeContent = '';
            if (fs.existsSync(gitInfoExcludePath)) {
                excludeContent = await fs.promises.readFile(gitInfoExcludePath, 'utf-8');
            }

            const excludePattern = '.ballerina/copilot-memory/';
            if (!excludeContent.includes(excludePattern)) {
                excludeContent += `\n# Ballerina Copilot chat history\n${excludePattern}\n`;
                await fs.promises.writeFile(gitInfoExcludePath, excludeContent, 'utf-8');
                console.log('[JsonFileStorage] Added copilot-memory to .git/info/exclude');
            }

        } catch (error) {
            console.error('[JsonFileStorage] Failed to update git exclude:', error);
        }
    }

    /**
     * Get file path for workspace storage
     */
    private getFilePath(workspaceId: string): string {
        // We need a place to store this.
        // Option 1: Store in the global extension storage path (better for persistence across workspace moves, but hard to map).
        // Option 2: Store inside the workspace folder itself (e.g. .ballerina/copilot-memory).
        // The plan specified: .ballerina/copilot-memory/workspace-{workspaceId}.json
        // But relative to WHERE?
        // If workspaceId corresponds to an actual workspace folder, use that.
        // If not, we have to default to the FIRST workspace folder or a known location.

        // Assuming we write to the FIRST workspace folder for now as a safe default if we can't map workspaceId back to path easily.
        // However, usually workspaceId in this extension is tied to the folder.
        // For Ballerina extension, let's look at how workspaceId is generated. 
        // If strictly following the plan: Use first workspace root.

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const rootPath = workspaceFolders ? workspaceFolders[0].uri.fsPath : process.cwd(); // Fallback
        
        return path.join(rootPath, this.STORAGE_DIR, `workspace-${workspaceId}.json`);
    }

    private serializeWorkspace(state: WorkspaceChatState): SerializableWorkspace {
        return {
            workspaceId: state.workspaceId,
            threads: Array.from(state.threads.entries()),
            activeThreadId: state.activeThreadId,
            savedAt: Date.now(),
            version: '1.0'
        };
    }

    private deserializeWorkspace(data: SerializableWorkspace): WorkspaceChatState {
        return {
            workspaceId: data.workspaceId,
            threads: new Map(data.threads),
            activeThreadId: data.activeThreadId
        };
    }
}
