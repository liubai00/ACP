import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** 服务端分页条（page 从 1 开始，与契约一致） */
export function DataTablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 30, 50, 100],
  className,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (size: number) => void
  pageSizeOptions?: number[]
  className?: string
}) {
  const labelId = useId()
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const canPrev = page > 1
  const canNext = page < pageCount
  const sizeItems = pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))

  return (
    <div className={cn('flex w-full flex-wrap items-center justify-between gap-2 p-1 sm:gap-8', className)}>
      <div role="status" className="text-sm whitespace-nowrap text-muted-foreground">
        共 {total} 条
      </div>
      <div className="flex items-center gap-2 sm:gap-6 lg:gap-8">
        {onPageSizeChange && (
          <div className="hidden items-center gap-2 sm:flex">
            <p id={labelId} className="text-sm font-medium whitespace-nowrap">
              每页
            </p>
            <Select items={sizeItems} value={String(pageSize)} onValueChange={(v) => v && onPageSizeChange(Number(v))}>
              <SelectTrigger aria-labelledby={labelId} className="h-8 w-18">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                <SelectGroup>
                  {sizeItems.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}
        <div role="status" className="text-sm font-medium whitespace-nowrap">
          第 {Math.min(page, pageCount)} / {pageCount} 页
        </div>
        <div className="flex items-center gap-1">
          <Button aria-label="第一页" variant="outline" size="icon" className="hidden size-8 lg:flex" onClick={() => onPageChange(1)} disabled={!canPrev}>
            <ChevronsLeft />
          </Button>
          <Button aria-label="上一页" variant="outline" size="icon" className="size-8" onClick={() => onPageChange(page - 1)} disabled={!canPrev}>
            <ChevronLeft />
          </Button>
          <Button aria-label="下一页" variant="outline" size="icon" className="size-8" onClick={() => onPageChange(page + 1)} disabled={!canNext}>
            <ChevronRight />
          </Button>
          <Button aria-label="最后一页" variant="outline" size="icon" className="hidden size-8 lg:flex" onClick={() => onPageChange(pageCount)} disabled={!canNext}>
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
