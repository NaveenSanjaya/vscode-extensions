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

import styled from "@emotion/styled";
import React, { useState, useEffect, useRef } from "react";
import { Spinner } from "./ToolCallSegment";
import MarkdownRenderer from "./MarkdownRenderer";

const Container = styled.div`
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    margin: 8px 0;
    font-size: 12px;
    color: var(--vscode-editor-foreground);
    background-color: var(--vscode-textCodeBlock-background);
    overflow: hidden;
`;

const Header = styled.div<{ interactive: boolean }>`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    cursor: ${(props: { interactive: boolean }) => props.interactive ? 'pointer' : 'default'};
    user-select: none;
    font-family: var(--vscode-editor-font-family);

    &:hover {
        background-color: ${(props: { interactive: boolean }) => props.interactive ? 'var(--vscode-list-hoverBackground)' : 'transparent'};
    }

    & .codicon-loading,
    & .codicon-check {
        margin-right: 0;
    }
`;

const ChevronIcon = styled.span<{ expanded: boolean }>`
    transition: transform 0.2s ease;
    transform: ${(props: { expanded: boolean }) => props.expanded ? 'rotate(90deg)' : 'rotate(0deg)'};
    display: flex;
    align-items: center;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
`;

const HeaderLabel = styled.span`
    flex: 1;
    font-size: 12px;
    min-width: 0;
`;

const BodyOuter = styled.div<{ expanded: boolean }>`
    display: grid;
    grid-template-rows: ${(props: { expanded: boolean }) => props.expanded ? '1fr' : '0fr'};
    transition: grid-template-rows 0.25s ease-in-out;
    border-top: ${(props: { expanded: boolean }) => props.expanded ? '1px solid var(--vscode-panel-border)' : 'none'};
`;

const Body = styled.div`
    overflow: hidden;
    min-height: 0;
`;

const BodyContent = styled.div`
    padding: 8px 12px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);

    & p {
        margin: 4px 0;
    }
`;

interface CompactionSegmentProps {
    text: string;
    loading: boolean;
}

const CHARS_PER_TICK = 3;
const TICK_INTERVAL_MS = 10;

const CompactionSegment: React.FC<CompactionSegmentProps> = ({ text, loading }) => {
    const [isExpanded, setIsExpanded] = useState<boolean>(loading);
    const [displayedText, setDisplayedText] = useState<string>('');
    const textIndexRef = useRef<number>(0);
    const animationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Progressive reveal effect
    useEffect(() => {
        if (text.length > textIndexRef.current) {
            if (!animationTimerRef.current) {
                animationTimerRef.current = setInterval(() => {
                    textIndexRef.current = Math.min(
                        textIndexRef.current + CHARS_PER_TICK,
                        text.length
                    );
                    setDisplayedText(text.slice(0, textIndexRef.current));

                    if (textIndexRef.current >= text.length) {
                        clearInterval(animationTimerRef.current!);
                        animationTimerRef.current = null;
                    }
                }, TICK_INTERVAL_MS);
            }
        }
        return () => {
            if (animationTimerRef.current) {
                clearInterval(animationTimerRef.current);
                animationTimerRef.current = null;
            }
        };
    }, [text]);

    useEffect(() => {
        if (loading) {
            if (collapseTimerRef.current) {
                clearTimeout(collapseTimerRef.current);
                collapseTimerRef.current = null;
            }
            setIsExpanded(true);
        } else {
            collapseTimerRef.current = setTimeout(() => {
                setIsExpanded(false);
                collapseTimerRef.current = null;
            }, 1500);
        }
        return () => {
            if (collapseTimerRef.current) {
                clearTimeout(collapseTimerRef.current);
            }
        };
    }, [loading]);

    const toggleExpanded = () => {
        if (!loading) {
            setIsExpanded(prev => !prev);
        }
    };

    return (
        <Container>
            <Header interactive={!loading} onClick={toggleExpanded}>
                <ChevronIcon expanded={isExpanded}>
                    <span className="codicon codicon-chevron-right" />
                </ChevronIcon>
                {loading ? (
                    <Spinner className="codicon codicon-loading spin" role="img" />
                ) : (
                    <span className="codicon codicon-archive" role="img" style={{ fontSize: 13 }} />
                )}
                <HeaderLabel>
                    {loading ? "Compacting context..." : "Context compaction summary"}
                </HeaderLabel>
            </Header>
            <BodyOuter expanded={isExpanded}>
                <Body>
                    <BodyContent>
                        <MarkdownRenderer markdownContent={displayedText} />
                    </BodyContent>
                </Body>
            </BodyOuter>
        </Container>
    );
};

export default CompactionSegment;
