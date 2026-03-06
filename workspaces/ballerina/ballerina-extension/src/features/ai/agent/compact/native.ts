// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import { COMPACTION_PROMPT } from './prompt';

/**
 * Native compaction implementation using Claude's built-in compaction feature.
 * Uses the AI SDK's providerOptions.anthropic.contextManagement API.
 *
 * Benefits:
 * - No separate API call needed
 * - Seamless integration with streaming
 * - Official, supported feature
 */

/**
 * Configuration for native compaction
 */
export interface NativeCompactionConfig {
    /**
     * Token threshold to trigger compaction.
     * Minimum: 50000 (50k tokens)
     */
    trigger?: number;

    /**
     * Whether to pause after generating the compaction summary.
     * Default: false
     */
    pauseAfterCompaction?: boolean;

    /**
     * Custom summarization instructions.
     */
    instructions?: string;
}

/**
 * Creates the contextManagement configuration for native compaction.
 * This is passed to streamText via providerOptions.anthropic.contextManagement
 */
export function createNativeCompactionConfig(config?: NativeCompactionConfig) {
    const trigger = config?.trigger ?? 150000;

    // Minimum 50k tokens
    const validTrigger = Math.max(trigger, 50000);
    if (trigger < 50000) {
        console.warn(`[NativeCompaction] Trigger ${trigger} is below minimum 50k, using 50k`);
    }

    return {
        edits: [
            {
                type: 'compact_20260112',
                trigger: {
                    type: 'input_tokens',
                    value: validTrigger
                },
                pauseAfterCompaction: config?.pauseAfterCompaction ?? false,
                ...(config?.instructions && { instructions: config.instructions })
            }
        ]
    };
}

/**
 * Default compaction instructions
 */
export const NATIVE_COMPACTION_INSTRUCTIONS = `You are summarizing a Ballerina AI coding assistant conversation.

Create a detailed summary that preserves ALL important details so the conversation can continue seamlessly.
${COMPACTION_PROMPT}`;

/**
 * Checks if a stream part is a compaction summary (text-start event)
 */
export function isCompactionPart(part: any): boolean {
    return part?.type === 'text-start' &&
           part?.providerMetadata?.anthropic?.type === 'compaction';
}

/**
 * Checks if compaction was applied in the response metadata
 */
export function wasCompactionApplied(response: any): boolean {
    const appliedEdits = response?.providerMetadata?.anthropic?.contextManagement?.appliedEdits;
    if (!Array.isArray(appliedEdits)) { return false; }

    return appliedEdits.some((edit: any) => edit.type === 'compact_20260112');
}

/**
 * Gets compaction details from response metadata
 */
export function getCompactionDetails(response: any): { clearedInputTokens?: number } | null {
    const appliedEdits = response?.providerMetadata?.anthropic?.contextManagement?.appliedEdits;
    if (!Array.isArray(appliedEdits)) { return null; }

    const compactionEdit = appliedEdits.find((edit: any) => edit.type === 'compact_20260112');
    if (!compactionEdit) { return null; }

    return {
        clearedInputTokens: compactionEdit.clearedInputTokens
    };
}
