import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { prepareExplodePieces, splitGeometryIslands } from '../explodePieces'

function twoIslandGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0]), 3)
  )
  geo.setIndex([0, 1, 2, 3, 4, 5])
  return geo
}

describe('splitGeometryIslands', () => {
  it('splits two disconnected triangles', () => {
    expect(splitGeometryIslands(twoIslandGeometry())).toHaveLength(2)
  })
})

describe('prepareExplodePieces', () => {
  it('creates movable pieces from a single mesh with two islands', () => {
    const root = new THREE.Group()
    root.add(new THREE.Mesh(twoIslandGeometry(), new THREE.MeshBasicMaterial()))
    const pieces = prepareExplodePieces(root)
    expect(pieces.length).toBeGreaterThanOrEqual(2)
  })
})
