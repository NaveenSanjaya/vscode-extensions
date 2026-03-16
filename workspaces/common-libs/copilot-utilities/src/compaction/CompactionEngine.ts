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

import {
    CompactionEngineConfig,
    CompactionMetadata,
    CompactionOptions,
    CompactionResult,
    SummarizationCallback,
    TokenEstimationContext,
} from './types';
import { TokenEstimator } from './core/TokenEstimator';
import { ThresholdCalculator } from './core/ThresholdCalculator';
import { SummarizationService } from './core/SummarizationService';
import { createContinuationMessages } from './utils/messageUtils';

/**
 * CompactionEngine — main orchestrator for context compaction.
 *
 * Provider-agnostic: receives summarization via callback, no SDK dependency.
 *
 * Usage:
 * 1. Construct with config (modelConfig + tokenCountCallback)
 * 2. Call setSummarizationCallback() once the LLM model is available (M02)
 * 3. Call shouldCompact() to check if compaction is needed
 * 4. Call compact() to perform compaction
 */
export class CompactionEngine {
    private tokenEstimator: TokenEstimator;
    private thresholdCalculator: ThresholdCalculator;
    private summarizationService: SummarizationService | null;
    private isCompacting: boolean = false; // Concurrency guard

    constructor(config: CompactionEngineConfig) {
        this.tokenEstimator = new TokenEstimator(config.tokenCountCallback);
        this.thresholdCalculator = new ThresholdCalculator(config.modelConfig);
        this.summarizationService = config.summarizationCallback
            ? new SummarizationService(config.summarizationCallback)
            : null;
    }

    /**
     * M02: Bind or replace the summarization callback.
     * Must be called before compact() with the caller's authenticated model instance.
     */
    setSummarizationCallback(callback: SummarizationCallback): void {
        this.summarizationService = new SummarizationService(callback);
    }

    /**
     * M02: Check if a summarization callback has been bound.
     */
    hasSummarizationCallback(): boolean {
        return this.summarizationService !== null;
    }

    /**
     * Update token estimation context with actual usage data from streamText.
     * Call this after each LLM step for most accurate threshold checks.
     */
    updateTokenContext(context: TokenEstimationContext): void {
        this.tokenEstimator.updateContext(context);
    }

    /**
     * Check if the message history is above the auto-compaction threshold.
     */
    async shouldCompact(messages: any[]): Promise<boolean> {
        const tokenCount = await this.tokenEstimator.estimateTokens(messages);
        return this.thresholdCalculator.isAboveAutoCompactThreshold(tokenCount);
    }

    /**
     * Get the current token status of the message history.
     */
    async getTokenStatus(messages: any[]): Promise<{
        currentTokens: number;
        threshold: number;
        percentageUsed: number;
        isAboveThreshold: boolean;
    }> {
        const tokenCount = await this.tokenEstimator.estimateTokens(messages);
        const threshold = this.thresholdCalculator.getAutoCompactThreshold();
        return {
            currentTokens: tokenCount,
            threshold,
            percentageUsed: (tokenCount / threshold) * 100,
            isAboveThreshold: tokenCount >= threshold,
        };
    }

    /**
     * Compact the message history.
     *
     * Returns a CompactionResult with success=false (and original messages) on error,
     * so the caller can decide whether to continue without compaction (C10 fix).
     */
    async compact(messages: any[], options: CompactionOptions): Promise<CompactionResult> {
        // Concurrency guard — prevent parallel compaction calls
        if (this.isCompacting) {
            throw new Error('Compaction already in progress');
        }

        this.isCompacting = true;

        try {
            // M02: Ensure summarization callback is bound
            if (!this.summarizationService) {
                throw new Error(
                    'Summarization callback not set. Call setSummarizationCallback() before compact().'
                );
            }

            // C14: Validate messages at engine boundary
            this.validateMessages(messages);

            return await this.compactWithRetry(messages, options, 0);
        } catch (error) {
            // C10: Graceful degradation — return failure result instead of throwing
            console.error('[CompactionEngine] Compaction failed:', error);

            const originalTokens = await this.tokenEstimator.estimateTokens(messages);
            return {
                success: false,
                originalTokens,
                compactedTokens: 0,
                reductionPercentage: 0,
                compactedMessages: messages,
                summary: '',
                retriesUsed: 0,
                metadata: {
                    compactedAt: Date.now(),
                    originalMessageCount: messages.length,
                    originalTokenEstimate: originalTokens,
                    compactedTokenEstimate: 0,
                    retries: 0,
                    mode: options.mode,
                    userInstructions: options.customInstructions,
                },
            };
        } finally {
            this.isCompacting = false;
        }
    }

    /**
     * C14: Validate that messages conform to expected structure.
     */
    private validateMessages(messages: any[]): void {
        if (!Array.isArray(messages)) {
            throw new Error('Messages must be an array');
        }

        for (const msg of messages) {
            if (!msg.role || !['user', 'assistant', 'system', 'tool'].includes(msg.role)) {
                throw new Error(`Invalid message role: ${msg.role}`);
            }
            if (msg.content === undefined || msg.content === null) {
                throw new Error('Message missing content property');
            }
        }
    }

    /**
     * Core compaction with retry logic.
     *
     * M03: Always retries from ORIGINAL messages (never re-summarizes a summary).
     * On retry, passes targetTokenBudget to guide a more concise output.
     */
    private async compactWithRetry(
        messages: any[],
        options: CompactionOptions,
        retryCount: number
    ): Promise<CompactionResult> {
        const maxRetries = options.maxRetries ?? 3;
        const originalTokens = await this.tokenEstimator.estimateTokens(messages);
        const threshold = this.thresholdCalculator.getAutoCompactThreshold();

        // M03: On retry, ask for a shorter summary by passing a token budget constraint
        const targetTokenBudget = retryCount > 0
            ? Math.floor(threshold * 0.5)  // Aim for 50% of threshold on retries
            : undefined;

        // Summarize (M05: abortSignal forwarded)
        const summary = await this.summarizationService!.summarize(
            messages,
            options.customInstructions,
            options.abortSignal,
            targetTokenBudget
        );

        // C09: Build continuation messages with optional project state
        const continuationMessages = createContinuationMessages(summary, options.projectState);
        const compactedMessages = [...continuationMessages];

        const compactedTokens = await this.tokenEstimator.estimateTokens(compactedMessages);
        const reductionPercentage = ((originalTokens - compactedTokens) / originalTokens) * 100;

        // M03: If still above threshold, retry from ORIGINAL messages with stricter budget
        if (compactedTokens >= threshold && retryCount < maxRetries) {
            console.warn(
                `[CompactionEngine] Summary still ${compactedTokens} tokens (threshold: ${threshold}). ` +
                `Re-summarizing original messages with tighter budget... ` +
                `(${retryCount + 1}/${maxRetries})`
            );
            return this.compactWithRetry(messages, options, retryCount + 1);
        }

        // Clear cache for fresh start after compaction
        this.tokenEstimator.clearCache();

        // C15: Compaction audit metadata
        const metadata: CompactionMetadata = {
            compactedAt: Date.now(),
            originalMessageCount: messages.length,
            originalTokenEstimate: originalTokens,
            compactedTokenEstimate: compactedTokens,
            retries: retryCount,
            mode: options.mode,
            userInstructions: options.customInstructions,
        };

        return {
            success: true,
            originalTokens,
            compactedTokens,
            reductionPercentage,
            compactedMessages,
            summary,
            retriesUsed: retryCount,
            metadata,
        };
    }
}
