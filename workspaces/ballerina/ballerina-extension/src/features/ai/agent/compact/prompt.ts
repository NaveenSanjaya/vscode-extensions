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

/**
 * Compaction instructions used by native (Anthropic server-side) compaction.
 * Passed as the `instructions` field in contextManagement.edits.
 */
export const COMPACTION_PROMPT = `
Your task is to create a detailed summary of the conversation so far.
This summary will replace the conversation history to free up context window space,
so it is critical that you preserve ALL important details with precision.

Before writing your summary, wrap your analysis in <analysis> tags to think through the conversation carefully.
In your analysis:
- Go through each message chronologically
- Note the user's explicit requests and any changes in direction
- Identify all files modified, created or read, with their full paths
- Capture any code that was written, even partially

After your analysis, write your summary wrapped in <summary> tags.

Your summary MUST cover the following sections:

1. **User Goals**: What the user is trying to accomplish overall.
2. **Key Decisions & Rationale**: Important choices made and why.
3. **Current State**: What has been done so far — files modified, code written, configs applied.
4. **All User Messages**: List ALL user messages verbatim (not paraphrased). This is critical to prevent intent drift in the next session.
5. **Important Code & File Details**: Key code snippets copied VERBATIM (not summarized), full file paths, function signatures, and config values that would be needed to continue the work.
6. **Errors & Fixes**: Any errors encountered and exactly how they were resolved, including user feedback.
7. **Tool Actions Taken**: Summary of file read/write/edit and other tool operations performed.
8. **Open Questions & Next Steps**: Any unresolved issues or planned work.

Rules:
- Include full code snippets verbatim where applicable — do NOT paraphrase or abbreviate code.
- Copy user messages exactly as written — do NOT paraphrase or interpret intent.
- Be comprehensive enough that someone reading ONLY this summary could continue the conversation seamlessly.
- Do NOT include any new actions or suggestions — only summarize what has already happened.

<format_example>
<analysis>
[Your chronological analysis of each message and section]
</analysis>

<summary>
## User Goals
[What the user is trying to accomplish]

## Key Decisions & Rationale
[Important choices and why they were made]

## Current State
[What has been done, files modified, code written]

## All User Messages
- "[exact user message 1]"
- "[exact user message 2]"
- [...]

## Important Code & File Details
- \`path/to/file.ts\`
  - [Why this file matters]
  \`\`\`typescript
  [full verbatim code snippet]
  \`\`\`

## Errors & Fixes
- [Error description]: [How it was fixed]

## Tool Actions Taken
[Summary of operations performed]

## Open Questions & Next Steps
[Unresolved issues, planned work]
</summary>
</format_example>
`;
