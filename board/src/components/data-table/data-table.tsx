import { flexRender, type Table as TanstackTable } from '@tanstack/react-table'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /** 列名（列显示菜单里用） */
    label?: string
    /** 单元格与表头的额外 class */
    className?: string
  }
}

/**
 * 数据表格外壳：表头吸顶、横向可滚动、整行可点击。
 * 视觉沿用 kiranism dashboard 的 DataTable（rounded-lg border、bg-muted 表头）。
 */
export function DataTable<TData>({
  table,
  onRowClick,
  loading = false,
  emptyText = '没有符合条件的数据',
  toolbar,
  footer,
  className,
  rowClassName,
  skeletonRows = 8,
}: {
  table: TanstackTable<TData>
  onRowClick?: (row: TData) => void
  loading?: boolean
  emptyText?: ReactNode
  toolbar?: ReactNode
  footer?: ReactNode
  className?: string
  rowClassName?: (row: TData) => string | undefined
  skeletonRows?: number
}) {
  const rows = table.getRowModel().rows
  const columnCount = table.getVisibleLeafColumns().length || 1

  return (
    <div data-slot="data-table" className={cn('flex min-w-0 flex-col gap-4', className)}>
      {toolbar}
      <div className="overflow-hidden rounded-lg border">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted">
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      className={cn('whitespace-nowrap', header.column.columnDef.meta?.className)}
                      style={header.column.columnDef.size && header.column.columnDef.size !== 150 ? { width: header.getSize() } : undefined}
                    >
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 ? (
                Array.from({ length: skeletonRows }, (_, i) => (
                  <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                    {table.getVisibleLeafColumns().map((col) => (
                      <TableCell key={col.id} className={col.columnDef.meta?.className}>
                        <Skeleton className="h-5 w-full max-w-40" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columnCount} className="h-28 text-center text-muted-foreground">
                    {emptyText}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() ? 'selected' : undefined}
                    className={cn(onRowClick && 'cursor-pointer', loading && 'opacity-60', rowClassName?.(row.original))}
                    onClick={
                      onRowClick
                        ? (e) => {
                            // 点到行内的链接/按钮时不触发整行跳转
                            if ((e.target as HTMLElement).closest('a,button,[role=menuitem],input,label')) return
                            onRowClick(row.original)
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      {footer}
    </div>
  )
}
