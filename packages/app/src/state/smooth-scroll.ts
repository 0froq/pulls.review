import { useLocalStorage } from '@vueuse/core'

/**
 * Animate the scroll when jumping to a group or file (group tabs, sidebar, sub-nav,
 * file tree). A shared app-wide preference, like `layout.ts` - persisted the same way.
 * Off, a jump lands in a single frame.
 */
export const smoothScroll = useLocalStorage('diffs:smooth-scroll', true)
