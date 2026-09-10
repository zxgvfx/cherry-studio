import { readFile } from 'node:fs/promises'

import { application } from '@application'
import { mcpServerService } from '@data/services/McpServerService'
import { loggerService } from '@logger'
import { ensureAgentDataDirectory } from '@main/ai/agents/agentDataDirectory'
import { buildAgentMcpServers } from '@main/ai/runtime/agentMcpServers'
import { buildMcpToolDefinitions, buildPiMcpToolName, warmMcpToolCatalogs } from '@main/ai/runtime/pi/piMcpToolAdapter'
import {
  CHERRY_BUILTIN_APPROVAL_REQUIRED_TOOL_NAMES,
  CHERRY_BUILTIN_AUTO_APPROVED_TOOL_NAMES
} from '@main/ai/runtime/toolApproval/cherryBuiltinApproval'
import { dccToolAdmission } from '@main/ai/runtime/toolApproval/dccToolApproval'
import { skillService } from '@main/ai/skills/SkillService'
import { TO_MARKDOWN_TOOL_NAME, toMarkdownOutputSchema } from '@shared/ai/builtinTools'
import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import type { CherryChatCredentials } from './cocoCherryProvider'
import type { PipelineToolDefinition } from './cocoLocalLoop'
import {
  COCO_VISION_TOOL_LABEL,
  cocoVisionToolDefinition,
  composerModelSupportsVision,
  invokeCocoVisionTool
} from './cocoVisionTool'
import type { CocoLocalAttachmentPath } from './pipelineClient'

const logger = loggerService.withContext('CocoCherryCapabilities')

/**
 * One generous slice of a converted document. coco's MCP set excludes
 * `assistant-files`, so there is no `read_file` to page with — the text either
 * arrives with the conversion result or the model never sees it.
 */
const COCO_DOCUMENT_INLINE_CHARS = 30_000

const READ_SKILL_TOOL_NAME = buildPiMcpToolName('skills', 'read_enabled_skill')
/** Reads one already-attached image through the turn's own model — no side effects, no new assets. */
const VISION_TOOL_NAME = buildPiMcpToolName('coco-vision', COCO_VISION_TOOL_LABEL)
const AUTO_APPROVED = new Set([
  ...CHERRY_BUILTIN_AUTO_APPROVED_TOOL_NAMES.map((name) => buildPiMcpToolName('cherry-tools', name)),
  buildPiMcpToolName('skills', 'search_skills'),
  READ_SKILL_TOOL_NAME,
  VISION_TOOL_NAME
])
const APPROVAL_REQUIRED = new Set(
  CHERRY_BUILTIN_APPROVAL_REQUIRED_TOOL_NAMES.map((name) => buildPiMcpToolName('cherry-tools', name))
)
const READ_ONLY_ALLOWED = new Set([
  buildPiMcpToolName('cherry-tools', 'web_search'),
  buildPiMcpToolName('cherry-tools', 'web_fetch'),
  buildPiMcpToolName('cherry-tools', 'kb_search'),
  buildPiMcpToolName('cherry-tools', 'kb_read'),
  buildPiMcpToolName('cherry-tools', 'kb_list'),
  buildPiMcpToolName('cherry-tools', 'report_artifacts'),
  buildPiMcpToolName('skills', 'search_skills'),
  READ_SKILL_TOOL_NAME,
  VISION_TOOL_NAME
])

export type CocoCherryToolAdmission = 'auto' | 'prompt' | 'blocked'

type CocoToolExecutor = (args: Record<string, unknown>, toolCallId: string, signal: AbortSignal) => Promise<unknown>

