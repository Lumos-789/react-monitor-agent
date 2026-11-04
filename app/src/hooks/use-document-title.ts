import { useEffect } from 'react'

const DEFAULT_TITLE = 'React Monitor Agent'

/** 浏览器 tab 标出当前工程;离开恢复默认(操作板无单一工程,保持默认) */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ?? DEFAULT_TITLE
    return () => {
      document.title = DEFAULT_TITLE
    }
  }, [title])
}
