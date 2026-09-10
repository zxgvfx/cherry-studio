import { describe, expect, it, vi } from 'vitest'

vi.mock('@data/services/AgentService', () => ({
  agentService: { getAgent: vi.fn(), updateAgent: vi.fn() }
}))
vi.mock('@data/dataApiDataChange', () => ({
  notifyDataApiDataChange: vi.fn()
}))

import { extractAttachmentFiles } from '../../agentUserContent'
import {
  formatCocoUserContent,
  guessPipelineAssetType,
  isIncompleteCocoAttachmentInstruction,
  isPromptTextAttachment,
  readPipelineBindings,
  stripCocoContextBlocks
} from '../pipelineClient'

describe('coco session asset send path', () => {
  it('preserves instructions written after an inline session asset token', () => {
    expect(
      stripCocoContextBlocks(
        '[本轮用户附件 textured.glb asset_id=d4150897-f969-4547-aa34-90cee5ecb849] /workflow.tripo3d-segment 用这个带贴图的模型重新分割'
      )
    ).toBe('/workflow.tripo3d-segment 用这个带贴图的模型重新分割')

    expect(
      stripCocoContextBlocks('/workflow.tripo3d-segment 用这个带贴图的模型重新分割\n\n[本轮指定输入]\n- textured.glb')
    ).toBe('/workflow.tripo3d-segment 用这个带贴图的模型重新分割')
    expect(stripCocoContextBlocks('/workflow.tripo3d-segment 重新分割\n\n[本轮用户附件]\n- textured.glb')).toBe(
      '/workflow.tripo3d-segment 重新分割'
    )
  })

  it('keeps an inline session asset token classified as this-turn designated input', () => {
    const content = formatCocoUserContent(
      '[本轮用户附件 textured.glb asset_id=d4150897-f969-4547-aa34-90cee5ecb849] /workflow.tripo3d-segment 用这个带贴图的模型重新分割',
      {
        sessionAssets: [
          {
            assetId: 'd4150897-f969-4547-aa34-90cee5ecb849',
            name: 'textured.glb',
            kind: 'model',
            origin: 'generated',
            caption: '带贴图模型'
          }
        ]
      }
    )

    expect(content).toMatch(
      /^\/workflow\.tripo3d-segment 用这个带贴图的模型重新分割[\s\S]*\[本轮指定输入\][\s\S]*textured\.glb/
    )
    expect(content).not.toContain('[本轮用户附件 textured.glb')
    expect(content).not.toContain('[会话已有文件]')
  })

  it.each([
    '将',
    '把，',
    '请帮我',
    '基于',
    '分析这个文件然后',
    '把模型转换为',
    '生成图片，提示词：',
    'convert this file to',
    'please'
  ])('rejects a syntactically incomplete attachment instruction: %s', (text) => {
    expect(isIncompleteCocoAttachmentInstruction(text)).toBe(true)
  })

  it.each([
    '',
    '三视图',
    '放大',
    '翻译',
    '继续',
    '请分析',
    '处理这张图片',
    '将这个场景生成三视图',
    '把模型转换为 FBX',
    '合并',
    'analyze canvas',
    'use this image as a reference'
  ])('accepts a short but complete attachment instruction: %s', (text) => {
    expect(isIncompleteCocoAttachmentInstruction(text)).toBe(false)
  })

  it('extracts pipelineAssetId from cherry file metadata without a file:// url', () => {
    const files = extractAttachmentFiles({
      id: 'm1',
      sessionId: 'session-1',
      role: 'user',
      data: {
        parts: [
          {
            type: 'file',
            url: 'pipeline-asset://img-1',
            filename: 'shot.png',
            mediaType: 'image/png',
            providerMetadata: { cherry: { pipelineAssetId: 'img-1', fileTokenSourceId: 'coco-asset-img-1' } }
          }
        ]
      },
      status: 'success',
      searchableText: '',
      modelId: null,
      messageSnapshot: null,
      stats: null,
      runtimeResumeToken: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    expect(files).toEqual([
      {
        path: '',
        filename: 'shot.png',
        mediaType: 'image/png',
        pipelineAssetId: 'img-1'
      }
    ])
  })

  it('reads session assets from the pipeline binding cache', () => {
    const bindings = readPipelineBindings({
      coco_pipeline_sessions: {
        'session-1': {
          id: 'pipe-1',
          revision: 2,
          assets: [{ assetId: 'img-1', name: 'shot.png', origin: 'upload' }]
        }
      }
    })
    expect(bindings['session-1']?.id).toBe('pipe-1')
    expect(bindings['session-1']?.assets?.[0]?.assetId).toBe('img-1')
    expect(bindings['session-1']?.assets?.[0]?.caption).toContain('上传')
  })

  it('extracts mp4 file://, data-video, and files/serve URLs', () => {
    const videoPath = 'D:\\tmp\\Download.mp4'
    expect(
      extractAttachmentFiles({
        id: 'm-file',
        sessionId: 'session-1',
        role: 'user',
        data: {
          parts: [
            {
              type: 'file',
              url: 'file:///D:/tmp/Download.mp4',
              filename: 'Download.mp4',
              mediaType: 'video/mp4'
            }
          ]
        },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    ).toEqual([
      expect.objectContaining({
        filename: 'Download.mp4',
        mediaType: 'video/mp4'
      })
    ])

    expect(
      extractAttachmentFiles({
        id: 'm-video',
        sessionId: 'session-1',
        role: 'user',
        data: {
          parts: [{ type: 'data-video', data: { filePath: videoPath } }]
        },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } as never)
    ).toEqual([
      {
        path: videoPath,
        filename: 'Download.mp4',
        mediaType: 'video/mp4'
      }
    ])

    expect(
      extractAttachmentFiles({
        id: 'm-serve',
        sessionId: 'session-1',
        role: 'user',
        data: {
          parts: [
            {
              type: 'file',
              url: `http://127.0.0.1:2333/api/v1/files/serve?path=${encodeURIComponent(videoPath)}`,
              filename: 'Download.mp4',
              mediaType: 'video/mp4'
            }
          ]
        },
        status: 'success',
        searchableText: '',
        modelId: null,
        messageSnapshot: null,
        stats: null,
        runtimeResumeToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    ).toEqual([
      {
        path: videoPath,
        filename: 'Download.mp4',
        mediaType: 'video/mp4'
      }
    ])
  })

  it('guesses video asset types and injects them into the user turn text', () => {
    expect(guessPipelineAssetType('video/mp4', 'Download.mp4')).toBe('media/video')
    expect(guessPipelineAssetType(undefined, 'clip.mov')).toBe('media/video')
    expect(
      formatCocoUserContent('把这个视频转成动画fbx动画控制器', {
        attachments: [{ filename: 'Download.mp4', mediaType: 'video/mp4', assetId: 'vid-1' }],
        priorUserTexts: ['把这个视频转成动画fbx动画控制器']
      })
    ).toContain('asset_id=vid-1')
    expect(
      formatCocoUserContent('@model-img.png 将这个场景生成三视图', {
        sessionAssets: [
          { assetId: 'img-9', name: 'model-img.png', kind: 'image', origin: 'upload', caption: '上传' },
          { assetId: 'old-1', name: 'previous.png', kind: 'image', origin: 'generated', caption: '生图' }
        ]
      })
    ).toMatch(/本轮指定输入[\s\S]*model-img\.png[\s\S]*会话已有文件[\s\S]*previous\.png/)
    expect(
      formatCocoUserContent('继续', {
        attachments: [{ filename: 'Download.mp4', mediaType: 'video/mp4', assetId: 'vid-1' }],
        priorUserTexts: ['把这个视频转成动画fbx动画控制器']
      })
    ).toContain('历史背景，不是本轮指令')
    expect(
      formatCocoUserContent('把这个角色的3视图画出来然后生成模型', {
        attachments: [{ filename: 'hero.png', mediaType: 'image/png', assetId: 'img-1' }],
        priorUserTexts: ['用香蕉2画一个场景，和一个角色']
      })
    ).not.toContain('用香蕉2画一个场景')
    expect(
      formatCocoUserContent('继续', {
        attachments: [{ filename: 'Download.mp4', mediaType: 'video/mp4', assetId: 'vid-1', sizeBytes: 12_582_912 }]
      })
    ).toMatch(/12(\.0)? MB/)
  })

  it('allows the agent to recompose existing canvas nodes for the selected task', () => {
    const options = {
      selectedPipelineNodes: [
        {
          nodeId: 'model.image-to-image',
          values: { model: 'gpt-image-2@vapi', provider_id: 'coco-vapi', size: 'auto' }
        }
      ],
      canvasGraph: {
        nodes: { image: { step_id: 'image', node_id: 'model.image-to-image', config: { model: 'nano' } } },
        edges: []
      }
    }
    const content = formatCocoUserContent('把这个图片转成模型 /workflow.image-to-model', options)
    expect(content).toContain('画布编辑策略：recompose_allowed')
    expect(content).toContain('删除会冲突、重复执行或已经被新能力替代的旧分支')
    expect(content).toContain('失效、额度不足或已被替代的节点必须从脚本删除')
    expect(content).toContain('显式给出的 model、provider_id、size 等是用户锁定的预设')
    expect(content).toContain('禁止依次试跑其它 Provider')
    expect(content).toContain('"model":"gpt-image-2@vapi"')
    expect(content).toContain('禁止用与已有节点完全相同的 config 再跑一遍')
    expect(content).toContain('已有节点但本轮指定了新输入时用 canvas.rewire')
    expect(content).toContain('删失效分支用 canvas.remove')
    expect(content).toContain('没有 stepId 的上传文件用 canvas.bind_input')
    expect(content).toContain('模型文件与 source_task_id 必须来自同一上游纹理步骤')
    expect(content).not.toContain('画布编辑策略：append_only（强制）')
  })

  it('treats typed /workflow refs as selected canvas nodes even without composer tokens', () => {
    const content = formatCocoUserContent('/workflow.tripo3d-segment @textured.glb 用这个带贴图的模型重新分割', {
      sessionAssets: [
        {
          assetId: 'tex-1',
          name: 'textured.glb',
          kind: 'model',
          origin: 'generated',
          caption: '纹理模型'
        }
      ],
      canvasGraph: {
        nodes: {
          gen3d: { step_id: 'gen3d', node_id: 'model.tripo3d', config: { operation: 'image_to_model' } },
          seg: { step_id: 'seg', node_id: 'model.tripo3d', config: { operation: 'segment' } },
          out: { step_id: 'out', node_id: 'io.workflow-output', config: {} }
        },
        edges: [
          {
            source_step: 'gen3d',
            source_port: 'task_id',
            target_step: 'seg',
            target_port: 'source_task_id'
          }
        ]
      }
    })
    expect(content).toContain('[本轮必须执行]')
    expect(content).toContain('用户选择的节点：')
    expect(content).toContain('workflow.tripo3d-segment')
    expect(content).toContain('[本轮指定输入]')
    expect(content).toContain('同一能力已有节点但本轮指定了新输入时用 canvas.rewire')
    expect(content).not.toContain('[本轮画布增量]')
  })

  it('inlines pasted prompt text instead of telling the agent to put an asset id in prompt', () => {
    expect(isPromptTextAttachment({ filename: '已粘贴的文本.txt' })).toBe(true)
    expect(isPromptTextAttachment({ filename: 'Pasted text.txt', composerFileKind: 'pasted-text' })).toBe(true)
    expect(isPromptTextAttachment({ filename: 'shot.png', mediaType: 'image/png' })).toBe(false)

    const content = formatCocoUserContent('使用 /model.text-to-image 生成图片 提示词: 已粘贴的文本.txt', {
      pastedTexts: [
        {
          filename: '已粘贴的文本.txt',
          content: "A photorealistic 3D render of a majestic floating 'Sky Castle'"
        }
      ],
      sessionAssets: [
        {
          assetId: 'b12dedb2-5cb0-4bc4-afc3-759b2fe942ce',
          name: '已粘贴的文本.txt',
          kind: 'other',
          origin: 'upload',
          caption: '上传'
        }
      ]
    })
    expect(content).toContain('[本轮粘贴文本]')
    expect(content).toContain("A photorealistic 3D render of a majestic floating 'Sky Castle'")
    expect(content).toContain('仅当本轮任务就是用这段文字去生成时才原样填入 prompt')
    expect(content).toContain('禁止把 asset_id、文件 UUID 或文件名填进 prompt')
    expect(content).not.toContain('必须原样填入节点的 prompt')
    expect(content).not.toContain('asset_id=')
    expect(content).not.toContain('b12dedb2-5cb0-4bc4-afc3-759b2fe942ce')
  })

  it('treats follow-up canvas tasks as new work instead of rerunning the previous prompt', () => {
    const content = formatCocoUserContent('将这个场景生成三视图', {
      canvasGraph: {
        nodes: {
          gen: {
            step_id: 'gen',
            node_id: 'model.text-to-image',
            config: { prompt: "A photorealistic 3D render of a majestic floating 'Sky Castle'" }
          },
          out: { step_id: 'out', node_id: 'io.workflow-output', config: {} }
        },
        edges: []
      }
    })
    expect(content).toContain('[本轮画布增量]')
    expect(content).toContain('禁止用与已有节点完全相同的 config 再跑一遍')
    expect(content).toContain('本轮必须先查 nodes.list 与 workflows.list')
    expect(content).toContain('先读当前画布脚本，再查 nodes.list 与 workflows.list')
    expect(content).toContain('产出类任务里用户 @ 了文件或带了附件时，那就是节点输入')
    // A canvas that already has nodes used to hijack every later turn into "modify the canvas",
    // so "这张图里有什么" got answered by running an image node.
    expect(content).toContain('不要建画布、不要 submit.graph')
    expect(content).toContain('查完之前禁止改已有生成节点的 prompt')
    expect(content).toContain('唯一匹配就直接用')
    expect(content).toContain('禁止盲猜')
    expect(content).not.toContain('换视角/多视图/改风格/出模型')
    expect(content).not.toContain('画布编辑策略：append_only（强制）')
  })

  it('copies composerFileKind from cherry file metadata', () => {
    const files = extractAttachmentFiles({
      id: 'm-paste',
      sessionId: 'session-1',
      role: 'user',
      data: {
        parts: [
          {
            type: 'file',
            url: 'file:///C:/Temp/cherrystudio/pasted_text.txt',
            filename: '已粘贴的文本.txt',
            mediaType: 'text/plain',
            providerMetadata: { cherry: { composerFileKind: 'pasted-text' } }
          }
        ]
      },
      status: 'success',
      searchableText: '',
      modelId: null,
      messageSnapshot: null,
      stats: null,
      runtimeResumeToken: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    expect(files[0]?.composerFileKind).toBe('pasted-text')
    expect(isPromptTextAttachment(files[0]!)).toBe(true)
  })

  it('injects dcc context as a compact scene block', () => {
    const text = formatCocoUserContent('把这个模型放大', {
      dccContext: {
        dcc: 'houdini',
        dccVersion: '20.5',
        hipFile: 'shot.hip',
        currentNetwork: '/obj/geo1',
        selectedNodes: [{ path: '/obj/geo1' }]
      }
    })
    expect(text).toContain('[DCC 当前场景]')
    expect(text).toContain('houdini 20.5')
    expect(text).toContain('/obj/geo1')
  })
})
