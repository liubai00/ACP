import { useMemo } from 'react'
import { useAgents, useOverview } from '@/lib/queries'

/** 已知仓库列表：来自总览的按仓库统计和 Agent 声明的仓库 */
export function useRepoOptions(demo = false): string[] {
  const overview = useOverview(14, demo)
  const agents = useAgents()
  return useMemo(() => {
    const set = new Set<string>()
    overview.data?.by_repo.forEach((r) => set.add(r.repo))
    agents.data?.items.forEach((a) => a.repos.forEach((r) => set.add(r)))
    return [...set].sort()
  }, [overview.data, agents.data])
}
