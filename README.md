# three.lab

three.lab, a three.js tool for viewing and making basic edits to 3D models and textures — all in the browser, no build step, no install.

I am terrible at Blender and this is much faster for what I actually need. It started as a byproduct of my interactive React Three Fiber project [Cassini](https://github.com/snes19xx/Cassini) and I figured it was worth splitting out as its own thing.

#### Lab (`Lab.html`)

The main viewer.

**Texture mode** — drop a JPG, PNG, WEBP, or KTX2 image and it wraps onto a sphere. You get material controls (roughness, metalness, normal map scale), an atmospheric glow effect with color and intensity controls, a lat/lon coordinate readout that follows your cursor across the surface, a graticule grid, and pole markers.

**Model mode** — drop a GLB or GLTF and it loads the full mesh with a triangle, vertex, and mesh count overlay.

Both modes share:

- Lighting — direct, ambient, or fully custom with azimuth, elevation, and intensity sliders
- Wireframe overlay with color picker and line weight
- Auto-rotation with speed and axial tilt controls
- Dark and light theme (remembered between sessions)
- Screenshot export
- Reset button that puts everything back to defaults

Model mode also lets you export the current view as an SVG vector, or generate a React Three Fiber component (JSX or TSX) that you can drop straight into a project.

#### Cropper (`Cropper.html`)

This lets you make actual geometry edits to a GLB, basically 'crop' a 3D glb.

You position a cut plane in 3D space using X/Y/Z position sliders and X/Y/Z rotation sliders, choose which side of the plane to keep, and apply the crop. The plane can be snapped to align with any axis. Pick whether to keep the front or back side, and a normal arrow on the plane shows you which way is which before you commit.

The crop discards every triangle on the unwanted side of the plane. You can apply multiple crops in sequence, undo each one individually (up to 12 steps back), or reload the original file to start over. When done, export the result as a `.cropped.glb`.

The two tools are connected. From Lab you can send a model directly to the Cropper, and from the Cropper you can send the edited result back to Lab without needing a file picker, it passes the buffer through IndexedDB.

### File overview

| File             | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `Lab.html`       | Main viewer entry point                                    |
| `main.js`        | UI event wiring and render loop                            |
| `scene.js`       | Three.js scene, camera, renderer, sphere, atmosphere       |
| `loaders.js`     | GLB and texture loading                                    |
| `export.js`      | Screenshot, SVG export, R3F code generation                |
| `wireframe.js`   | Custom wireframe overlay                                   |
| `lighting.js`    | Light mode presets and custom positioning                  |
| `state.js`       | Shared application state                                   |
| `handoff.js`     | Passes model buffers between Lab and Cropper via IndexedDB |
| `Cropper.html`   | Standalone plane-crop tool                                 |
| `cropper-app.js` | Cropper geometry, UI, and export logic                     |
