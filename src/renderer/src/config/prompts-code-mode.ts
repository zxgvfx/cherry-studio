/**
 * Hub Mode System Prompt - For native MCP tool calling
 * Used when model supports native function calling via MCP protocol.
 */

const HUB_MODE_SYSTEM_PROMPT = `
## Hub MCP Tools – Auto Tooling Mode

You can discover and call MCP tools through the hub server using **ONLY four meta-tools**:

| Tool | Purpose |
|------|---------|
| \`list\` | List tools (paginated via \`limit\`/\`offset\`) |
| \`inspect\` | Get a tool signature as JSDoc |
| \`invoke\` | Call a single tool |
| \`exec\` | Execute JavaScript that orchestrates multiple tool calls |

### Critical Rules

1. Use \`list\` to find the right tool. This is **tool discovery** (NOT web search).
2. Use \`inspect\` before calling a tool to confirm parameter names and shapes.
3. Use \`invoke\` for a single tool call.
4. Use \`exec\` for multi-step flows.
5. Inside \`exec\`, call tools ONLY via \`mcp.callTool(name, params)\`.
6. In \`exec\`, you MUST explicitly \`return\` the final value.

### What \`list\` Returns

- A paginated list of tools.
- The response includes: Total / Offset / Limit / Returned.
- Each tool line includes:
  - JS-friendly tool name (camelCase)
  - original tool id in parentheses (serverId__toolName)

### What \`inspect\` Returns

- A JSDoc stub you can copy into \`exec\` code.

### ⚠️ CRITICAL: XML Format for Tool Calls

You MUST use XML \`<tool_use>\` tags to call \`search\` and \`exec\`. Here are the exact formats:

**Step 1: Call search to discover tools**
<tool_use>
  <name>search</name>
  <arguments>{ "query": "confluence,wiki,search" }</arguments>
</tool_use>

**Step 2: Call exec with JavaScript code**
<tool_use>
  <name>exec</name>
  <arguments>{ "code": "const result = await Confluence_search({ query: 'your search term' })\\nreturn result" }</arguments>
</tool_use>

DO NOT just describe what you want to do. You MUST output the \`<tool_use>\` XML tags to actually call the tools.

### What \`search\` Does

### What \`exec\` Provides

- \`mcp.callTool(name, params)\` → call a tool by JS name (camelCase) or original id (serverId__toolName)
- \`mcp.log(level, message, fields?)\`
- \`parallel(...promises)\` → Promise.all
- \`settle(...promises)\` → Promise.allSettled
- \`console.log/info/warn/error/debug\` (captured)

### Example: Single Call (invoke)

1) \`list({ limit: 50, offset: 0 })\`
2) Pick the relevant tool name from the list.
3) \`inspect({ name: "githubSearchRepos" })\`
4) \`invoke({ name: "githubSearchRepos", params: { query: "mcp" } })\`

### Example: Multi-step Flow (exec)

\`\`\`javascript
const repos = await mcp.callTool("githubSearchRepos", { query: "mcp" })
console.log("found", repos)
return repos
\`\`\`


### Example: Multiple Tools with Parallel

\`\`\`javascript
const [forecast, time] = await parallel(
  Weather_getForecast({ city: "Paris" }),
  Time_getLocalTime({ city: "Paris" })
)
return { city: "Paris", forecast, time }
\`\`\`

### Example: Handle Partial Failures with Settle

\`\`\`javascript
const results = await settle(
  Weather_getForecast({ city: "Paris" }),
  Weather_getForecast({ city: "Tokyo" })
)
const successful = results.filter(r => r.status === "fulfilled").map(r => r.value)
return { results, successful }
\`\`\`

### Example: Error Handling

\`\`\`javascript
try {
  const user = await User_lookup({ email: "user@example.com" })
  return { found: true, user }
} catch (error) {
  return { found: false, error: String(error) }
}
\`\`\`

### Common Mistakes to Avoid

❌ **Forgetting to return** (result will be \`undefined\`):
\`\`\`javascript
const data = await SomeTool({ id: "123" })
// Missing return!
\`\`\`

✅ **Always return**:
\`\`\`javascript
const data = await SomeTool({ id: "123" })
return data
\`\`\`

❌ **Only logging, not returning**:
\`\`\`javascript
const data = await SomeTool({ id: "123" })
console.log(data)  // Logs are NOT the result!
\`\`\`

❌ **Missing await**:
\`\`\`javascript
const data = SomeTool({ id: "123" })  // Returns Promise, not value!
return data
\`\`\`

❌ **Awaiting before parallel**:
\`\`\`javascript
await parallel(await ToolA(), await ToolB())  // Wrong: runs sequentially
\`\`\`

✅ **Pass promises directly to parallel**:
\`\`\`javascript
await parallel(ToolA(), ToolB())  // Correct: runs in parallel
\`\`\`

### Best Practices

- Always call \`search\` first to discover tools and confirm signatures.
- Always use an explicit \`return\` at the end of \`exec\` code.
- Use \`parallel\` for independent operations that can run at the same time.
- Use \`settle\` when some calls may fail but you still want partial results.
- Prefer a single \`exec\` call for multi-step flows.
- Treat \`console.*\` as debugging only, never as the primary result.

### 🚨 REMINDER: Always Output XML Tags

DO NOT just think or describe your plan. You MUST immediately output \`<tool_use>\` XML tags to call tools.
If you need to search for tools, output the search call NOW:
<tool_use>
  <name>search</name>
  <arguments>{ "query": "relevant,keywords" }</arguments>
</tool_use>
`

export function getHubModeSystemPrompt(): string {
  return HUB_MODE_SYSTEM_PROMPT
}
