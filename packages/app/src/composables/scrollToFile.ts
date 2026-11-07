import { smoothScroll } from '../state/smooth-scroll'

/**
 * The glide's time constant, in ms: each frame closes this share of the distance left.
 * Driven by distance rather than a fixed duration because the distance itself keeps
 * changing - the virtualizer is measuring the files above the whole time we travel - so a
 * jump has to re-decide where its target is every frame regardless.
 */
const GLIDE_TAU_MS = 120
/** Within this of its scroll-margin the target counts as reached. */
const TOLERANCE_PX = 2
/** Frames the target has to hold still, so a file mid-measurement cannot end the jump early. */
const SETTLE_FRAMES = 2
/**
 * A circuit breaker for a layout that never settles, not a budget: a jump ends by
 * arriving, whatever number of groups it had to glide past to get there.
 */
const MAX_FLIGHT_MS = 3000
/** Anything the viewer uses to scroll, which ends a jump the moment they reach for the page. */
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'keydown'] as const

const pendingScrolls = new WeakMap<EventTarget, () => void>()

/**
 * Glides so that `target`'s top lands at its `scroll-margin`, driving the scroll one frame
 * at a time instead of handing the jump to `scrollIntoView`.
 *
 * A jump cannot be one-shot. While it is in flight the virtualizer keeps re-measuring the
 * files above the target and correcting their heights with an instant `scrollTo`, and each
 * of those cancels a native smooth animation part-way through, leaving the target wherever
 * the interruption happened to stop it. Driving the animation ourselves is what survives
 * that: the target is re-read every frame, so a correction costs at most the frame it lands
 * in, the motion stays continuous, and the jump keeps chasing a layout that is still
 * settling underneath it.
 */
export function scrollToElement(root: ParentNode, target: Element) {
  // The embed scrolls within its drawer, below the toolbar. On the site, the
  // document scrollport starts at the viewport top instead.
  let scroller = target.parentElement
  while (scroller && scroller !== target.ownerDocument.scrollingElement && !/auto|scroll|overlay/.test(getComputedStyle(scroller).overflowY))
    scroller = scroller.parentElement
  if (scroller === target.ownerDocument.scrollingElement)
    scroller = null

  const scrollTarget: EventTarget = scroller ?? root
  // Two jumps on one scroller would fight over every frame of it.
  pendingScrolls.get(scrollTarget)?.()

  /** Signed px between where `target` sits and where its scroll-margin wants it. */
  const offset = () => {
    const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0
    // Read live, not once: the margin is `--diffs-header-height`, which grows when a
    // chapter's subgroups open in the header and collapses to 0 when the header slides
    // away below `lg`. A margin captured at take-off lands the jump off by the difference.
    const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0
    return target.getBoundingClientRect().top - top - margin
  }
  // `instant`, so the scroller's own `scroll-behavior` can't turn a frame of the glide
  // into a nested animation.
  const scrollBy = (delta: number) => (scroller ?? window).scrollBy({ top: delta, behavior: 'instant' })

  let frame = 0
  let previous = 0
  let quiet = 0
  const started = performance.now()
  function stop() {
    cancelAnimationFrame(frame)
    TAKEOVER_EVENTS.forEach(type => scrollTarget.removeEventListener(type, stop, { capture: true }))
    pendingScrolls.delete(scrollTarget)
  }
  function glide(now: number) {
    if (now - started > MAX_FLIGHT_MS)
      return stop()

    const remaining = offset()
    if (Math.abs(remaining) > TOLERANCE_PX) {
      quiet = 0
      const elapsed = previous ? now - previous : 1000 / 60
      // Turning the animation off closes the whole distance in a single frame.
      scrollBy(smoothScroll.value ? remaining * (1 - Math.exp(-elapsed / GLIDE_TAU_MS)) : remaining)
    }
    else if (++quiet >= SETTLE_FRAMES) {
      // Stillness has to hold for a couple of frames, since a file measured mid-flight
      // can leave the target perfectly aligned for one frame and moved again the next.
      return stop()
    }

    previous = now
    frame = requestAnimationFrame(glide)
  }

  pendingScrolls.set(scrollTarget, stop)
  TAKEOVER_EVENTS.forEach(type => scrollTarget.addEventListener(type, stop, { passive: true, capture: true }))
  frame = requestAnimationFrame(glide)
}

/** Same jump for a target the nav lists carry as an element `id`, which is how groups are keyed. */
export function scrollToId(root: Document | ShadowRoot, id: string) {
  const target = root.getElementById(id)
  if (target)
    scrollToElement(root, target)
}

/**
 * Scrolls to a file's non-sticky `[data-file-start]` marker: its own header is sticky, so
 * the header's rect stops following the file once it sticks and can't say where the file is.
 */
export function scrollToFile(root: ParentNode, sha: string) {
  const marker = root.querySelector(`[data-file-start="${sha}"]`)
  if (marker)
    scrollToElement(root, marker)
}
