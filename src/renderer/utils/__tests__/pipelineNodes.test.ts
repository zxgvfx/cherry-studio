import { describe, expect, it } from 'vitest'

import {
  buildPipelineModelPresets,
  classifyPipelineNode,
  collectPipelineNodeFilterTags,
  findPipelineImageModelChoice,
  getPipelineNodeFormFields,
  groupCherryImageModelsForPipelinePresets,
  groupPipelineNodesByCategory,
  normalizePipelineNodeCatalogItem,
  parseLooseJsonObject,
  parsePipelineNodePrompt,
  parsePipelineNodeQuery,
  pickFeaturedPipelinePresets,
  pipelineAssetFileUrl,
  pipelineImageModelChoices,
  pipelineNodeToComposerToken,
  pipelinePresetSlashQuickPanelFields,
  pipelineSlashQuickPanelFields,
  resolvePipelineNodeIdForAttachments,
  serializePipelineNodePrompt
} from '../pipelineNodes'

const textToImage = normalizePipelineNodeCatalogItem({
  node_id: 'model.text-to-image',
  name: '文生图',
  description: '根据文本 prompt 生成图片',
  tags: ['model', 'image'],
  input_ports: [
    {
      name: 'prompt',
      direction: 'input',
      asset_type: 'data/text',
      required: true,
      description: '生成提示词',
      tags: ['prompt', 'primary']
    }
  ],
  output_ports: [],
  config_schema: [
    {
      name: 'model',
      type: 'string',
      required: false,
      default: '',
      description: '模型',
      label: '模型',
      group: 'model',
      placeholder: '',
      secret: false,
      multiline: false,
      advanced: false,
      options: [],
      surface: true
    },
    {
      name: 'size',
      type: 'string',
      required: false,
      default: '1024x1024',
      description: '尺寸',
      label: '尺寸',
      group: 'generation',
      placeholder: '',
      secret: false,
      multiline: false,
      advanced: false,
      options: ['1024x1024', '1024x1536'],
      surface: true
    },
    {
      name: 'api_key',
      type: 'string',
      required: false,
      default: '',
      description: '密钥',
      label: 'API Key',
      group: 'connection',
      placeholder: '',
      secret: true,
      multiline: false,
      advanced: false,
      options: [],
      surface: false
    }
  ]
})!

