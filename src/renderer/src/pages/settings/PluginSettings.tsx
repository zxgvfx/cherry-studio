import Scrollbar from '@renderer/components/Scrollbar'
import NativePluginsList from '@renderer/components/PluginMarketplace/NativePluginsList'
import type { FC } from 'react'
import styled from 'styled-components'

const PluginSettings: FC = () => {
  return (
    <Container>
      <NativePluginsList />
    </Container>
  )
}

const Container = styled(Scrollbar)`
  display: flex;
  flex-direction: column;
  flex: 1;
  padding: 20px;
  gap: 16px;
`

export default PluginSettings
