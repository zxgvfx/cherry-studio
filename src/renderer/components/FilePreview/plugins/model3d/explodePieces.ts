import * as THREE from 'three'

export type ExplodePiece = {
  object: THREE.Object3D
  origin: THREE.Vector3
  explodeDir: THREE.Vector3
}

const MAX_ISLAND_TRIANGLES = 400_000

function isMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as THREE.Mesh).isMesh === true
}

export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  root.traverse((obj) => {
    if (isMesh(obj) && obj.visible) meshes.push(obj)
  })
  return meshes
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  if (geometry.index) return Math.floor(geometry.index.count / 3)
  const pos = geometry.getAttribute('position')
  return pos ? Math.floor(pos.count / 3) : 0
}

function find(parent: Int32Array, i: number): number {
  let a = i
  while (parent[a] !== a) {
    parent[a] = parent[parent[a]]
    a = parent[a]
  }
  return a
}

function union(parent: Int32Array, a: number, b: number): void {
  const ra = find(parent, a)
  const rb = find(parent, b)
  if (ra !== rb) parent[ra] = rb
}

function weldByPosition(geometry: THREE.BufferGeometry): Int32Array {
  const pos = geometry.getAttribute('position')
  const map = new Map<string, number>()
  const remap = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`
    const existing = map.get(key)
    if (existing == null) {
      map.set(key, i)
      remap[i] = i
    } else {
      remap[i] = existing
    }
  }
  return remap
}

/** Split an indexed/non-indexed mesh into connected islands. Returns [] if not worth splitting. */
export function splitGeometryIslands(geometry: THREE.BufferGeometry): THREE.BufferGeometry[] {
  const pos = geometry.getAttribute('position')
  if (!pos || pos.count < 6) return []
  const tris = triangleCount(geometry)
  if (tris < 2 || tris > MAX_ISLAND_TRIANGLES) return []

  const weld = weldByPosition(geometry)
  const parent = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) parent[i] = i
  for (let i = 0; i < pos.count; i++) union(parent, i, weld[i])

  const index = geometry.index
  const triVertex = (tri: number, corner: number): number => {
    if (index) return index.getX(tri * 3 + corner)
    return tri * 3 + corner
  }
  for (let t = 0; t < tris; t++) {
    const a = triVertex(t, 0)
    const b = triVertex(t, 1)
    const c = triVertex(t, 2)
    union(parent, a, b)
    union(parent, b, c)
  }

  const islandOf = new Int32Array(pos.count)
  const islandIds: number[] = []
  const seen = new Map<number, number>()
  for (let i = 0; i < pos.count; i++) {
    const root = find(parent, i)
    let id = seen.get(root)
    if (id == null) {
      id = islandIds.length
      seen.set(root, id)
      islandIds.push(root)
    }
    islandOf[i] = id
  }
  if (islandIds.length < 2) return []

  const triIslands: number[][] = islandIds.map(() => [])
  for (let t = 0; t < tris; t++) {
    triIslands[islandOf[triVertex(t, 0)]].push(t)
  }

  return triIslands.flatMap((trisInIsland) => {
    if (trisInIsland.length === 0) return []
    return [extractTriangles(geometry, trisInIsland)]
  })
}

function extractTriangles(geometry: THREE.BufferGeometry, triIndices: number[]): THREE.BufferGeometry {
  const srcIndex = geometry.index
  const out = new THREE.BufferGeometry()
  const newIndex: number[] = []
  const remap = new Map<number, number>()
  const takeVertex = (oldIndex: number): number => {
    const existing = remap.get(oldIndex)
    if (existing != null) return existing
    const next = remap.size
    remap.set(oldIndex, next)
    return next
  }
  for (const tri of triIndices) {
    for (let c = 0; c < 3; c++) {
      const old = srcIndex ? srcIndex.getX(tri * 3 + c) : tri * 3 + c
      newIndex.push(takeVertex(old))
    }
  }
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name)
    const itemSize = attr.itemSize
    const array = new Float32Array(remap.size * itemSize)
    remap.forEach((newI, oldI) => {
      for (let k = 0; k < itemSize; k++) {
        array[newI * itemSize + k] = attr.getComponent(oldI, k)
      }
    })
    out.setAttribute(name, new THREE.BufferAttribute(array, itemSize, attr.normalized))
  }
  out.setIndex(newIndex)
  if (geometry.morphAttributes) {
    /* skip morphs for explode preview */
  }
  out.computeVertexNormals()
  return out
}

function splitMeshByGroups(mesh: THREE.Mesh): THREE.BufferGeometry[] {
  const groups = mesh.geometry.groups
  if (!groups || groups.length < 2) return []
  return groups.flatMap((group) => {
    if (group.count <= 0) return []
    const startTri = Math.floor(group.start / 3)
    const triCount = Math.floor(group.count / 3)
    const tris = Array.from({ length: triCount }, (_, i) => startTri + i)
    return [extractTriangles(mesh.geometry, tris)]
  })
}

function replaceMeshWithPieces(mesh: THREE.Mesh, geos: THREE.BufferGeometry[]): THREE.Mesh[] {
  const parent = mesh.parent
  if (!parent) return []
  const pieces = geos.map((geo, index) => {
    const piece = new THREE.Mesh(geo, mesh.material)
    piece.name = `${mesh.name || 'island'}_${index}`
    piece.position.copy(mesh.position)
    piece.quaternion.copy(mesh.quaternion)
    piece.scale.copy(mesh.scale)
    parent.add(piece)
    return piece
  })
  mesh.visible = false
  return pieces
}

/** Mutates the scene so explode has independently movable pieces. */
export function prepareExplodePieces(root: THREE.Object3D): ExplodePiece[] {
  let meshes = collectMeshes(root)
  if (meshes.length <= 1) {
    const mesh = meshes[0]
    if (mesh) {
      const byGroup = splitMeshByGroups(mesh)
      if (byGroup.length >= 2) {
        replaceMeshWithPieces(mesh, byGroup)
      } else {
        const islands = splitGeometryIslands(mesh.geometry)
        if (islands.length >= 2) replaceMeshWithPieces(mesh, islands)
      }
    }
    meshes = collectMeshes(root)
  }

  const objects: THREE.Object3D[] =
    meshes.length >= 2 ? meshes : root.children.filter((child) => child.visible && collectMeshes(child).length > 0)
  if (objects.length < 2) return []

  const modelCenter = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3())
  return objects.map((object) => {
    const centroid = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3())
    const dirWorld = centroid.clone().sub(modelCenter)
    if (dirWorld.lengthSq() < 1e-10) {
      dirWorld.set((object.id % 5) - 2, 1, (object.id % 3) - 1).normalize()
    }
    const parent = object.parent
    let explodeDir = dirWorld
    if (parent) {
      const localFrom = parent.worldToLocal(centroid.clone())
      const localTo = parent.worldToLocal(centroid.clone().add(dirWorld))
      explodeDir = localTo.sub(localFrom)
    }
    return { object, origin: object.position.clone(), explodeDir }
  })
}

export function applyExplode(pieces: ExplodePiece[], amount: number): void {
  for (const piece of pieces) {
    piece.object.position.copy(piece.origin).addScaledVector(piece.explodeDir, amount)
  }
}
