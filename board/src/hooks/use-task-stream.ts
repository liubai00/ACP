import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { subscribeTaskStream } from '@/lib/api'
import { qk } from '@/lib/queries'
import type { TaskDetail, TimelineItem } from '@/types/api'

export type StreamStatus = 'connecting' | 'live' | 'reconnecting'

/** 把时间线条目并入缓存的任务详情（按 id 去重，保持时间升序） */
export function mergeTimeline(task: TaskDetail, item: TimelineItem): TaskDetail {
  if (task.timeline.some((t) => t.id === item.id)) return task
  const timeline = [...task.timeline, item].sort((a, b) => a.at.localeCompare(b.at))
  return { ...task, timeline, updated_at: item.at > task.updated_at ? item.at : task.updated_at }
}

/**
 * 订阅 /api/tasks/{id}/stream：
 * - timeline 事件直接追加到时间线
 * - task 事件合并摘要字段，并在短暂静默后重新拉取详情（allowed_actions、MR、审批等不在摘要里）
 */
export function useTaskStream(taskId: number, enabled: boolean): StreamStatus {
  const client = useQueryClient()
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!enabled) return
    const key = qk.task(taskId)
    const unsubscribe = subscribeTaskStream(taskId, {
      onOpen: () => setStatus('live'),
      onError: () => setStatus('reconnecting'),
      onTimeline: (item) => {
        setStatus('live')
        client.setQueryData<TaskDetail>(key, (prev) => (prev ? mergeTimeline(prev, item) : prev))
      },
      onTask: (summary) => {
        setStatus('live')
        client.setQueryData<TaskDetail>(key, (prev) => (prev ? { ...prev, ...summary } : prev))
        clearTimeout(refetchTimer.current)
        refetchTimer.current = setTimeout(() => {
          void client.invalidateQueries({ queryKey: key })
          void client.invalidateQueries({ queryKey: qk.tasksAll })
        }, 800)
      },
    })
    return () => {
      clearTimeout(refetchTimer.current)
      unsubscribe()
      setStatus('connecting')
    }
  }, [client, taskId, enabled])

  return status
}
