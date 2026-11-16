import { CirclePlus, CircleX } from 'lucide-react'
import type { ComponentType, MouseEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

export interface FilterOption {
  label: string
  value: string
  icon?: ComponentType<{ className?: string }>
  count?: number
}

/**
 * 分面筛选（虚线按钮 + 下拉勾选），样式与 kiranism dashboard 的 DataTableFacetedFilter 一致。
 * multiple=false 时为单选（后端该参数只接受一个值）。
 */
export function DataTableFacetedFilter({
  title,
  options,
  selected,
  onChange,
  multiple = true,
  className,
}: {
  title: string
  options: FilterOption[]
  selected: string[]
  onChange: (values: string[]) => void
  multiple?: boolean
  className?: string
}) {
  const selectedSet = new Set(selected)
  const hasSelection = selected.length > 0

  const toggle = (value: string) => {
    if (multiple) {
      const next = new Set(selectedSet)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      onChange(options.map((o) => o.value).filter((v) => next.has(v)))
    } else {
      onChange(selectedSet.has(value) ? [] : [value])
    }
  }

  const reset = (e?: MouseEvent) => {
    e?.stopPropagation()
    e?.preventDefault()
    onChange([])
  }

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" className={cn('border-dashed', className)} />}>
        {hasSelection ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`清除${title}筛选`}
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
            onClick={reset}
          >
            <CircleX />
          </span>
        ) : (
          <CirclePlus />
        )}
        {title}
        {hasSelection && (
          <>
            <Separator orientation="vertical" className="mx-0.5 data-vertical:h-4 data-vertical:self-center" />
            <span className="flex items-center gap-1">
              {selected.length > 2 ? (
                <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                  已选 {selected.length} 项
                </Badge>
              ) : (
                options
                  .filter((o) => selectedSet.has(o.value))
                  .map((o) => (
                    <Badge key={o.value} variant="secondary" className="max-w-28 rounded-sm px-1 font-normal">
                      <span className="truncate">{o.label}</span>
                    </Badge>
                  ))
              )}
            </span>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList className="max-h-72">
            <CommandEmpty>没有匹配项</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selectedSet.has(option.value)
                return (
                  <CommandItem key={option.value} value={`${option.label} ${option.value}`} onSelect={() => toggle(option.value)}>
                    <Checkbox
                      checked={isSelected}
                      tabIndex={-1}
                      aria-hidden
                      className={cn('pointer-events-none', !multiple && 'rounded-full')}
                    />
                    {option.icon && <option.icon className="size-4 text-muted-foreground" />}
                    <span className="flex-1 truncate">{option.label}</span>
                    {option.count !== undefined && (
                      <span className="ml-auto font-mono text-xs text-muted-foreground">{option.count}</span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
            {hasSelection && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={() => onChange([])} className="justify-center text-center">
                    清除筛选
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
