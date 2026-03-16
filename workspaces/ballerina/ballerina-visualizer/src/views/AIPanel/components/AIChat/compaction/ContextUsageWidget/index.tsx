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

import React from "react";
import styled from "@emotion/styled";

const PRE_TURN_THRESHOLD = 178_808;

const WidgetContainer = styled.div`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: 4px;
    cursor: default;
    user-select: none;
`;

const Label = styled.span`
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1;
`;

interface ContextUsageWidgetProps {
    percentage: number;
    inputTokens: number;
}

const ContextUsageWidget: React.FC<ContextUsageWidgetProps> = ({ percentage, inputTokens }) => {
    const clampedPct = Math.min(100, Math.max(0, percentage));

    // SVG ring geometry
    const size = 20;
    const cx = size / 2;
    const cy = size / 2;
    const r = 8;
    const circumference = 2 * Math.PI * r;
    const filled = (clampedPct / 100) * circumference;
    const gap = circumference - filled;

    const remainingTokens = Math.max(0, PRE_TURN_THRESHOLD - inputTokens);
    const remainingK = Math.round(remainingTokens / 1000);
    const thresholdK = Math.round(PRE_TURN_THRESHOLD / 1000);
    const tooltipText = `~${remainingK}K tokens until auto-compaction (${thresholdK}K threshold)`;

    return (
        <WidgetContainer title={tooltipText}>
            <svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                aria-hidden="true"
            >
                {/* Background ring */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="none"
                    stroke="var(--vscode-descriptionForeground)"
                    strokeOpacity={0.2}
                    strokeWidth={2}
                />
                {/* Filled arc */}
                <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="none"
                    stroke="var(--vscode-descriptionForeground)"
                    strokeWidth={2}
                    strokeDasharray={`${filled} ${gap}`}
                    strokeLinecap="round"
                    transform={`rotate(-90 ${cx} ${cy})`}
                />
            </svg>
            <Label>{clampedPct}%</Label>
        </WidgetContainer>
    );
};

export default ContextUsageWidget;
