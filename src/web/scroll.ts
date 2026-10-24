import { createContext, type RefObject } from 'react'

/** The app's scroll container (<main>); pages that manage scrolling themselves (chat) read it. */
export const ScrollContext = createContext<RefObject<HTMLElement | null>>({ current: null })
