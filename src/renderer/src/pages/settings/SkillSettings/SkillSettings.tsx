import { ExclamationCircleOutlined } from '@ant-design/icons'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addSkill, removeSkill, updateSkill, toggleSkill, selectAllSkills } from '@renderer/store/skills'
import type { SkillConfig } from '@renderer/types'
import { Button, Empty, Flex, Input, Modal, Popconfirm, Radio, Space, Switch } from 'antd'
import { PlusIcon } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { v4 as uuid } from 'uuid'

import { SettingContainer, SettingDivider, SettingGroup, SettingTitle } from '..'

const { TextArea } = Input

interface SkillFormData {
  name: string
  description: string
  content: string
  filePath: string
  sourceType: 'inline' | 'file'
}

const defaultFormData: SkillFormData = {
  name: '',
  description: '',
  content: '',
  filePath: '',
  sourceType: 'inline'
}

const SkillSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useAppDispatch()
  const skills = useAppSelector(selectAllSkills)

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<SkillConfig | null>(null)
  const [formData, setFormData] = useState<SkillFormData>(defaultFormData)

  const handleAdd = () => {
    setEditingSkill(null)
    setFormData(defaultFormData)
    setIsModalOpen(true)
  }

  const handleEdit = (skill: SkillConfig) => {
    setEditingSkill(skill)
    setFormData({
      name: skill.name,
      description: skill.description,
      content: skill.content || '',
      filePath: skill.filePath || '',
      sourceType: skill.filePath ? 'file' : 'inline'
    })
    setIsModalOpen(true)
  }

  const handleDelete = (id: string) => {
    dispatch(removeSkill(id))
  }

  const handleToggle = (id: string) => {
    dispatch(toggleSkill(id))
  }

  const handleModalOk = () => {
    if (!formData.name.trim() || !formData.description.trim()) {
      return
    }

    const skillData: SkillConfig = {
      id: editingSkill?.id || uuid(),
      name: formData.name.trim(),
      description: formData.description.trim(),
      content: formData.sourceType === 'inline' ? formData.content : undefined,
      filePath: formData.sourceType === 'file' ? formData.filePath : undefined,
      enabled: editingSkill?.enabled ?? true
    }

    if (editingSkill) {
      dispatch(updateSkill(skillData))
    } else {
      dispatch(addSkill(skillData))
    }
    setIsModalOpen(false)
  }

  const handleSelectFile = async () => {
    const files = await window.api.file.select({
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]
    })
    if (files && files.length > 0) {
      setFormData({ ...formData, filePath: files[0].path })
    }
  }

  return (
    <SettingContainer theme={theme}>
      <SettingGroup style={{ marginBottom: 0 }} theme={theme}>
        <SettingTitle>
          {t('settings.skills.title')}
          <Button type="text" icon={<PlusIcon size={18} />} onClick={handleAdd} />
        </SettingTitle>
        <SettingDivider />
        <SkillList>
          {skills.length === 0 ? (
            <Empty description={t('settings.skills.empty')} style={{ marginTop: 40 }} />
          ) : (
            skills.map((skill) => (
              <SkillItem key={skill.id}>
                <SkillInfo>
                  <SkillName>{skill.name}</SkillName>
                  <SkillDesc>{skill.description}</SkillDesc>
                </SkillInfo>
                <Flex gap={8} align="center">
                  <Switch size="small" checked={skill.enabled} onChange={() => handleToggle(skill.id)} />
                  <Button type="text" icon={<EditIcon size={14} />} onClick={() => handleEdit(skill)} />
                  <Popconfirm
                    title={t('settings.skills.delete')}
                    description={t('settings.skills.deleteConfirm')}
                    okText={t('common.confirm')}
                    cancelText={t('common.cancel')}
                    onConfirm={() => handleDelete(skill.id)}
                    icon={<ExclamationCircleOutlined style={{ color: 'red' }} />}>
                    <Button type="text" danger icon={<DeleteIcon size={14} className="lucide-custom" />} />
                  </Popconfirm>
                </Flex>
              </SkillItem>
            ))
          )}
        </SkillList>
      </SettingGroup>

      <Modal
        title={editingSkill ? t('settings.skills.edit') : t('settings.skills.add')}
        open={isModalOpen}
        onOk={handleModalOk}
        onCancel={() => setIsModalOpen(false)}
        width={560}
        transitionName="animation-move-down"
        centered
        maskClosable={false}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Label>{t('settings.skills.nameLabel')}</Label>
            <Input
              placeholder={t('settings.skills.namePlaceholder')}
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('settings.skills.descriptionLabel')}</Label>
            <Input
              placeholder={t('settings.skills.descriptionPlaceholder')}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('settings.skills.sourceLabel')}</Label>
            <Radio.Group
              value={formData.sourceType}
              onChange={(e) => setFormData({ ...formData, sourceType: e.target.value })}>
              <Radio value="inline">{t('settings.skills.sourceInline')}</Radio>
              <Radio value="file">{t('settings.skills.sourceFile')}</Radio>
            </Radio.Group>
          </div>
          {formData.sourceType === 'inline' ? (
            <div>
              <Label>{t('settings.skills.contentLabel')}</Label>
              <TextArea
                placeholder={t('settings.skills.contentPlaceholder')}
                value={formData.content}
                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                rows={8}
                style={{ resize: 'vertical', fontFamily: 'monospace' }}
              />
            </div>
          ) : (
            <div>
              <Label>{t('settings.skills.filePathLabel')}</Label>
              <Flex gap={8}>
                <Input
                  placeholder={t('settings.skills.filePathPlaceholder')}
                  value={formData.filePath}
                  onChange={(e) => setFormData({ ...formData, filePath: e.target.value })}
                  style={{ flex: 1 }}
                />
                <Button onClick={handleSelectFile}>{t('settings.skills.selectFile')}</Button>
              </Flex>
            </div>
          )}
        </Space>
      </Modal>
    </SettingContainer>
  )
}

const Label = styled.div`
  font-size: 14px;
  color: var(--color-text);
  margin-bottom: 8px;
`

const SkillList = styled.div`
  width: 100%;
  height: calc(100vh - 162px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 5px;
`

const SkillItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: var(--list-item-border-radius);
  border: 0.5px solid var(--color-border);
  background: var(--color-background-soft);
  transition: all 0.2s ease;
  &:hover {
    border-color: var(--color-primary);
  }
`

const SkillInfo = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
`

const SkillName = styled.div`
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const SkillDesc = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

export default SkillSettings
