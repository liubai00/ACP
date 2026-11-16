import { Skeleton } from '@/components/ui/skeleton'

export function PageSkeleton() {
  return (
    <div role="status" aria-label="页面加载中" className="flex flex-1 flex-col gap-4 px-4 pt-2 pb-4 md:px-6 md:pt-4">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  )
}
