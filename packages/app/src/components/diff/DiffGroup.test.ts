import type { DiffsPayload, GroupedResult } from '@pulls.review/core/types'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import nestedGroups from '../../../test/fixtures/synthetic/nested-groups.json'
import partiallyReviewed from '../../../test/fixtures/synthetic/partially-reviewed.json'
import { scrollToElement, scrollToFile, scrollToId } from '../../composables/scrollToFile'
import { i18n } from '../../i18n'
import { createMockDiffsStore } from '../../stores/mock-diffs-store'
import DiffGroup from './DiffGroup.vue'
import DiffGroupNav from './DiffGroupNav.vue'
import FileTree from './FileTree.vue'

// The jump itself is `scrollToFile`'s contract; these tests only pin which root
// and which target each navigation hands to it, so no animation runs here.
vi.mock('../../composables/scrollToFile', () => ({
  scrollToElement: vi.fn(),
  scrollToFile: vi.fn(),
  scrollToId: vi.fn(),
}))

const wrappers: ReturnType<typeof mount>[] = []

// Keep the group/tree navigation real while replacing the external diff renderer.
const FileDiffStub = defineComponent({
  setup(_, { expose }) {
    const expanded = ref(false)
    expose({
      expand: () => {
        expanded.value = true
      },
    })
    return () => h('div', { 'data-expanded': expanded.value })
  },
})

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

function mountGroup(embedded: boolean, nested = false) {
  const fixture = nested ? nestedGroups : partiallyReviewed
  const store = createMockDiffsStore({ diff: fixture.diff as DiffsPayload, grouped: fixture.grouped as GroupedResult })
  const host = document.createElement('div')
  document.body.append(host)
  const root = embedded ? host.attachShadow({ mode: 'open' }) : document
  const container = document.createElement('div')
  ;(embedded ? root : host).append(container)
  const group = store.groups[0]!
  const wrapper = mount(DiffGroup, {
    props: { store, group, collapsed: false, filesVisible: [], document: root },
    global: { plugins: [i18n], stubs: { FileDiff: FileDiffStub } },
    attachTo: container,
  })
  wrappers.push(wrapper)
  return { root, wrapper, group }
}

describe('diffGroup navigation', () => {
  it.each([false, true])('expands the file and jumps to it in its own root (embedded=%s)', async (embedded) => {
    const { root, wrapper, group } = mountGroup(embedded)
    const file = group.files[0]!

    wrapper.findComponent(FileTree).vm.$emit('navigate', file.sha)
    await nextTick()
    await nextTick()

    expect(wrapper.find('[data-expanded="true"]').exists()).toBe(true)
    expect(scrollToFile).toHaveBeenCalledWith(root, file.sha)
  })

  it('jumps to a subgroup element rather than an id the document may also carry', async () => {
    const { root, wrapper, group } = mountGroup(true, true)
    const child = group.children[0]!
    const childEl = root.getElementById(`group-${child.key}`)!
    const outside = document.createElement('div')
    outside.id = childEl.id
    document.body.prepend(outside)

    wrapper.findComponent(DiffGroupNav).vm.$emit('select', child.key)
    await nextTick()

    expect(scrollToElement).toHaveBeenCalledWith(root, childEl)
    expect(scrollToId).not.toHaveBeenCalled()
  })

  it('returns from a subgroup to its parent inside the ShadowRoot', async () => {
    const { root, wrapper, group } = mountGroup(true, true)
    const outside = document.createElement('div')
    outside.id = `group-${group.key}`
    document.body.prepend(outside)

    const back = wrapper.findAll('button').find(button => button.text() === `${group.label} ›`)!
    await back.trigger('click')

    expect(scrollToId).toHaveBeenCalledWith(root, `group-${group.key}`)
  })
})
