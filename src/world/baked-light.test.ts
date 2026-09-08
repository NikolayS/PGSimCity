import * as THREE from 'three'
import { applyBoxBevelDetail, pairBoxGeometries } from '../core/beveled-box'
import { installBoxBakeVariants, disposeBakedIndirect } from './baked-light'
import { describe, expect, it } from 'vitest'

import { DAY_PALETTE } from '../core/themes'
import { gradeDaylightHex, perceptualColorDistance } from '../engine/color-grade'
import {
  MAX_BLEED,
  SEMANTIC_BOUNCE_KEYS,
  decodeTransportByte,
  encodeTransportByte,
  mixBoundaryColor,
} from './baked-light'
import {
  BAKED_LIGHT_BASE64,
  BAKED_LIGHT_BAKE_MS,
  BAKED_LIGHT_BYTES,
  BAKED_LIGHT_ENTRIES,
} from './baked-light-data'

describe('baked indirect-light transport', () => {
  it('ships a complete compact bake rather than computing one at boot', () => {
    const bytes = Uint8Array.from(atob(BAKED_LIGHT_BASE64), (value) => value.charCodeAt(0))
    expect(BAKED_LIGHT_ENTRIES.length).toBeGreaterThan(100)
    expect(bytes.byteLength).toBe(BAKED_LIGHT_BYTES)
    expect(BAKED_LIGHT_BYTES).toBeLessThan(64 * 1024)
    expect(BAKED_LIGHT_BAKE_MS).toBeLessThan(1000)

    let end = 0
    for (const entry of BAKED_LIGHT_ENTRIES) {
      expect(entry.offset).toBe(end)
      end += entry.count * (entry.instanced ? 12 : 2)
    }
    expect(end).toBe(BAKED_LIGHT_BYTES)
  })

  it('round-trips a semantic source and keeps transfer below the hue-safety cap', () => {
    for (let source = 0; source < SEMANTIC_BOUNCE_KEYS.length; source++) {
      const encoded = encodeTransportByte(source, 1)
      const decoded = decodeTransportByte(encoded)
      expect(decoded.source).toBe(source)
      expect(decoded.weight).toBeCloseTo(MAX_BLEED, 5)
    }
  })

  it('keeps all 45 semantic pairs distinct under worst-case mutual boundary bleed', () => {
    const colors = SEMANTIC_BOUNCE_KEYS.map((key) => DAY_PALETTE[key])
    let pairs = 0
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const a = gradeDaylightHex(mixBoundaryColor(colors[i], colors[j], MAX_BLEED))
        const b = gradeDaylightHex(mixBoundaryColor(colors[j], colors[i], MAX_BLEED))
        expect(
          perceptualColorDistance(a, b),
          `${SEMANTIC_BOUNCE_KEYS[i]} vs ${SEMANTIC_BOUNCE_KEYS[j]}`,
        ).toBeGreaterThan(0.045)
        pairs++
      }
    }
    expect(pairs).toBe(45)
  })

  it('protects the three strongest district boundaries from hue takeover', () => {
    const boundaries = [
      ['shmem', 'wal'],
      ['shmem', 'vacuum'],
      ['storage', 'shmem'],
    ] as const
    for (const [receiver, neighbour] of boundaries) {
      const mixed = mixBoundaryColor(
        DAY_PALETTE[receiver],
        DAY_PALETTE[neighbour],
        MAX_BLEED,
      )
      expect(
        perceptualColorDistance(mixed, DAY_PALETTE[receiver]),
        `${receiver} boundary`,
      ).toBeLessThan(
        perceptualColorDistance(mixed, DAY_PALETTE[neighbour]),
      )
    }
  })
})


describe('baked box detail ownership', () => {
  it('retains distinct instance transport across quality changes and disposes only owned variants', () => {
    const pair = pairBoxGeometries(1, 1, 1)
    const scene = new THREE.Scene()
    const copies: THREE.BufferGeometry[] = []
    const meshes = [17, 203].map(value => {
      const geometry = pair.beveled.clone()
      copies.push(geometry)
      for (const name of ['pgBakeSkyA', 'pgBakeSkyB', 'pgBakeTransferA', 'pgBakeTransferB']) {
        geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Uint8Array([value, value, value]), 3, true))
      }
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 1)
      mesh.userData.pgBakeOriginalGeometry = pair.beveled
      scene.add(mesh)
      installBoxBakeVariants(mesh)
      return mesh
    })
    const variants = new Set<THREE.BufferGeometry>()
    for (const level of ['high', 'low', 'medium', 'high'] as const) {
      applyBoxBevelDetail(scene, level)
      meshes.forEach((mesh, i) => {
        expect(mesh.geometry.getAttribute('pgBakeSkyA')?.array[0]).toBe([17, 203][i])
        expect(mesh.geometry.getAttribute('pgBakeTransferB')?.array[2]).toBe([17, 203][i])
        variants.add(mesh.geometry)
      })
      expect(meshes[0].geometry).not.toBe(meshes[1].geometry)
    }
    expect(variants.size).toBe(4)
    let ownedDisposals = 0, sharedDisposals = 0
    for (const geometry of variants) geometry.addEventListener('dispose', () => ownedDisposals++)
    pair.plain.addEventListener('dispose', () => sharedDisposals++)
    pair.beveled.addEventListener('dispose', () => sharedDisposals++)
    disposeBakedIndirect(scene)
    expect(ownedDisposals).toBe(4)
    expect(sharedDisposals).toBe(0)
    for (const mesh of meshes) expect(mesh.geometry).toBe(pair.beveled)
    disposeBakedIndirect(scene)
    expect(ownedDisposals).toBe(4)
    pair.plain.dispose(); pair.beveled.dispose()
    for (const mesh of meshes) (mesh.material as THREE.Material).dispose()
  })

  it('maps vertex transport by face normal without blending packed source bytes', () => {
    const pair = pairBoxGeometries(8, 6, 4)
    const geometry = pair.beveled.clone()
    const normals = geometry.getAttribute('normal')
    const packed = new Uint8Array(normals.count)
    for (let i = 0; i < normals.count; i++) packed[i] = normals.getX(i) > 0.99 ? 0x1f : 0x82
    geometry.setAttribute('pgBakeSky', new THREE.BufferAttribute(new Uint8Array(normals.count).fill(91), 1, true))
    geometry.setAttribute('pgBakeTransfer', new THREE.BufferAttribute(packed, 1, true))
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
    mesh.userData.pgBakeOriginalGeometry = pair.beveled
    installBoxBakeVariants(mesh)
    applyBoxBevelDetail(mesh, 'low')
    const transfer = mesh.geometry.getAttribute('pgBakeTransfer')
    expect(transfer).toBeDefined()
    expect(transfer.count).toBe(mesh.geometry.getAttribute('position').count)
    const targetNormals = mesh.geometry.getAttribute('normal')
    for (let i = 0; i < transfer.count; i++) {
      expect(transfer.array[i]).toBe(targetNormals.getX(i) > 0.99 ? 0x1f : 0x82)
    }
    disposeBakedIndirect(mesh)
    pair.plain.dispose(); pair.beveled.dispose(); mesh.material.dispose()
  })
})
