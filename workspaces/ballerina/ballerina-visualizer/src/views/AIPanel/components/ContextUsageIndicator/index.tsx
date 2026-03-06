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

import React from "react";
import styled from "@emotion/styled";
import { Tooltip } from "@wso2/ui-toolkit";
import { ContextUsageInfo } from "@wso2/ballerina-core";

interface ContextUsageIndicatorProps {
    contextUsage: ContextUsageInfo;
}

const RingButton = styled.button`
    height: 24px;
    background-color: transparent;
    border: none;
    border-radius: 4px;
    cursor: default;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px;
    margin-right: 2px;
    transition: background-color 0.2s;
    box-sizing: border-box;

    &:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
    }
`;

const RemainingText = styled.span`
    font-size: 10px;
    font-weight: 500;
    color: var(--vscode-descriptionForeground);
    line-height: 1;
    letter-spacing: 0.2px;
`;


/**
 * Compact SVG circular ring that fills clockwise based on usage percentage.
 * Uses stroke-dasharray / stroke-dashoffset technique.
 */
const RingSVG: React.FC<{ percentage: number }> = ({ percentage }) => {
    const size = 16;
    const strokeWidth = 2.5;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const filled = circumference * Math.min(percentage, 1);

    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            style={{ display: "block" }}
        >
            {/* Background track */}
            <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="var(--vscode-editorWidget-border)"
                strokeWidth={strokeWidth}
            />
            {/* Filled arc — starts from top (rotate -90°) */}
            <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="var(--vscode-progressBar-background, #0e70c0)"
                strokeWidth={strokeWidth}
                strokeLinecap={percentage > 0 ? "round" : "butt"}
                strokeDasharray={`${filled} ${circumference}`}
                strokeDashoffset={0}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                style={{ transition: "stroke-dasharray 0.4s ease", opacity: percentage > 0 ? 1 : 0 }}
            />
        </svg>
    );
};

const TooltipContent: React.FC<{ contextUsage: ContextUsageInfo }> = ({ contextUsage }) => {
    const { tokensUsed, maxTokens, percentage, willAutoCompact } = contextUsage;
    const pct = (percentage * 100).toFixed(0);
    const remaining = 100 - Number(pct);

    const formatK = (n: number) => {
        if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
        return String(n);
    };

    return (
        <div style={{ fontSize: "12px", lineHeight: "1.6" }}>
            <div style={{ fontWeight: 600, marginBottom: "4px" }}>Context window:</div>
            <div>{pct}% used ({remaining}% left)</div>
            <div>{formatK(tokensUsed)} / {formatK(maxTokens)} context tokens used</div>
            {willAutoCompact && (
                <div style={{ marginTop: "6px", color: "var(--vscode-editorWarning-foreground)" }}>
                    ⚠ Will auto-compact on next message
                </div>
            )}
        </div>
    );
};

export const ContextUsageIndicator: React.FC<ContextUsageIndicatorProps> = ({ contextUsage }) => {
    const remaining = Math.max(0, 100 - Math.round(contextUsage.percentage * 100));

    return (
        <Tooltip content={<TooltipContent contextUsage={contextUsage} />} position="top">
            <RingButton tabIndex={-1}>
                <RingSVG percentage={contextUsage.percentage} />
                <RemainingText>{remaining}%</RemainingText>
            </RingButton>
        </Tooltip>
    );
};

export default ContextUsageIndicator;
