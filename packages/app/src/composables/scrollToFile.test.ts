import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { smoothScroll } from '../state/smooth-scroll'
import { scrollToFile, scrollToId } from './scrollToFile'

/** Frames the glide has asked for: empty once a jump is over. */
let frames = new Map<number, FrameRequestCallback>()
let clock = 0
let handle = 0

function tick(ms = 16) {
  clock += ms
  const due = [...frames.values()]
  frames.clear()
  due.forEach(frame => frame(clock))
}

interface Target {
  el: HTMLElement
  /** The virtualizer measuring another file above it: the target slides down by `px`. */
  drift: (px: number) => void
}

interface World {
  root: Document | ShadowRoot
  targets: Target[]
  /** Every delta the jump asked the scroller for, oldest first. */
  moves: number[]
  scroll: number
  tick: (ms?: number) => void
  add: (attributes: Record<string, string>, base: number) => Target
  /** How far the target still is from where its scroll-margin puts it. */
  offset: (target: Target) => number
}

function mountWorld({ embedded = false, margin = 24, containerTop = 160 }: { embedded?: boolean, margin?: number, containerTop?: number } = {}): World {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Document | ShadowRoot = embedded ? host.attachShadow({ mode: 'open' }) : document
  const container = document.createElement('div')
  container.style.overflowY = 'auto'
  container.getBoundingClientRect = () => new DOMRect(0, containerTop, 400, 600)
  if (embedded)
    root.append(container)

  const world: World = {
    root,
    targets: [],
    moves: [],
    scroll: 0,
    tick,
    add,
    // Inside the embed the scrollport starts at the drawer's top edge; on the site at 0.
    // The margin is read live, like the jump reads it: the page changes it mid-flight.
    offset: (target) => {
      const margin = Number.parseFloat(target.el.style.scrollMarginTop) || 0
      return target.el.getBoundingClientRect().top - (embedded ? containerTop : 0) - margin
    },
  }
  const scrollBy = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    const delta = typeof options === 'number' ? y ?? 0 : options?.top ?? 0
    world.scroll += delta
    world.moves.push(delta)
  })
  if (embedded)
    container.scrollBy = scrollBy
  // A `Document` scrollport is the window, so that is what the jump asks to move.
  else
    vi.spyOn(window, 'scrollBy').mockImplementation(scrollBy)

  function add(attributes: Record<string, string>, base: number): Target {
    const el = document.createElement('div')
    Object.entries(attributes).forEach(([name, value]) => el.setAttribute(name, value))
    el.style.scrollMarginTop = `${margin}px`
    el.getBoundingClientRect = () => new DOMRect(0, base - world.scroll, 400, 200)
    if (embedded)
      container.append(el)
    else
      host.append(el)

    const target: Target = {
      el,
      drift: (px) => {
        base += px
      },
    }
    world.targets.push(target)
    return target
  }
  return world
}

function runUntilQuiet(world: World, frames = 100) {
  for (let i = 0; i < frames; i++)
    world.tick()
  return world
}

beforeEach(() => {
  frames = new Map()
  clock = 0
  handle = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++handle, cb)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  // A jump still gliding would keep asking whatever test runs next for its frames.
  frames.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  smoothScroll.value = true
  document.body.innerHTML = ''
})

