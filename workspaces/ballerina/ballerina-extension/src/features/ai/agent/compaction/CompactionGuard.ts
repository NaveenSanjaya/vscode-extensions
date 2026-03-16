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

import { CompactionEngine, ProjectStateContext } from '@wso2/copilot-utilities/compaction';
import { ModelMessage } from 'ai';
import { ChatNotify } from '@wso2/ballerina-core';

/**
 * Configuration for CompactionGuard.
 */
export interface CompactionGuardConfig {
    /** The shared CompactionEngine instance (from CompactionManager.getEngine()) */
    engine: CompactionEngine;
    /** Token count at which mid-stream compaction is triggered (e.g. 160_000 = 80% of 200K) */
    tokenThreshold: number;
    /** Maximum compaction attempts per generation before giving up (default: 3) */
    maxCompactionAttempts: number;
    /** Number of recent messages to preserve verbatim after split (default: 6) */
    preserveRecentMessageCount: number;
    /** Event handler for sending compaction status events to the UI */
    eventHandler: (event: ChatNotify) => void;
    /** Original user request content — re-injected after compaction for task continuity */
    originalUserMessage: string;
    /** Project state for continuation messages (C09) */
    projectState: ProjectStateContext;
    /** M05: AbortSignal to propagate cancellation into the summarization LLM call */
    abortSignal?: AbortSignal;
}

/**
 * CompactionGuard — mid-stream compaction logic for Vercel AI SDK's `prepareStep` hook.
 *
 * Called from `prepareStep` before each LLM step. Reads the actual inputTokens from
 * the last completed step, and if above threshold, summarizes the old messages and
 * returns a compacted replacement message array.
 *
 * The guard tracks compaction attempts and sets `lastCompactionFailed` when it can no
 * longer reduce context, allowing the `contextExhausted` stop condition to halt gracefully.
 */
export class CompactionGuard {
    private compactionCount: number = 0;
    private _lastCompactionFailed: boolean = false;

    constructor(private config: CompactionGuardConfig) {}

    /**
     * Read by the `contextExhausted` StopCondition to halt generation gracefully.
     */
    get lastCompactionFailed(): boolean {
        return this._lastCompactionFailed;
    }

    /**
     * Called from `prepareStep`. Decides whether to compact and performs it.
     *
     * @returns Replacement `{ messages }` object for prepareStep, or `undefined` to proceed normally.
     */
    async maybeCompact(options: {
        steps: any[];
        stepNumber: number;
        messages: ModelMessage[];
    }): Promise<{ messages: ModelMessage[] } | undefined> {
        const { steps, messages } = options;

        // Skip on the very first step — no usage data available yet
        if (steps.length === 0) {
            return undefined;
        }

        // Respect abort signal
        if (this.config.abortSignal?.aborted) {
            return undefined;
        }

        // Read actual token count from the most recent completed step.
        // usage.inputTokens is the ground truth — it's what the LLM API actually consumed.
        const lastStep = steps[steps.length - 1];
        const lastInputTokens: number = lastStep.usage?.inputTokens ?? 0;

        if (lastInputTokens < this.config.tokenThreshold) {
            return undefined; // Context is fine, proceed normally
        }

        console.log(
            `[CompactionGuard] Token threshold reached: ${lastInputTokens} >= ${this.config.tokenThreshold} ` +
            `(step ${options.stepNumber}, attempt ${this.compactionCount + 1}/${this.config.maxCompactionAttempts})`
        );

        // If we've exhausted all attempts, give up — let contextExhausted stop the generation
        if (this.compactionCount >= this.config.maxCompactionAttempts) {
            console.error(
                `[CompactionGuard] Max compaction attempts (${this.config.maxCompactionAttempts}) reached.`
            );
            this._lastCompactionFailed = true;
            return undefined;
        }

        try {
            return await this.performCompaction(messages);
        } catch (error) {
            console.error('[CompactionGuard] Mid-stream compaction failed:', error);
            this._lastCompactionFailed = true;
            this.config.eventHandler({
                type: 'compaction_failed',
                reason: error instanceof Error ? error.message : 'Unknown compaction error',
            });
            return undefined;
        }
    }

    /**
     * Core compaction: splits messages, summarizes old portion, preserves recent messages.
     */
    private async performCompaction(
        messages: ModelMessage[]
    ): Promise<{ messages: ModelMessage[] }> {
        this.config.eventHandler({ type: 'compaction_start' });

        // === SPLIT: determine boundary between old (to summarize) and recent (to keep) ===
        const preserveCount = this.config.preserveRecentMessageCount;
        const targetSplitIndex = Math.max(0, messages.length - preserveCount);
        const cleanSplitIndex = this.findCleanSplitPoint(messages, targetSplitIndex);

        const oldMessages = messages.slice(0, cleanSplitIndex);
        const recentMessages = messages.slice(cleanSplitIndex);

        console.log(
            `[CompactionGuard] Split: ${oldMessages.length} messages → summarize, ` +
            `${recentMessages.length} messages → preserve verbatim`
        );

        // === SUMMARIZE old messages ===
        // MID_STREAM_INSTRUCTIONS injected via customInstructions — flows through
        // SummarizationService as "## Additional Summarization Instructions from User".
        // This keeps a single prompt source of truth (Section 9.6).
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
            customInstructions: MID_STREAM_INSTRUCTIONS,
        });

        if (!compactionResult.success) {
            throw new Error('CompactionEngine.compact() returned success: false');
        }

        // === BUILD replacement message array ===
        // Structure: [summary pair] + [task reminder] + [recent tool interactions]
        const compactedMessages: ModelMessage[] = [
            ...compactionResult.compactedMessages,
            // Re-inject original request so the model remembers what it was working on
            {
                role: 'user' as const,
                content: `[Mid-stream compaction occurred. The context was approaching token limits. ` +
                    `Your conversation history has been compacted. Continue working on the original task below.]\n\n` +
                    `Original request: ${this.config.originalUserMessage}`,
            },
            {
                role: 'assistant' as const,
                content: 'Understood. I will continue working on the task. Let me pick up where I left off based on the recent context.',
            },
            // Preserved recent messages — verbatim (last N tool interactions)
            ...recentMessages,
        ];

        this.compactionCount++;

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
     *
     * Walks backward from targetIndex until a 'user' role message is found.
     * User messages are safe split boundaries — they are never mid-tool-call.
     *
     * Returns `messages.length` to skip compaction if too few messages (<4) remain.
     */
    private findCleanSplitPoint(messages: ModelMessage[], targetIndex: number): number {
        let index = targetIndex;

        while (index > 0) {
            if (messages[index].role === 'user') {
                break;
            }
            index--;
        }

        // Don't summarize fewer than 4 messages — not worth the latency
        if (index < 4) {
            return messages.length; // Skip compaction
        }

        return index;
    }
}
