import type { Column } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown, EyeOff, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/** 可排序列头：点击弹出 升序 / 降序 / 隐藏 */
export function DataTableColumnHeader<TData, TValue>({
  column,
  label,
  className,
}: {
  column: Column<TData, TValue>
  label: string
  className?: string
}) {
  if (!column.getCanSort() && !column.getCanHide()) {
    return <div className={cn(className)}>{label}</div>
  }
  const sorted = column.getIsSorted()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          '-ml-1.5 flex h-8 items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent hover:text-accent-foreground focus:ring-1 focus:ring-ring focus:outline-none data-popup-open:bg-accent data-popup-open:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
          className,
        )}
      >
        {label}
        {column.getCanSort() &&
          (sorted === 'desc' ? <ArrowDown /> : sorted === 'asc' ? <ArrowUp /> : <ChevronsUpDown />)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-32">
        {column.getCanSort() && (
          <>
            <DropdownMenuItem onClick={() => column.toggleSorting(false)} className={cn(sorted === 'asc' && 'bg-accent/50')}>
              <ArrowUp />
              升序
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => column.toggleSorting(true)} className={cn(sorted === 'desc' && 'bg-accent/50')}>
              <ArrowDown />
              降序
            </DropdownMenuItem>
            {sorted && (
              <DropdownMenuItem onClick={() => column.clearSorting()}>
                <X />
                取消排序
              </DropdownMenuItem>
            )}
          </>
        )}
        {column.getCanHide() && (
          <>
            {column.getCanSort() && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
              <EyeOff />
              隐藏此列
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