describe('scrollToId', () => {
  it('glides part of the way each frame instead of cutting to the target', () => {
    const world = mountWorld()
    const group = world.add({ id: 'group-a' }, 500)
    scrollToId(document, 'group-a')

    world.tick()
    world.tick()
    const [first, second] = world.moves
    expect(first!).toBeGreaterThan(0)
    // Not the whole distance in one frame: that is the cut the viewer rejects.
    expect(first!).toBeLessThan(476)
    expect(second!).toBeGreaterThan(0)
    // Ease-out, so the motion reads as one continuous scroll toward the group.
    expect(second!).toBeLessThan(first!)
    expect(world.offset(group)).toBeLessThan(476)
  })

  it('lands on the group and stops asking for frames', () => {
    const world = mountWorld()
    const group = world.add({ id: 'group-a' }, 500)
    scrollToId(document, 'group-a')
    runUntilQuiet(world)

    expect(Math.abs(world.offset(group))).toBeLessThanOrEqual(2)
    expect(frames.size).toBe(0)
  })

  it('keeps chasing a group the virtualizer moves out from under it', () => {
    const world = mountWorld()
    const group = world.add({ id: 'group-a' }, 500)
    scrollToId(document, 'group-a')

    // The reported bug: each file measured above drags the target further down, so the
    // jump is nowhere near done when an interruption lands. It has to outlast them all
    // rather than a fixed number of tries, and arrive once the layout stops moving.
    for (let file = 0; file < 12; file++) {
      world.tick()
      world.tick()
      group.drift(100)
    }
    runUntilQuiet(world)

    expect(Math.abs(world.offset(group))).toBeLessThanOrEqual(2)
    expect(frames.size).toBe(0)
  })

  it('aims again when the files above grow after the jump has landed', () => {
    smoothScroll.value = false
    const world = mountWorld()
    const group = world.add({ id: 'group-a' }, 500)
    scrollToId(document, 'group-a')

    world.tick()
    expect(Math.abs(world.offset(group))).toBeLessThanOrEqual(2)

    group.drift(300)
    world.tick()
    expect(world.moves[1]).toBe(300)
    expect(Math.abs(world.offset(group))).toBeLessThanOrEqual(2)
  })

  it.each([258, 0])('re-aims when the page changes the scroll-margin to %s mid-flight', (margin) => {
    const world = mountWorld({ margin: 183 })
    const group = world.add({ id: 'group-a' }, 5000)
    scrollToId(document, 'group-a')
    world.tick()

    // `--diffs-header-height` is live: the header grows a subgroups row under the very
    // click that started the jump, and slides away entirely below `lg`. A margin read
    // once at take-off lands the group off by exactly that difference.
    group.el.style.scrollMarginTop = `${margin}px`
    runUntilQuiet(world)

    expect(Math.abs(world.offset(group))).toBeLessThanOrEqual(2)
    expect(frames.size).toBe(0)
  })

  it('closes the whole distance in one frame when the animation is turned off', () => {
    smoothScroll.value = false
    const world = mountWorld()
    const group = world.add({ id: 'group-a' }, 500)
    scrollToId(document, 'group-a')

    world.tick()
    expect(world.moves).toEqual([476])
    expect(Math.abs(world.offset(group))).toBeLessThanOrEqual(2)
  })

  it('gives up on a layout that never settles instead of gliding forever', () => {
    const world = mountWorld()
    const group = world.add({ id: 'group-a' }, 500)
    scrollToId(document, 'group-a')

    // Frames worth of `MAX_FLIGHT_MS`, each pulling the target further away.
    for (let i = 0; i < 200; i++) {
      group.drift(1000)
      world.tick(50)
    }
    expect(frames.size).toBe(0)
    expect(Math.abs(world.offset(group))).toBeGreaterThan(2)
  })
})

describe('scroll jumps on one scroller', () => {
  it('hands the scroller over to the newest target', () => {
    smoothScroll.value = false
    const world = mountWorld()
    const first = world.add({ id: 'group-a' }, 500)
    const second = world.add({ id: 'group-b' }, 4000)

    scrollToId(document, 'group-a')
    world.tick()
    scrollToId(document, 'group-b')
    world.tick()
    expect(world.moves).toHaveLength(2)
    expect(Math.abs(world.offset(second))).toBeLessThanOrEqual(2)

    // The first jump is gone, not waiting for its turn to pull the page back.
    runUntilQuiet(world)
    expect(world.moves).toHaveLength(2)
    expect(world.offset(first)).toBeLessThan(-1000)
  })

  it('leaves a target already at its scroll-margin where it is', () => {
    const world = mountWorld()
    const group = world.add({ id: 'group-a' }, 24)
    scrollToId(document, 'group-a')
    runUntilQuiet(world, 4)

    expect(world.moves.reduce((total, move) => total + Math.abs(move), 0)).toBeLessThanOrEqual(2)
    expect(Math.abs(world.offset(group))).toBeLessThanOrEqual(2)
  })

  it('does nothing for an id the root does not have', () => {
    const world = mountWorld()
    scrollToId(document, 'group-missing')
    world.tick()

    expect(world.moves).toEqual([])
    expect(frames.size).toBe(0)
  })

  it('scrolls the drawer of the embed rather than the window', () => {
    const world = mountWorld({ embedded: true })
    const group = world.add({ id: 'group-a' }, 900)
    scrollToId(world.root, 'group-a')
    runUntilQuiet(world)

    expect(Math.abs(world.offset(group))).toBeLessThanOrEqual(2)
    // Measured against the drawer, which is where its scroll-margin is.
    expect(Math.abs(world.scroll - (900 - 160 - 24))).toBeLessThanOrEqual(2)
  })
})

describe('scrollToFile', () => {
  it('glides to the file marker the tree picked', () => {
    const world = mountWorld({ embedded: true })
    const file = world.add({ 'data-file-start': 'abc' }, 900)
    scrollToFile(world.root, 'abc')
    runUntilQuiet(world)

    expect(Math.abs(world.offset(file))).toBeLessThanOrEqual(2)
  })

  it('lets a viewer who reaches for the page finish scrolling it themselves', () => {
    const world = mountWorld()
    const group = world.add({ id: 'group-a' }, 500)
    scrollToId(document, 'group-a')
    world.tick()

    document.dispatchEvent(new Event('wheel'))
    const moves = world.moves.length
    runUntilQuiet(world)

    expect(world.moves).toHaveLength(moves)
    expect(frames.size).toBe(0)
    expect(Math.abs(world.offset(group))).toBeGreaterThan(2)
  })
})
