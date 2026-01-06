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

import { AIChatMachineContext } from '@wso2/ballerina-core/lib/state-machine-types';
import { generateProjectId } from './idGenerators';
import { sessionStorage } from './chatStateStorage'; // Keep for in-memory cache
import { jsonFileStorage } from './jsonFileStorage'; // NEW

/**
 * Saves the chat state for the current project (session-only storage)
 * @param context The chat machine context
 * @param immediate If true, bypasses debouncing and saves immediately
 */
export const saveChatState = async (context: AIChatMachineContext, immediate: boolean = false): Promise<void> => {
    try {
        if (!context.projectId) {
            console.warn("No project ID available, skipping state save");
            return;
        }

        // 1. Save to session storage (fast, in-memory)
        sessionStorage.save(context.projectId, context);

        // 2. Save to file
        await jsonFileStorage.save(context.projectId, context, immediate);
        
        console.log(`✅ ${immediate ? 'Immediately saved' : 'Saved'} chat state for project: ${context.projectId}`);
    } catch (error) {
        console.error("Failed to save chat state:", error);
    }
};

/**
 * Clears the chat state for a specific project (action version for state machine)
 * @param context The chat machine context
 */
export const clearChatStateAction = (context: AIChatMachineContext): void => {
    try {
        if (!context.projectId) {
            console.warn('No project ID available, skipping state clear');
            return;
        }

        sessionStorage.clear(context.projectId);
        console.log(`Cleared chat state for project: ${context.projectId}`);
    } catch (error) {
        console.error('Failed to clear chat state:', error);
    }
};

/**
 * Loads the chat state for the current project (from session storage)
 * @param projectId Optional project ID. If not provided, uses current workspace
 * @returns The saved chat state or undefined
 */
export const loadChatState = async (projectId?: string): Promise<AIChatMachineContext | undefined> => {
    try {
        const targetProjectId = projectId || generateProjectId();

        // 1. Try loading from file first (persistent)
        const fileData = await jsonFileStorage.load(targetProjectId);
        if (fileData) {
            console.log(`✅ Loaded from file: ${targetProjectId}`);
            // Also load into session storage for fast access
            sessionStorage.save(targetProjectId, fileData as any);
            return fileData as unknown as AIChatMachineContext;
        }

        // 2. Fallback to session storage (current session only)
        const sessionData = sessionStorage.load(targetProjectId);
        if (sessionData) {
            console.log(`✅ Loaded from session: ${targetProjectId}`);
            return sessionData as unknown as AIChatMachineContext;
        }

        console.log(`No saved state for project: ${targetProjectId}`);
        return undefined;
    } catch (error) {
        console.error('Failed to load chat state:', error);
        return undefined;
    }
};

/**
 * Clears the chat state for a specific project or current project
 * @param projectId Optional project ID. If not provided, uses current workspace
 */
export const clearChatState = async (projectId?: string): Promise<void> => {
    try {
        const targetProjectId = projectId || generateProjectId();
        
        // Clear both session and file
        sessionStorage.clear(targetProjectId);
        await jsonFileStorage.clear(targetProjectId);
        
        console.log(`✅ Cleared chat state for project: ${targetProjectId}`);
    } catch (error) {
        console.error('Failed to clear chat state:', error);
    }
};

/**
 * Gets all project IDs that have saved chat states (from session storage)
 * @returns Array of project IDs
 */
export const getAllProjectIds = async (): Promise<string[]> => {
    try {
        return sessionStorage.getAllProjectIds();
    } catch (error) {
        console.error('Failed to get project IDs:', error);
        return [];
    }
};

/**
 * Clears all chat states for all projects (from session storage)
 */
export const clearAllChatStates = async (): Promise<void> => {
    try {
        const projectIds = await getAllProjectIds();
        console.log(`Clearing chat states for ${projectIds.length} project(s): ${projectIds.join(', ')}`);

        sessionStorage.clearAll();
        console.log('Cleared all chat states');
    } catch (error) {
        console.error('Failed to clear all chat states:', error);
    }
};

/**
 * Gets metadata about saved chat states (from session storage)
 * @returns Array of project metadata
 */
export const getChatStateMetadata = async (): Promise<Array<{
    projectId: string;
    workspacePath?: string;
    savedAt?: number;
    sessionId?: string;
    taskCount?: number;
}>> => {
    try {
        const projectIds = sessionStorage.getAllProjectIds();
        const metadata = [];

        for (const projectId of projectIds) {
            const state = sessionStorage.load(projectId);
            if (state) {
                metadata.push({
                    projectId,
                    savedAt: state.savedAt,
                    sessionId: state.sessionId,
                    taskCount: state.currentPlan?.tasks.length || 0,
                });
            }
        }

        return metadata;
    } catch (error) {
        console.error('Failed to get chat state metadata:', error);
        return [];
    }
};
