import type * as THREE from 'three'
import type { ComponentDef, DistrictId } from './types'

/**
 * Registry of everything the user can point at.
 *
 * World modules call `register()`; the picker resolves a raycast hit by walking
 * up the object's parents until it finds a registered root, so districts can
 * register a whole group and still get precise picking on its children.
 */
export class Registry {
  private byId = new Map<string, ComponentDef>()
  private byObject = new Map<THREE.Object3D, ComponentDef>()
  private ordered: ComponentDef[] = []

  register(def: ComponentDef): void {
    if (this.byId.has(def.id)) {
      console.warn(`[registry] duplicate component id "${def.id}" — the later one wins`)
      const prev = this.byId.get(def.id)!
      this.byObject.delete(prev.object)
      this.ordered = this.ordered.filter((d) => d !== prev)
    }
    this.byId.set(def.id, def)
    this.byObject.set(def.object, def)
    this.ordered.push(def)
    def.object.userData.componentId = def.id
  }

  get(id: string): ComponentDef | undefined {
    return this.byId.get(id)
  }

  /** Walk up from a raycast hit to the nearest registered ancestor. */
  resolve(obj: THREE.Object3D | null | undefined): ComponentDef | undefined {
    let o: THREE.Object3D | null = obj ?? null
    let guard = 0
    while (o && guard++ < 64) {
      const hit = this.byObject.get(o)
      if (hit) return hit
      o = o.parent
    }
    return undefined
  }

  all(): readonly ComponentDef[] {
    return this.ordered
  }

  district(id: DistrictId): ComponentDef[] {
    return this.ordered.filter((d) => d.district === id)
  }

  tier(t: 0 | 1 | 2): ComponentDef[] {
    return this.ordered.filter((d) => d.tier === t)
  }

  /** Every registered root object — the raycaster's candidate set. */
  roots(): THREE.Object3D[] {
    return this.ordered.map((d) => d.object)
  }

  /** Fuzzy search for the command palette / search box. */
  search(q: string, limit = 12): ComponentDef[] {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const scored: { d: ComponentDef; s: number }[] = []
    for (const d of this.ordered) {
      const name = d.name.toLowerCase()
      const id = d.id.toLowerCase()
      let s = -1
      if (name === needle || id === needle) s = 1000
      else if (name.startsWith(needle)) s = 500 - name.length
      else if (name.includes(needle)) s = 250 - name.length
      else if (id.includes(needle)) s = 200 - id.length
      else if (d.role.toLowerCase().includes(needle)) s = 100
      if (s > 0) scored.push({ d, s })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, limit).map((x) => x.d)
  }

  clear(): void {
    this.byId.clear()
    this.byObject.clear()
    this.ordered = []
  }
}
