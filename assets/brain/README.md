# 3D fly-brain assets

`fly-brain.blend` is the editable Blender 5.2 scene, with translucent anatomical
regions, model neurons, 240 animated recorded connection paths, a camera, and a
dark world with compositor glow. Press Space to play the 108-frame illustration.
`fly-brain-dark.png` is its 1440 × 900 render. The original Blender scene is retained
when the build script runs in an existing session; it creates a separate scene.

The browser-ready model is `frontend/public/brain/flywire-brain.glb` (79 meshes,
approximately 4.8 MB). `regions.json` supplies deterministic interior sample pools
and region centers. These assets are bundled locally; the viewer does not need
remote data services, API keys, or runtime downloads from scientific repositories.

## Scientific scope

- Whole-brain outline and all 78 neuropil surfaces are published anatomical meshes.
- Node IDs, groups, edge direction and live fire events come from this project's
  existing mapping and protocol, including its MaleCNS-derived wiring.
- The model does **not** export registered 3D cell coordinates. Display positions
  are sampled in the right FlyWire antennal lobe, calyx and mushroom-body lobes.
  This is an explicitly illustrative hemisphere, not a claim about cell laterality.
  Curved routes are display paths, not reconstructed axons or measured synapses.
  FlyWire female template anatomy is context for the MaleCNS-derived model; no
  cross-specimen registration has been performed.
- All 1,958 reference nodes and 19,037 directed edges are retained by the preview.
  The main workspace renders the trained browser model's 1,959-node mapping and
  the same number of edges, with fires from its WebGPU inference runtime.
  At most 1,200 resting connection paths are drawn for legibility. **Every** declared
  edge retains a GPU pulse slot and accepts live activity. The Blender illustration
  samples 240 connections observed in the reference recording.
- Pulses represent positive model activations, not biological action potentials.
  The preview uses the bundled untrained-model recording, with synthetic playback
  timing; travel duration is a visual 0.9 seconds and is not conduction latency.

## Sources and attribution

1. Whole-brain tissue mesh: [navis-flybrains](https://github.com/navis-org/navis-flybrains),
   pinned commit `789e416b7fd8200fdc5e339ad2becc0c77ca10ba`,
   `flybrains/meshes/FLYWIRE_whole_brain.ply`.
   The tissue mask was produced by Peter Li (Google) from FAFB segmentation;
   the distributed mesh was cleaned and transformed into FlyWire space.
   The upstream mesh provenance is preserved in `source/FLYWIRE_whole_brain.md`.
2. Neuropils: [fafbseg-py](https://github.com/navis-org/fafbseg-py),
   pinned commit `00c8a0ff5044b8f81642a3e2bfc0e3aded3e960e`,
   `fafbseg/data/JFRC2NP.surf.fw.zip`. These are template neuropil surfaces in
   FlyWire space, rather than per-cell reconstructions.
3. Reference graph and activity: `harness/recordings/reference.ndjson` in this
   project; model wiring provenance is documented in `data/README.md`.
4. FlyWire connectome background: Dorkenwald et al.,
   [Neuronal wiring diagram of an adult brain](https://doi.org/10.1038/s41586-024-07558-y).

The source repositories distribute under GPL-3.0; the license text is retained in
`source/LICENSE` and `frontend/public/brain/LICENSE`. Preserve these source credits,
license, pinned source inputs and conversion scripts with redistributed derived assets.
No separate CC0 license is asserted for these meshes. SHA-256 hashes of the two
original source artifacts are in `frontend/public/brain/source-hashes.json`.

Conversion changes: center the whole-brain bounding box, scale its width to 6
display units, invert Y and Z together (orientation-preserving), compute smooth
vertex normals, and package all regions as named GLB meshes. Coordinates share
one transform, preserving region alignment. Blender's glTF importer then converts
Y-up display coordinates to Blender's Z-up convention.

## Rebuild

From the repository root, after `npm --prefix frontend ci`:

```powershell
Expand-Archive -Path assets/brain/source/JFRC2NP.surf.fw.zip -DestinationPath assets/brain/source/neuropils -Force
node scripts/build-brain-assets.mjs
node scripts/prepare-brain-preview.mjs
```

The Blender script uses Blender's own required `bpy` runtime and no external
Python packages. On this workstation, the installed Blender toolchain is launched
through its existing dedicated Conda environment:

```powershell
& C:/Users/carte/miniconda3/Scripts/conda.exe run -n blender-mcp --no-capture-output 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --python scripts/build-brain-scene.py
```

The same script can be run through Blender MCP with `__file__` set to the script's
absolute path. It saves `fly-brain.blend` and renders `fly-brain-dark.png`.

## Preview and validation

Start `npm --prefix frontend run dev`, then open
`http://127.0.0.1:5173/brain-preview.html`. Play recording animates the reference
trace; Circuit detail frames the model circuit. `/` is the real live workspace.
Both entry pages are included in the production build.

```powershell
node --test scripts/test-brain-graph.mjs
node scripts/test-brain-browser.mjs
npm --prefix frontend run lint
npm --prefix frontend run build
```

The browser test starts its own loopback Vite server on port 5175 and a separate
headless Chrome, checks shader compilation, pulse/idle pixels, orbit, reduced
motion, mobile sizing, mapping reset, and React inference/inspector integration.
It never attaches to the user's browser profile. It requires an installed Chrome
with WebGPU support and hydrated model weights (`git lfs pull`), and writes ignored
`browser-*.png` review images here. The main workspace runs actual GPU inference:
the test checks all 32 golden tokens, all 35 fire steps, visible 3D pixel changes,
and absence of backend HTTP or WebSocket requests (excluding Vite hot reload).