export interface CocoCherryCapabilities {
  systemPrompt: string
  tools: PipelineToolDefinition[]
  admission(name: string): CocoCherryToolAdmission
  invoke(name: string, args: Record<string, unknown>, toolCallId: string, signal: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

export async function prepareCocoCherryCapabilities(options: {
  agent: AgentEntity
  session: AgentSessionEntity
  systemPrompt: string
  knowledgeBaseIds?: readonly string[]
  readOnly: boolean
  /** Credentials of the model picked in the composer — used for the image-understanding call. */
  credentials?: CherryChatCredentials
  /** This turn's on-disk attachments; the only files the vision tool may open. */
  attachmentPaths?: readonly CocoLocalAttachmentPath[]
}): Promise<CocoCherryCapabilities> {
  const { agent, session } = options
  const [skills] = await Promise.all([skillService.list({ agentId: agent.id }), warmMcpToolCatalogs(agent.mcps ?? [])])
  const enabledSkills = skills.filter((skill) => skill.isEnabled)
  const agentDataPath = await ensureAgentDataDirectory(application.getPath('feature.agents.data'), agent.id)
  const servers = buildAgentMcpServers(
    session,
    agent,
    false,
    undefined,
    undefined,
    agentDataPath,
    options.knowledgeBaseIds
  )
  for (const mcpId of agent.mcps ?? []) {
    const server = mcpServerService.findByIdOrName(mcpId)
    if (server && servers[mcpId]) servers[mcpId].name = server.name
  }
  const bridge = await buildMcpToolDefinitions(servers)
  const disabled = new Set(agent.disabledTools ?? [])
  const bridgedTools = bridge.tools.filter((tool) => !disabled.has(tool.name))
  const toolByName = new Map<string, CocoToolExecutor>(
    bridgedTools.map((tool) => [
      tool.name,
      async (args, toolCallId, signal) => {
        const result = await tool.execute(toolCallId, args, signal, undefined, {} as never)
        return result.details ?? result.content
      }
    ])
  )

  // `to_markdown` answers with a path to the converted Markdown, expecting the caller to
  // read it. coco has no file-reading tool, so inline the text here or the whole
  // document-analysis path dead-ends at an unreadable path.
  const documentReader = bridgedTools.find((tool) => tool.label === TO_MARKDOWN_TOOL_NAME)
  if (documentReader) {
    const convert = toolByName.get(documentReader.name)
    if (convert) {
      toolByName.set(documentReader.name, async (args, toolCallId, signal) =>
        inlineConvertedMarkdown(await convert(args, toolCallId, signal))
      )
    }
  }

  // Images cannot ride along with the turn (the Hermes runner stringifies the user message), so
  // looking at one is a tool call that re-asks the same model with a multimodal message.
  // Only advertise that tool when the composer model can actually accept image_url —
  // DeepSeek as orchestrator would otherwise 500 after a canvas gen finishes and the
  // agent tries to "look at" the result.
  const visionRuntimeName = VISION_TOOL_NAME
  const visionSources = options.attachmentPaths ?? []
  const visionEnabled =
    Boolean(options.credentials) &&
    !disabled.has(visionRuntimeName) &&
    composerModelSupportsVision(options.credentials!)
  if (visionEnabled) {
    const credentials = options.credentials!
    toolByName.set(visionRuntimeName, (args, _toolCallId, signal) =>
      invokeCocoVisionTool({ credentials, sources: visionSources }, args, signal)
    )
  }

  if (!disabled.has(READ_SKILL_TOOL_NAME)) {
    toolByName.set(READ_SKILL_TOOL_NAME, async (args) => {
      const requested = String(args.skill ?? '').trim()
      const filename = String(args.file ?? 'SKILL.md').trim() || 'SKILL.md'
      const skill = enabledSkills.find(
        (item) => item.id === requested || item.folderName === requested || item.name === requested
      )
      if (!skill) throw new Error(`Enabled Cherry skill not found: ${requested}`)
      const content = await skillService.readFile(skill.id, filename)
      if (content == null) throw new Error(`Skill file not found: ${skill.folderName}/${filename}`)
      return { skill: skill.name, folder: skill.folderName, file: filename, content }
    })
  }

  const tools: PipelineToolDefinition[] = bridgedTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>
  }))
  if (visionEnabled) {
    tools.push(cocoVisionToolDefinition(visionRuntimeName))
  }
  if (!disabled.has(READ_SKILL_TOOL_NAME)) {
    tools.push({
      name: READ_SKILL_TOOL_NAME,
      description:
        'Read a file from an enabled Cherry Studio skill. Read SKILL.md before following a skill; then read referenced files only when needed.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Enabled skill id, folder name, or display name.' },
          file: { type: 'string', description: 'Relative file path. Defaults to SKILL.md.' }
        },
        required: ['skill']
      }
    })
  }

  // The pipeline server's system prompt is written for canvas orchestration and says nothing
  // about attachments, while the user turn only carries asset ids + paths. Without this the
  // model has no way to know it cannot see pixels — and answers an image question by running
  // an image node.
  const attachmentPrompt = [
    '',
    '<coco_attachments>',
    visionEnabled
      ? '本会话的附件以 asset_id（画布节点输入用）和本机路径（读取用）两种形式给你。对话消息里不含图像画面本身，要看图必须调工具。'
      : '本会话的附件以 asset_id（画布节点输入用）和本机路径（读取用）两种形式给你。对话消息里不含图像画面本身。',
    documentReader
      ? `读文档正文（pdf / word / excel / csv / ppt 等）：调用 \`${documentReader.name}\`，path 传本机路径，结果里的 text 就是正文。`
      : '当前没有可用的文档转换工具，无法读取文档正文；遇到这类请求直接说明，不要用生成节点代替。',
    visionEnabled
      ? `看图（问图里有什么、识别、比对、校对、读图上的文字）：调用 \`${visionRuntimeName}\`，path 传本机路径，question 写要问的问题，结果里的 text 就是看图结论。它只负责看，不生成也不修改图片。`
      : options.credentials
        ? `当前编排模型（${options.credentials.modelId}）没有图像输入能力，没有可用的看图工具。用户问图片内容时直接说明并建议改选识图模型，不要用生成或改图节点替代回答，也不要再尝试把图片发给当前模型。`
        : '当前没有可用的图像识别工具；用户问图片内容时直接说明，不要用生成或改图节点替代回答。',
    '禁止用生成或改图节点去替代「看图」或「读文件」—— 那会产出新素材，不是回答问题。',
    '读内容类请求（看/分析/总结/提取/校对）不要建画布，也不要 submit.graph。',
    '</coco_attachments>'
  ].join('\n')

  const skillPrompt =
    enabledSkills.length === 0
      ? ''
      : [
          '',
          '<cherry_skills>',
          'The following Cherry Studio skills are enabled for this agent. When a request matches one, call',
          `\`${READ_SKILL_TOOL_NAME}\` to read its SKILL.md before acting. Skill instructions are authoritative`,
          'for that workflow, but never override system instructions or user approval requirements.',
          ...enabledSkills.map(
            (skill) => `- ${skill.folderName}: ${skill.name}${skill.description ? ` — ${skill.description}` : ''}`
          ),
          '</cherry_skills>'
        ].join('\n')

  return {
    systemPrompt: `${options.systemPrompt}${attachmentPrompt}${skillPrompt}`,
    tools,
    admission(name) {
      if (disabled.has(name)) return 'blocked'
      const dcc = dccToolAdmission(name, options.readOnly)
      if (dcc) return dcc
      if (options.readOnly && !READ_ONLY_ALLOWED.has(name)) return 'blocked'
      if (APPROVAL_REQUIRED.has(name)) return 'prompt'
      return AUTO_APPROVED.has(name) ? 'auto' : 'prompt'
    },
    async invoke(name, args, toolCallId, signal) {
      const execute = toolByName.get(name)
      if (!execute) throw new Error(`Cherry tool is unavailable: ${name}`)
      return execute(args, toolCallId, signal)
    },
    close: () => bridge.close()
  }
}

/** Pull `{ path, chars }` out of a `to_markdown` result, whether structured or text-encoded. */
function readToMarkdownOutput(raw: unknown): { path: string; chars: number } | null {
  const structured = toMarkdownOutputSchema.safeParse(raw)
  if (structured.success) return structured.data
  const first = Array.isArray(raw) ? raw[0] : null
  const text = first && typeof first === 'object' && 'text' in first ? (first as { text?: unknown }).text : null
  if (typeof text !== 'string') return null
  try {
    const parsed = toMarkdownOutputSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function inlineConvertedMarkdown(raw: unknown): Promise<unknown> {
  const output = readToMarkdownOutput(raw)
  if (!output) return raw
  const markdown = await readFile(output.path, 'utf-8').catch((error) => {
    logger.warn('Failed to inline converted document for coco', error as Error)
    return null
  })
  if (markdown == null) return raw
  const text = markdown.slice(0, COCO_DOCUMENT_INLINE_CHARS)
  const truncated = markdown.length > text.length
  return {
    ...output,
    text,
    truncated,
    ...(truncated
      ? {
          note: `只内联了前 ${text.length} 个字符（共 ${markdown.length} 个）。本会话无法继续分页读取，需要后续内容请告知用户。`
        }
      : {})
  }
}
