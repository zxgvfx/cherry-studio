import { ErrorBoundary as ReactErrorBoundary, type ErrorBoundaryProps, type FallbackProps } from 'react-error-boundary'
import type { ReactNode, ReactElement } from 'react'

// 兼容旧版本的 ErrorBoundary 使用方式
function ErrorBoundaryWrapper(props: Partial<ErrorBoundaryProps> & { children: ReactNode; fallbackComponent?: (props: FallbackProps) => ReactElement }) {
  const { children, fallbackComponent, ...rest } = props
  
  // 如果没有提供 fallback 相关属性，使用默认的
  const fallbackRender = rest.fallbackRender || rest.FallbackComponent || fallbackComponent || (({ error }: FallbackProps) => (
    <div style={{ padding: '20px' }}>
      <h3>Something went wrong</h3>
      <pre>{error?.message}</pre>
    </div>
  ))
  
  return (
    <ReactErrorBoundary fallbackRender={fallbackRender as any} {...rest}>
      {children}
    </ReactErrorBoundary>
  )
}

export { ErrorBoundaryWrapper as ErrorBoundary }
export default ErrorBoundaryWrapper
