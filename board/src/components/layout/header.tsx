import { Search } from 'lucide-react'
import { SearchTrigger, useCommandPalette } from '@/components/command-palette'
import { ModeToggle, ThemeSelector } from '@/components/theme/theme-switcher'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Breadcrumbs } from './breadcrumbs'
import { HeaderUserMenu } from './user-menu'

export function Header() {
  const { open } = useCommandPalette()
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-2 bg-background/60 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4 data-vertical:self-center" />
        <Breadcrumbs />
      </div>
      <div className="flex shrink-0 items-center gap-2 px-4">
        <div className="hidden md:flex">
          <SearchTrigger />
        </div>
        <Button variant="ghost" size="icon" className="size-8 md:hidden" onClick={open} aria-label="搜索">
          <Search />
        </Button>
        <ModeToggle />
        <div className="hidden sm:block">
          <ThemeSelector />
        </div>
        <HeaderUserMenu />
      </div>
    </header>
  )
}
