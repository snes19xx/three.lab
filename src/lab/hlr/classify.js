// Decides which edges are worth drawing.
//
// Drawing every triangle edge gives the wireframe mess.
// Real line art draws four kinds of edge:
//
//   boundary   -> used by one face only; the open border of a surface
//   crease     -> the dihedral angle between its two faces is sharp enough to
//                read as a corner (a building's vertical arris, not the seam
//                across a flat wall)
//   silhouette -> one face turns toward the camera and the other away, so the
//                surface visually ends here. View-dependent.
//   material   -> its two faces belong to different materials, so there is a
//                colour change to outline even on a smooth surface
//
// Everything else is interior tessellation and should stay invisible.

export const EDGE_BOUNDARY = 1;
export const EDGE_CREASE = 2;
export const EDGE_SILHOUETTE = 4;
export const EDGE_MATERIAL = 8;

export function classifyEdges(topology, cameraPosition, options = {}) {
  const {
    creaseAngleDeg = 25,
    includeBoundary = true,
    includeCrease = true,
    includeSilhouette = true,
    includeMaterial = true,
    orthographic = false,
    viewDirection = null, // required when orthographic
  } = options;

  const { verts, normals, edges, triangleMaterial } = topology;
  const cosCrease = Math.cos((creaseAngleDeg * Math.PI) / 180);

  const [camX, camY, camZ] = cameraPosition;
  const viewX = viewDirection ? viewDirection[0] : 0;
  const viewY = viewDirection ? viewDirection[1] : 0;
  const viewZ = viewDirection ? viewDirection[2] : 0;

  // Signed distance from the camera to a face's plane. Positive means the face
  // points towards me.
  const facesCamera = (face, px, py, pz) => {
    const nx = normals[face * 3];
    const ny = normals[face * 3 + 1];
    const nz = normals[face * 3 + 2];
    if (orthographic) return -(nx * viewX + ny * viewY + nz * viewZ) > 0;
    return nx * (camX - px) + ny * (camY - py) + nz * (camZ - pz) > 0;
  };

  const result = [];

  for (const edge of edges) {
    const { v0, v1, faces } = edge;
    let kind = 0;

    if (faces.length !== 2) {
      // One face is a true border; three or more is non-manifold, and drawing
      // it is nearly always what you want.
      if (includeBoundary) kind |= EDGE_BOUNDARY;
    } else {
      const [f0, f1] = faces;

      if (includeCrease) {
        const dot =
          normals[f0 * 3] * normals[f1 * 3] +
          normals[f0 * 3 + 1] * normals[f1 * 3 + 1] +
          normals[f0 * 3 + 2] * normals[f1 * 3 + 2];
        if (dot < cosCrease) kind |= EDGE_CREASE;
      }

      if (includeMaterial && triangleMaterial[f0] !== triangleMaterial[f1]) {
        kind |= EDGE_MATERIAL;
      }

      if (includeSilhouette) {
        // Judge both faces from a point on the shared edge, so a long face
        // does not get classified by its far end.
        const px = verts[v0 * 3];
        const py = verts[v0 * 3 + 1];
        const pz = verts[v0 * 3 + 2];
        if (facesCamera(f0, px, py, pz) !== facesCamera(f1, px, py, pz)) {
          kind |= EDGE_SILHOUETTE;
        }
      }
    }

    if (kind !== 0) result.push({ v0, v1, kind, faces });
  }

  return result;
}
