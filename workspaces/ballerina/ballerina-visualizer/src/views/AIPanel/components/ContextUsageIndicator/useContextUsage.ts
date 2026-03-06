/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
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

import { useEffect, useRef, useState } from "react";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { ContextUsageInfo } from "@wso2/ballerina-core";

// These defaults match constants.ts in ballerina-extension.
// They are only used as fallbacks until the first getContextUsage() RPC resolves.
const DEFAULT_MAX_TOKENS = 200000;
const DEFAULT_COMPACTION_TRIGGER = 60000;

/**
 * Hook to fetch and manage context usage data.
 *
 * Update strategy:
 *  - On mount and after each completed generation (messageCount change): fetches
 *    the settled token count from the backend via getContextUsage() RPC.
 *  - During streaming: updates live from usage_metrics events on onChatNotify.
 *
 * Bug fixes applied:
 *  1. Subscription accumulation — the onChatNotify callback is registered once
 *     and an `active` flag prevents stale closures from updating state after
 *     the effect re-runs or the component unmounts.
 *  2. Cold-start race — compactionTriggerRef now initialises to
 *     DEFAULT_COMPACTION_TRIGGER so willAutoCompact is correct even before the
 *     first RPC fetch resolves.
 */
export function useContextUsage(messageCount: number, isLoading: boolean) {
    const { rpcClient } = useRpcContext();
    const [contextUsage, setContextUsage] = useState<ContextUsageInfo | null>(null);

    // Keep authoritative values in refs so the stable onChatNotify closure
    // always reads the latest figures without needing to be re-registered.
    const maxTokensRef = useRef<number>(DEFAULT_MAX_TOKENS);
    const compactionTriggerRef = useRef<number>(DEFAULT_COMPACTION_TRIGGER);

    // ── Effect 1: Fetch settled token count from backend ──────────────────────
    // Runs on mount and whenever a generation completes (messageCount changes).
    useEffect(() => {
        // Don't fetch from backend while generation is still streaming —
        // the token count isn't persisted yet, so we'd get a stale value.
        if (isLoading) return;

        let cancelled = false;

        const fetchContextUsage = async () => {
            try {
                const usage = await rpcClient.getAiPanelRpcClient().getContextUsage();
                if (cancelled) return;

                // null means no token data yet (e.g. first load before any generation)
                setContextUsage(usage);

                // Keep refs in sync so the streaming handler stays accurate
                if (usage?.maxTokens) {
                    maxTokensRef.current = usage.maxTokens;
                }
                if (usage?.compactionTriggerTokens) {
                    compactionTriggerRef.current = usage.compactionTriggerTokens;
                }
            } catch (error) {
                if (cancelled) return;
                console.error("[useContextUsage] Failed to fetch context usage:", error);
                // Stale-while-revalidate: transient errors must not clear the ring
            }
        };

        fetchContextUsage();

        return () => {
            cancelled = true;
        };
    }, [messageCount, isLoading, rpcClient]);

    // ── Effect 2: Live ring updates during streaming ───────────────────────────
    // Registered once per rpcClient instance.
    // Uses an `active` flag instead of trying to unsubscribe (the messenger
    // wrapper does not expose an unsubscribe handle), so stale closures from
    // previous effect runs silently drop their updates.
    useEffect(() => {
        let active = true;

        rpcClient.onChatNotify((event) => {
            if (!active) return; // Drop events from stale subscriptions

            if (event.type !== "usage_metrics") return;

            const inputTokens = event.usage?.inputTokens || 0;
            const maxTokens = maxTokensRef.current;
            const percentage = maxTokens > 0 ? inputTokens / maxTokens : 0;
            const willAutoCompact = inputTokens >= compactionTriggerRef.current;

            setContextUsage({
                tokensUsed: inputTokens,
                maxTokens,
                percentage,
                willAutoCompact,
                compactionTriggerTokens: compactionTriggerRef.current,
            });
        });

        return () => {
            active = false;
        };
    }, [rpcClient]);

    return { contextUsage };
}
