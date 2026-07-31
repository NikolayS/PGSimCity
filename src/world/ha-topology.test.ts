import { describe, expect, it } from 'vitest'
import { ANCHOR } from './layout'

function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2])
}

describe('HA failure-domain geography', () => {
  it('puts PostgreSQL nodes on three visibly separate site platforms', () => {
    const sites = [
      ANCHOR.haPrimarySite,
      ANCHOR.haStandbyASite,
      ANCHOR.haStandbyBSite,
    ] as const

    expect(distance(sites[0], sites[1])).toBeGreaterThan(250)
    expect(distance(sites[0], sites[2])).toBeGreaterThan(250)
    expect(distance(sites[1], sites[2])).toBeGreaterThan(250)
  })

  it('distributes one Patroni agent and one etcd member to every site', () => {
    const sites = [
      ANCHOR.haPrimarySite,
      ANCHOR.haStandbyASite,
      ANCHOR.haStandbyBSite,
    ] as const
    const agents = [
      ANCHOR.patroniNode1,
      ANCHOR.patroniNode2,
      ANCHOR.patroniNode3,
    ] as const
    const members = [
      ANCHOR.leaseNode1,
      ANCHOR.leaseNode2,
      ANCHOR.leaseNode3,
    ] as const

    for (let i = 0; i < sites.length; i++) {
      expect(distance(agents[i], sites[i])).toBeLessThan(60)
      expect(distance(members[i], sites[i])).toBeLessThan(60)
      for (let j = 0; j < sites.length; j++) {
        if (j === i) continue
        expect(distance(members[i], sites[i])).toBeLessThan(
          distance(members[i], sites[j]),
        )
      }
    }
  })
})
