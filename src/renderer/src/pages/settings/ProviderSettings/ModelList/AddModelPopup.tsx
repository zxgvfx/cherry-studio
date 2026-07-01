import { TopView } from '@renderer/components/TopView'
import { endpointTypeOptions } from '@renderer/config/endpointTypes'
import { isNotSupportTextDeltaModel } from '@renderer/config/models'
import { useDynamicLabelWidth } from '@renderer/hooks/useDynamicLabelWidth'
import { useProvider } from '@renderer/hooks/useProvider'
import type { EndpointType, Model, Provider } from '@renderer/types'
import { getDefaultGroupName } from '@renderer/utils'
import { isEndpointTypeConfigurableProvider } from '@renderer/utils/provider'
import type { FormProps } from 'antd'
import { Button, Flex, Form, Input, Modal, Select } from 'antd'
import { find } from 'lodash'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ShowParams {
  title: string
  provider: Provider
}

interface Props extends ShowParams {
  resolve: (data: any) => void
}

type FieldType = {
  provider: string
  id: string
  name?: string
  group?: string
  endpointType?: EndpointType
}

const PopupContainer: React.FC<Props> = ({ title, provider, resolve }) => {
  const [open, setOpen] = useState(true)
  const [form] = Form.useForm()
  const { addModel, models } = useProvider(provider.id)
  const { t } = useTranslation()
  const canConfigureEndpointType = isEndpointTypeConfigurableProvider(provider)
  const labelWidth = useDynamicLabelWidth([
    t('settings.models.add.model_id.label'),
    t('settings.models.add.endpoint_type.label')
  ])
  const endpointOptions = useMemo(
    () =>
      endpointTypeOptions.filter((opt) => {
        if (provider.type === 'openai' || provider.type === 'azure-openai') {
          return opt.value === 'openai' || opt.value === 'image-generation'
        }
        return true
      }),
    [provider.type]
  )

  const onOk = () => {
    setOpen(false)
  }

  const onCancel = () => {
    setOpen(false)
  }

  const onClose = () => {
    resolve({})
  }

  const onAddModel = (values: FieldType) => {
    const id = values.id.trim()

    if (find(models, { id })) {
      window.toast.error(t('error.model.exists'))
      return
    }

    const model: Model = {
      id,
      provider: provider.id,
      name: values.name ? values.name : id.toUpperCase(),
      group: values.group ?? getDefaultGroupName(id),
      endpoint_type: canConfigureEndpointType ? values.endpointType : undefined
    }

    addModel({ ...model, supported_text_delta: !isNotSupportTextDeltaModel(model) })

    return true
  }

  const onFinish: FormProps<FieldType>['onFinish'] = (values) => {
    const id = values.id.trim().replaceAll('，', ',')

    if (id.includes(',')) {
      const ids = id.split(',')
      ids.forEach((id) => onAddModel({ ...values, id, name: id } as FieldType))
      resolve({})
      return
    }

    if (onAddModel(values)) {
      resolve({})
    }
  }

  return (
    <Modal
      title={title}
      open={open}
      onOk={onOk}
      onCancel={onCancel}
      maskClosable={false}
      afterClose={onClose}
      footer={null}
      transitionName="animation-move-down"
      centered>
      <Form
        form={form}
        labelCol={{ flex: canConfigureEndpointType ? labelWidth : '110px' }}
        labelAlign="left"
        colon={false}
        style={{ marginTop: 25 }}
        onFinish={onFinish}
        initialValues={{
          endpointType: 'openai'
        }}>
        <Form.Item
          name="id"
          label={t('settings.models.add.model_id.label')}
          tooltip={t('settings.models.add.model_id.tooltip')}
          rules={[{ required: true }]}>
          <Input
            placeholder={t('settings.models.add.model_id.placeholder')}
            spellCheck={false}
            maxLength={200}
            onChange={(e) => {
              form.setFieldValue('name', e.target.value)
              form.setFieldValue('group', getDefaultGroupName(e.target.value, provider.id))
            }}
          />
        </Form.Item>
        <Form.Item
          name="name"
          label={t('settings.models.add.model_name.label')}
          tooltip={t('settings.models.add.model_name.placeholder')}>
          <Input placeholder={t('settings.models.add.model_name.placeholder')} spellCheck={false} />
        </Form.Item>
        <Form.Item
          name="group"
          label={t('settings.models.add.group_name.label')}
          tooltip={t('settings.models.add.group_name.tooltip')}>
          <Input placeholder={t('settings.models.add.group_name.placeholder')} spellCheck={false} />
        </Form.Item>
        {canConfigureEndpointType && (
          <Form.Item
            name="endpointType"
            label={t('settings.models.add.endpoint_type.label')}
            tooltip={t('settings.models.add.endpoint_type.tooltip')}
            rules={[{ required: true, message: t('settings.models.add.endpoint_type.required') }]}>
            <Select placeholder={t('settings.models.add.endpoint_type.placeholder')}>
              {endpointOptions.map((opt) => (
                <Select.Option key={opt.value} value={opt.value}>
                  {t(opt.label)}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        )}
        <Form.Item style={{ marginBottom: 8, textAlign: 'center' }}>
          <Flex justify="end" align="center" style={{ position: 'relative' }}>
            <Button type="primary" htmlType="submit" size="middle">
              {t('settings.models.add.add_model')}
            </Button>
          </Flex>
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default class AddModelPopup {
  static topviewId = 0
  static hide() {
    TopView.hide('AddModelPopup')
  }
  static show(props: ShowParams) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          {...props}
          resolve={(v) => {
            resolve(v)
            this.hide()
          }}
        />,
        'AddModelPopup'
      )
    })
  }
}
