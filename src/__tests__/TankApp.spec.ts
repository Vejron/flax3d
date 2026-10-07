import { describe, expect, it, vi } from 'vitest'

import { mount } from '@vue/test-utils'
import TankApp from '../TankApp.vue'
import { tankConfig } from '../tank'

vi.mock('../tankScene', () => ({
  createTankScene: () => ({
    render: () => { }, dispose: () => { },
    rounds: () => 60, addRounds: () => { }, resetRounds: () => { },
  }),
}))
vi.stubGlobal('requestAnimationFrame', () => 1)
vi.stubGlobal('cancelAnimationFrame', () => { })

describe('TankApp', () => {
  it('mounts and renders the armour HUD', () => {
    const wrapper = mount(TankApp)
    expect(wrapper.text()).toContain('FLAX')
    expect(wrapper.text()).toContain('ARMOR DIVISION')
    wrapper.unmount()
  })

  it('starts on the controls panel and can hide it again', async () => {
    const wrapper = mount(TankApp)
    // The tank uses a different control scheme to the bird, so the hints start visible.
    expect(wrapper.find('.instruction-panel').exists()).toBe(true)
    const toggle = wrapper.get('button[aria-label="Tank controls"]')
    await toggle.trigger('click')
    expect(wrapper.find('.instruction-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('mirrors the shared radar legend, including the tank swatch', () => {
    const wrapper = mount(TankApp)
    const swatches = wrapper.findAll('.radar-dot').map((dot) => dot.classes().find((name) => name !== 'radar-dot'))
    expect(swatches).toEqual(['level', 'above', 'below', 'tank', 'powerup'])
    wrapper.unmount()
  })

  it('changes tank tuning live and restores defaults', async () => {
    const wrapper = mount(TankApp)
    await wrapper.get('button[aria-label="Tank settings"]').trigger('click')
    expect(wrapper.find('aside[aria-label="Tank tuning"]').exists()).toBe(true)
    await wrapper.get('#setting-maxSpeed').setValue('22')
    expect(wrapper.get('output[for="setting-maxSpeed"]').text()).toBe('22.0')
    expect(tankConfig.maxSpeed).toBe(14)
    await wrapper.get('.settings-reset').trigger('click')
    expect(wrapper.get('output[for="setting-maxSpeed"]').text()).toBe('14.0')
    wrapper.unmount()
  })

  it('exposes the AA gun magazine and the fired-rounds readout', () => {
    const wrapper = mount(TankApp)
    expect(wrapper.get('.ammo-readout').text()).toContain('60')
    expect(wrapper.get('.ammo-readout').text()).toContain('AMMO')
    wrapper.unmount()
  })
})
