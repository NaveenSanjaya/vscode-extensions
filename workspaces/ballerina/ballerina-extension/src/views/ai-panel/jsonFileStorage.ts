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

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { AIChatMachineContext, ChatMessage, Checkpoint } from '@wso2/ballerina-core/lib/state-machine-types';

interface ChatStateFile {
    chatHistory: ChatMessage[];
    currentPlan?: any;
    currentTaskIndex: number;
    sessionId?: string;
    projectId: string;
    checkpoints: Checkpoint[];
    savedAt: number;
}

class JsonFileStorage {
    private storageDir: string | null = null;
    private saveTimers: Map<string, NodeJS.Timeout> = new Map();
    private saveLocks: Set<string> = new Set();
    private pendingSaves: Map<string, AIChatMachineContext> = new Map(); // Queue latest context while save in progress
    private gitExcludeUpdated = false;
    private readonly SAVE_DEBOUNCE_MS = 1000; // Wait 1 second before saving
    private readonly MAX_FILE_SIZE_MB = 5; // Warn if file exceeds 5MB

    /**
     * Get storage directory: workspace/.ballerina/copilot-memory/
     */
    private getStorageDir(): string | null {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace) { return null; }

        const dir = path.join(workspace.uri.fsPath, '.ballerina', 'copilot-memory');
        return dir;
    }

    /**
     * Ensure directory exists
     */
    private async ensureDir(dir: string): Promise<void> {
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (error) {
            console.error('Failed to create directory:', error);
        }
    }

    // /**
    //  * Ensure .gitignore exists in .ballerina directory to prevent chat files from being committed
    //  */
    // private async ensureGitignore(ballerinaDir: string): Promise<void> {
    //     try {
    //         const gitignorePath = path.join(ballerinaDir, '.gitignore');
    //         const ignoreEntry = 'copilot-memory/';
    //         
    //         // Check if .gitignore exists
    //         let existingContent = '';
    //         try {
    //             existingContent = await fs.readFile(gitignorePath, 'utf-8');
    //         } catch {
    //             // File doesn't exist, will create it
    //         }

    //         // Check if entry already exists
    //         if (!existingContent.includes(ignoreEntry)) {
    //             const newContent = existingContent 
    //                 ? `${existingContent.trimEnd()}\n\n# Copilot memory files (user-specific)\n${ignoreEntry}\n`
    //                 : `# Copilot memory files (user-specific)\n${ignoreEntry}\n`;
    //             
    //             await fs.writeFile(gitignorePath, newContent, 'utf-8');
    //             console.log(`✅ Created/updated .gitignore in .ballerina directory`);
    //         }
    //     } catch (error) {
    //         console.error('Failed to ensure .gitignore:', error);
    //     }
    // }

    /**
     * Ensure .git/info/exclude contains pattern to prevent chat files from being committed
     */
    private async ensureGitExclude(): Promise<void> {
        try {
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (!workspace) { return; }

            const excludePath = path.join(workspace.uri.fsPath, '.git', 'info', 'exclude');
            const ignorePattern = '.ballerina/copilot-memory/';
            
            // Check if .git/info/exclude exists
            let existingContent = '';
            try {
                existingContent = await fs.readFile(excludePath, 'utf-8');
            } catch {
                // .git might not exist yet or exclude file missing
                console.log('No .git/info/exclude found (repo might not be initialized)');
                return;
            }

            // Check if entry already exists
            if (!existingContent.includes(ignorePattern)) {
                const newContent = `${existingContent.trimEnd()}\n\n# Copilot memory files (user-specific)\n${ignorePattern}\n`;
                
                await fs.writeFile(excludePath, newContent, 'utf-8');
                console.log(`✅ Updated .git/info/exclude with copilot-memory pattern`);
            }
        } catch (error) {
            console.error('Failed to update .git/info/exclude:', error);
        }
    }

    /**
     * Get file path for project
     */
    private getFilePath(projectId: string): string | null {
        const dir = this.getStorageDir();
        if (!dir) { return null; }
        return path.join(dir, `chat-${projectId}.json`);
    }

    /**
     * Save chat state to JSON file (ASYNC - non-blocking, with optional debouncing)
     * @param skipDebounce - If true, saves immediately without debouncing
     */
    async save(projectId: string, context: AIChatMachineContext, skipDebounce: boolean = false): Promise<void> {
        console.log(`[JsonFileStorage] save() called, skipDebounce=${skipDebounce}, projectId=${projectId}`);
        
        // If skipDebounce is true, save immediately
        if (skipDebounce) {
            console.log(`[JsonFileStorage] Saving immediately (skipDebounce=true)`);
            await this.saveImmediate(projectId, context);
            return;
        }

        // Clear existing timer for this project
        const existingTimer = this.saveTimers.get(projectId);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Debounce: only save after 1 second of no new saves
        const timer = setTimeout(async () => {
            await this.saveImmediate(projectId, context);
            this.saveTimers.delete(projectId);
        }, this.SAVE_DEBOUNCE_MS);

        this.saveTimers.set(projectId, timer);
    }

    /**
     * Save immediately (internal method called after debounce)
     */
    private async saveImmediate(projectId: string, context: AIChatMachineContext): Promise<void> {
        // If save already in progress, queue this context for saving after current completes
        if (this.saveLocks.has(projectId)) {
            console.log(`[JsonFileStorage] Save in progress for ${projectId}, queuing latest context...`);
            this.pendingSaves.set(projectId, context);
            return;
        }

        this.saveLocks.add(projectId);
        try {
            const dir = this.getStorageDir();
            if (!dir) {
                console.warn('No workspace folder, cannot save');
                return;
            }

            await this.ensureDir(dir);

            // Ensure .git/info/exclude contains pattern (only once per session)
            if (!this.gitExcludeUpdated) {
                await this.ensureGitExclude();
                this.gitExcludeUpdated = true;
            }

            const filePath = this.getFilePath(projectId);
            if (!filePath) { return; }

            const data: ChatStateFile = {
                chatHistory: context.chatHistory,
                currentPlan: context.currentPlan,
                currentTaskIndex: context.currentTaskIndex,
                sessionId: context.sessionId,
                projectId: context.projectId || projectId,
                checkpoints: context.checkpoints || [],
                savedAt: Date.now(),
            };

            // Serialize and check size
            const jsonString = JSON.stringify(data, null, 2);
            const sizeMB = Buffer.byteLength(jsonString) / (1024 * 1024);

            if (sizeMB > this.MAX_FILE_SIZE_MB) {
                console.warn(`⚠️ Chat state file is large: ${sizeMB.toFixed(2)}MB (project: ${projectId})`);
            }

            // Write asynchronously (non-blocking!)
            await fs.writeFile(filePath, jsonString, 'utf-8');

            console.log(`✅ Saved chat state to: ${filePath} (${sizeMB.toFixed(2)}MB)`);
        } catch (error) {
            console.error('Failed to save chat state to file:', error);
        } finally {
            this.saveLocks.delete(projectId);
            
            // Check if there's a pending save with newer context
            const pendingContext = this.pendingSaves.get(projectId);
            if (pendingContext) {
                console.log(`[JsonFileStorage] Processing queued save for ${projectId}`);
                this.pendingSaves.delete(projectId);
                // Save the pending context (recursive call)
                await this.saveImmediate(projectId, pendingContext);
            }
        }
    }

    /**
     * Load chat state from JSON file (FAST, with corrupted file handling)
     */
    async load(projectId: string): Promise<ChatStateFile | null> {
        try {
            const filePath = this.getFilePath(projectId);
            if (!filePath) { return null; }

            // Check if file exists
            try {
                await fs.access(filePath);
            } catch {
                console.log(`No saved state file for project: ${projectId}`);
                return null;
            }

            // Read and parse file
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(content) as ChatStateFile;

            // Validate structure
            if (!data.chatHistory || !Array.isArray(data.chatHistory)) {
                throw new Error('Invalid chat state structure: missing or invalid chatHistory');
            }

            if (!data.projectId || typeof data.projectId !== 'string') {
                throw new Error('Invalid chat state structure: missing or invalid projectId');
            }

            console.log(`✅ Loaded chat state from: ${filePath}`);
            return data;
        } catch (error) {
            console.error('Failed to load chat state from file:', error);

            // If file is corrupted, rename it and return null
            const filePath = this.getFilePath(projectId);
            if (filePath) {
                try {
                    const backupPath = `${filePath}.corrupted-${Date.now()}`;
                    await fs.rename(filePath, backupPath);
                    console.log(`⚠️ Backed up corrupted file to: ${backupPath}`);
                } catch (renameError) {
                    console.error('Failed to backup corrupted file:', renameError);
                }
            }

            return null;
        }
    }

    /**
     * Force immediate save (bypass debouncing) - useful for cleanup/shutdown
     */
    async forceSave(projectId: string, context: AIChatMachineContext): Promise<void> {
        // Clear any pending debounced save
        const existingTimer = this.saveTimers.get(projectId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.saveTimers.delete(projectId);
        }

        // Save immediately
        await this.saveImmediate(projectId, context);
    }

    /**
     * Clear chat state file
     */
    async clear(projectId: string): Promise<void> {
        try {
            const filePath = this.getFilePath(projectId);
            if (!filePath) { return; }

            await fs.unlink(filePath);
            console.log(`✅ Cleared chat state file: ${filePath}`);
        } catch (error) {
            if ((error as any).code !== 'ENOENT') {
                console.error('Failed to clear chat state file:', error);
            }
        }
    }

    /**
     * List all saved projects
     */
    async getAllProjectIds(): Promise<string[]> {
        try {
            const dir = this.getStorageDir();
            if (!dir) { return []; }

            const files = await fs.readdir(dir);
            return files
                .filter(f => f.startsWith('chat-') && f.endsWith('.json'))
                .map(f => f.replace('chat-', '').replace('.json', ''));
        } catch (error) {
            return [];
        }
    }
}

// Singleton instance
export const jsonFileStorage = new JsonFileStorage();

/**
 * Ensure all pending saves complete before window closes
 * Call this during extension deactivation
 */
export async function flushPendingSaves(): Promise<void> {
    const timers = Array.from(jsonFileStorage['saveTimers'].entries());

    if (timers.length === 0) {
        return; // No pending saves
    }

    console.log(`⏳ Flushing ${timers.length} pending save(s)...`);

    // Clear all timers
    for (const [, timer] of timers) {
        clearTimeout(timer);
    }
    jsonFileStorage['saveTimers'].clear();

    console.log('✅ All pending saves cleared (saves will complete on next message or close)');
}