describe('pipelineNodes', () => {
  it('switches text-to-image to image-to-image when an image is attached', () => {
    expect(resolvePipelineNodeIdForAttachments('model.text-to-image', true)).toBe('model.image-to-image')
    expect(resolvePipelineNodeIdForAttachments('model.text-to-image', false)).toBe('model.text-to-image')
    expect(resolvePipelineNodeIdForAttachments('workflow.custom', true)).toBe('workflow.custom')
  })

  it('serializes slash tokens without empty values', () => {
    expect(serializePipelineNodePrompt('model.text-to-image', {})).toBe('/model.text-to-image')
    expect(
      serializePipelineNodePrompt('model.text-to-image', {
        model: 'gpt-image-2@alt',
        size: '1024x1024',
        prompt: '生成一个小猫咪抓老鼠的图片'
      })
    ).toBe('/model.text-to-image{"model":"gpt-image-2@alt","size":"1024x1024","prompt":"生成一个小猫咪抓老鼠的图片"}')
  })

  it('parses the user slash form with chinese quotes and semicolons', () => {
    const parsed = parsePipelineNodePrompt(
      '/model.text-to-image{"model":"gpt-image-2@alt";"size":"1024×1024";“prompt”:“生成一个小猫咪抓老鼠的图片”}'
    )
    expect(parsed).toEqual({
      nodeId: 'model.text-to-image',
      values: {
        model: 'gpt-image-2@alt',
        size: '1024x1024',
        prompt: '生成一个小猫咪抓老鼠的图片'
      }
    })
  })

  it('parses leftover json from the slash query', () => {
    expect(parsePipelineNodeQuery('model.text-to-image{"prompt":"cat"}', 'model.text-to-image')).toEqual({
      prompt: 'cat'
    })
    expect(parseLooseJsonObject('{foo:1}')).toEqual({ foo: 1 })
  })

  it('builds a composer token whose promptText is the slash form', () => {
    const token = pipelineNodeToComposerToken(textToImage, { prompt: '一只猫' })
    expect(token.kind).toBe('pipelineNode')
    expect(token.label).toBe('/model.text-to-image')
    expect(token.promptText).toBe('/model.text-to-image{"prompt":"一只猫"}')
    expect(token.payload).toEqual({ nodeId: 'model.text-to-image', values: { prompt: '一只猫' } })
  })

  it('puts the Chinese title first and the slash command second in the / picker', () => {
    expect(
      pipelineSlashQuickPanelFields({
        node_id: 'workflow.pixal3d',
        name: '图生3D',
        description: '从图片生成 3D 模型'
      })
    ).toEqual({
      label: '图生3D',
      description: '/workflow.pixal3d',
      slashId: '/workflow.pixal3d'
    })
    expect(
      pipelinePresetSlashQuickPanelFields({
        displayName: '文生图 · Nano Banana Pro',
        slashId: '/model.text-to-image.nano-banana-pro'
      })
    ).toEqual({
      label: '文生图 · Nano Banana Pro',
      description: '/model.text-to-image.nano-banana-pro'
    })
  })

  it('builds a pipeline asset file URL for image previews', () => {
    expect(pipelineAssetFileUrl('2a6f2ead-5659-4322-b097-57bf5d640b74')).toBe(
      'http://192.168.21.225:9331/api/assets/2a6f2ead-5659-4322-b097-57bf5d640b74/file'
    )
  })

  it('exposes prompt and surface knobs but hides secrets', () => {
    const fields = getPipelineNodeFormFields(textToImage)
    expect(fields.map((field) => field.key)).toEqual(['prompt', 'model', 'size'])
    expect(fields[0]).toMatchObject({ kind: 'port', required: true, multiline: true })
  })

  it('classifies nodes by function instead of dumping them into one list', () => {
    expect(classifyPipelineNode(textToImage)).toBe('image')
    expect(classifyPipelineNode({ node_id: 'workflow.pixal3d', name: '图生3D', tags: ['workflow'] })).toBe('workflow')
    expect(classifyPipelineNode({ node_id: 'sam3.gen3d', name: '生成 3D', tags: ['3d-generation'] })).toBe('3d')
    expect(classifyPipelineNode({ node_id: 'sam3.segment-web', name: '分割', tags: ['segmentation', 'sam3'] })).toBe(
      'segmentation'
    )
    expect(classifyPipelineNode({ node_id: 'kimodo.web', name: '动作绑定', tags: ['kimodo', 'motion'] })).toBe('motion')
    expect(classifyPipelineNode({ node_id: 'io.load-image', name: '加载图片', tags: ['io', 'image'] })).toBe('io')
    expect(classifyPipelineNode({ node_id: 'io.save-asset', name: '保存资产', tags: ['io', 'sink'] })).toBe('io')
    expect(classifyPipelineNode({ node_id: 'image.resize', name: '缩放', tags: ['image', 'preprocess'] })).toBe('image')
    expect(classifyPipelineNode({ node_id: 'human.approve', name: '审批', tags: ['human-in-the-loop'] })).toBe(
      'interactive'
    )
    expect(classifyPipelineNode({ node_id: 'model.chat', name: '对话', tags: ['model'] })).toBe('model')
    expect(classifyPipelineNode({ node_id: 'data.set', name: '设值', tags: ['data'] })).toBe('data')
  })

  it('groups catalog items in category order and skips empty buckets', () => {
    const groups = groupPipelineNodesByCategory([
      textToImage,
      normalizePipelineNodeCatalogItem({
        node_id: 'workflow.pixal3d',
        name: '图生3D',
        description: '',
        tags: ['workflow'],
        input_ports: [],
        output_ports: [],
        config_schema: []
      })!,
      normalizePipelineNodeCatalogItem({
        node_id: 'sam3.gen3d',
        name: '生成 3D',
        description: '',
        tags: ['3d-generation'],
        input_ports: [],
        output_ports: [],
        config_schema: []
      })!
    ])
    expect(groups.map((group) => group.category)).toEqual(['image', '3d', 'workflow'])
    expect(groups[0].nodes.map((node) => node.node_id)).toEqual(['model.text-to-image'])
  })

  it('collects filterable node tags by frequency and hides widget/port noise', () => {
    const tags = collectPipelineNodeFilterTags([
      textToImage,
      normalizePipelineNodeCatalogItem({
        node_id: 'sam3.gen3d',
        name: '生成 3D',
        description: '',
        tags: ['3d-generation', 'sam3', 'api', 'widget:preview'],
        input_ports: [],
        output_ports: [],
        config_schema: []
      })!,
      normalizePipelineNodeCatalogItem({
        node_id: 'sam3.segment-web',
        name: '分割',
        description: '',
        tags: ['segmentation', 'sam3', 'primary'],
        input_ports: [],
        output_ports: [],
        config_schema: []
      })!
    ])
    expect(tags.map((item) => item.tag)).toEqual(['sam3', '3d-generation', 'image', 'model', 'segmentation'])
    expect(tags[0]).toMatchObject({ tag: 'sam3', count: 2 })
  })

  it('builds slash presets from provider image models without creating fake nodes', () => {
    const presets = buildPipelineModelPresets([
      {
        id: 'coco-rightcode',
        name: 'RightCode',
        enabled: true,
        imageModels: ['nano-banana-pro@rc', 'gpt-image-2@rc', 'gpt-image-2-vip@rc']
      },
      {
        id: 'coco-atl',
        name: 'Atl',
        enabled: true,
        imageModels: ['nano-banana-pro@atl']
      }
    ])
    expect(presets.map((preset) => preset.slashId)).toEqual([
      '/model.text-to-image.nano-banana-pro',
      '/model.text-to-image.gpt-image-2',
      '/model.text-to-image.gpt-image-2-vip',
      '/model.text-to-image.nano-banana-pro-atl'
    ])
    expect(presets[0]).toMatchObject({
      nodeId: 'model.text-to-image',
      displayName: '文生图 · nano banana pro · RightCode',
      model: 'nano-banana-pro@rc',
      providerId: 'coco-rightcode',
      featured: true
    })
    expect(pickFeaturedPipelinePresets(presets).map((preset) => preset.alias)).toEqual([
      'nano-banana-pro',
      'gpt-image-2',
      'gpt-image-2-vip'
    ])
    expect(
      serializePipelineNodePrompt(presets[0].nodeId, {
        model: presets[0].model,
        provider_id: presets[0].providerId
      })
    ).toBe('/model.text-to-image{"model":"nano-banana-pro@rc","provider_id":"coco-rightcode"}')
  })

  it('skips disabled providers when building slash presets', () => {
    const presets = buildPipelineModelPresets([
      {
        id: 'coco-rightcode',
        name: 'RightCode',
        enabled: false,
        imageModels: ['nano-banana-pro@rc']
      },
      {
        id: 'coco-vapi',
        name: 'VAPI',
        enabled: true,
        imageModels: ['nano-banana-pro@vapi', 'gpt-image-2@vapi']
      }
    ])
    expect(presets.map((preset) => preset.slashId)).toEqual([
      '/model.text-to-image.nano-banana-pro',
      '/model.text-to-image.gpt-image-2',
      '/model.image-to-image.nano-banana-pro',
      '/model.image-to-image.gpt-image-2'
    ])
    expect(presets.map((preset) => preset.displayName)).toEqual([
      '文生图 · nano banana pro',
      '文生图 · gpt image 2',
      '图生图 · nano banana pro',
      '图生图 · gpt image 2'
    ])
    expect(presets.every((preset) => preset.providerId === 'coco-vapi')).toBe(true)
    expect(presets.filter((preset) => preset.nodeId === 'model.image-to-image')).toEqual([
      expect.objectContaining({ model: 'nano-banana-pro@vapi', values: { size: 'auto' } }),
      expect.objectContaining({ model: 'gpt-image-2@vapi', values: { size: 'auto' } })
    ])
  })

  it('builds presets from Cherry image-generation models so new gpt-image-2.5 ids appear automatically', () => {
    const catalog = groupCherryImageModelsForPipelinePresets(
      [{ id: 'coco-vapi', name: 'VAPI', enabled: true }],
      [
        { providerId: 'coco-vapi', modelId: 'nano-banana-pro@vapi' },
        { providerId: 'coco-vapi', modelId: 'gpt-image-2@vapi' },
        { providerId: 'coco-vapi', modelId: 'gpt-image-2.5-flare@vapi' },
        { providerId: 'coco-vapi', modelId: 'gpt-image-2.5-sunburst@vapi' }
      ]
    )
    const presets = buildPipelineModelPresets(catalog)
    expect(presets.map((preset) => preset.slashId)).toEqual([
      '/model.text-to-image.nano-banana-pro',
      '/model.text-to-image.gpt-image-2',
      '/model.text-to-image.gpt-image-2-5-flare',
      '/model.text-to-image.gpt-image-2-5-sunburst',
      '/model.image-to-image.nano-banana-pro',
      '/model.image-to-image.gpt-image-2',
      '/model.image-to-image.gpt-image-2-5-flare',
      '/model.image-to-image.gpt-image-2-5-sunburst'
    ])
    expect(pickFeaturedPipelinePresets(presets).map((preset) => preset.alias)).toEqual([
      'nano-banana-pro',
      'gpt-image-2',
      'gpt-image-2-5-flare',
      'gpt-image-2-5-sunburst'
    ])
    expect(presets.filter((preset) => preset.model === 'gpt-image-2.5-flare@vapi')).toEqual([
      expect.objectContaining({
        nodeId: 'model.text-to-image',
        providerId: 'coco-vapi',
        featured: true
      }),
      expect.objectContaining({
        nodeId: 'model.image-to-image',
        model: 'gpt-image-2.5-flare@vapi',
        values: { size: 'auto' }
      })
    ])
    expect(pipelineImageModelChoices(presets, 'model.text-to-image').map((choice) => choice.label)).toEqual([
      'nano-banana-pro@vapi',
      'gpt-image-2@vapi',
      'gpt-image-2.5-flare@vapi',
      'gpt-image-2.5-sunburst@vapi'
    ])
    expect(
      findPipelineImageModelChoice(
        pipelineImageModelChoices(presets, 'model.text-to-image'),
        'gpt-image-2.5-sunburst@vapi',
        'coco-vapi'
      )
    ).toMatchObject({
      model: 'gpt-image-2.5-sunburst@vapi',
      providerId: 'coco-vapi'
    })
  })
})
