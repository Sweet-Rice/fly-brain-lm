"""Run in Blender's bpy runtime (MCP or Blender --background --python).

Creates a new scene, preserving existing scenes. Inputs are produced by the two
Node asset scripts. No third-party Python packages are required.
"""
import bpy
import json
import math
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'brain'
data = json.loads((OUT / 'preview-circuit.json').read_text())
atlas = json.loads((ROOT / 'frontend/public/brain/regions.json').read_text())
scene = bpy.data.scenes.new('Fly Brain LM — anatomical activity')
bpy.context.window.scene = scene
bpy.ops.import_scene.gltf(filepath=str(ROOT / 'frontend/public/brain/flywire-brain.glb'))
anatomy = list(scene.objects)

def emission(name, color, strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out = nodes.new('ShaderNodeOutputMaterial')
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (*color, 1)
    emit.inputs['Strength'].default_value = strength
    mat.node_tree.links.new(emit.outputs[0], out.inputs['Surface'])
    return mat

def glass(name, color, opacity):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out = nodes.new('ShaderNodeOutputMaterial')
    mix = nodes.new('ShaderNodeMixShader')
    transparent = nodes.new('ShaderNodeBsdfTransparent')
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (*color, 1)
    emit.inputs['Strength'].default_value = 0.8
    layer = nodes.new('ShaderNodeLayerWeight')
    layer.inputs['Blend'].default_value = 0.3
    multiply = nodes.new('ShaderNodeMath')
    multiply.operation = 'MULTIPLY'
    multiply.inputs[1].default_value = opacity
    links = mat.node_tree.links
    links.new(layer.outputs['Facing'], multiply.inputs[0])
    links.new(multiply.outputs[0], mix.inputs[0])
    links.new(transparent.outputs[0], mix.inputs[1])
    links.new(emit.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs['Surface'])
    return mat

for obj in anatomy:
    if obj.type != 'MESH':
        continue
    region = atlas['regions'].get(obj.name)
    color = region['color'] if region else [0.15, 0.35, 0.45]
    opacity = 0.055 if obj.name == 'Whole_brain' else (0.22 if obj.name.startswith(('MB_', 'AL_')) else 0.095)
    obj.data.materials.clear()
    obj.data.materials.append(glass('Anatomy / ' + obj.name, color, opacity))
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj['source'] = 'FlyWire template anatomy from navis-flybrains / fafbseg'

def point(p):
    # glTF uses Y up; Blender's importer converts to Z up.
    return (p[0], -p[2], p[1])

def bezier(points, t):
    s = 1 - t
    return [s**3 * points[0][a] + 3*s*s*t*points[1][a] + 3*s*t*t*points[2][a] + t**3*points[3][a] for a in range(3)]

# Shared neuron sphere topology, joined by model group to keep the scene responsive.
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1)
template = bpy.context.object
verts = [tuple(v.co) for v in template.data.vertices]
faces = [tuple(p.vertices) for p in template.data.polygons]
bpy.data.objects.remove(template, do_unlink=True)
groups = {}
for n in data['nodes']:
    groups.setdefault(n['group'], []).append(n)
for name, neurons in groups.items():
    vertices, polygons = [], []
    radius = 0.007 if name.startswith('KC') else 0.013
    for n in neurons:
        offset = len(vertices)
        p = point(n['position'])
        vertices.extend(tuple(p[a] + v[a] * radius for a in range(3)) for v in verts)
        polygons.extend(tuple(i + offset for i in f) for f in faces)
    mesh = bpy.data.meshes.new('Neuron geometry / ' + name)
    mesh.from_pydata(vertices, [], polygons)
    obj = bpy.data.objects.new(name + ' / model neurons', mesh)
    scene.collection.objects.link(obj)
    obj.data.materials.append(emission('Neurons / ' + name, neurons[0]['color'], 1.3))
    obj['model_node_ids'] = [n['id'] for n in neurons]
    obj['placement'] = 'Illustrative sampling within right-side FlyWire neuropils; NOT measured MaleCNS neuron coordinates.'

nodes_by_id = {n['id']: n for n in data['nodes']}
edge_by_pair = {(e['source'], e['target']): e for e in data['edges']}
recorded_pairs = list(dict.fromkeys(tuple(pair) for f in data['fires'] for pair in f['pairs']))
stride = max(1, len(recorded_pairs) // 240)
preview_edges = [edge_by_pair[p] for p in recorded_pairs[::stride][:240] if p in edge_by_pair]
path_material = emission('Axonal routes / subdued cyan', (0.13, 0.45, 0.54), 0.4)
curve = bpy.data.curves.new('Recorded connection paths', 'CURVE')
curve.dimensions = '3D'
curve.bevel_depth = 0.0012
curve.bevel_resolution = 1
for e in preview_edges:
    spline = curve.splines.new('POLY')
    spline.points.add(24)
    for i, p in enumerate(spline.points):
        p.co = (*point(bezier(e['points'], i / 24)), 1)
path_obj = bpy.data.objects.new('Directed routes / recorded edge subset', curve)
scene.collection.objects.link(path_obj)
curve.materials.append(path_material)
path_obj['note'] = f'{len(preview_edges)} edges sampled from recorded model fires; full {len(data["edges"])}-edge graph is in the interactive viewer.'

pulse_material = emission('Signal cores / ice-white bloom', (0.55, 0.91, 1), 7)
pulse_mesh = bpy.data.meshes.new('Shared signal particle')
pulse_mesh.from_pydata([tuple(c * 0.009 for c in v) for v in verts], [], faces)
pulse_mesh.materials.append(pulse_material)
for idx, e in enumerate(preview_edges):
    obj = bpy.data.objects.new(f'Signal {e["source"]} to {e["target"]}', pulse_mesh)
    scene.collection.objects.link(obj)
    obj['source_node'] = e['source']
    obj['target_node'] = e['target']
    phase = idx % 54
    for frame in range(1, 109, 2):
        t = ((frame + phase) % 54) / 53
        obj.location = point(bezier(e['points'], t))
        obj.keyframe_insert(data_path='location', frame=frame)
        size = 0.0 if t < 0.025 or t > 0.975 else 1.0
        obj.scale = (size, size, size)
        obj.keyframe_insert(data_path='scale', frame=frame)

world = bpy.data.worlds.new('Midnight / dark-background render')
world.use_nodes = True
background = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
background.inputs['Color'].default_value = (0.002, 0.006, 0.012, 1)
background.inputs['Strength'].default_value = 0.3
scene.world = world
camera_data = bpy.data.cameras.new('Whole-brain portrait')
camera = bpy.data.objects.new('Camera / whole brain', camera_data)
scene.collection.objects.link(camera)
camera.location = (0.65, -10.5, 0.65)
direction = Vector((0, 0, 0)) - camera.location
camera.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
camera_data.type = 'ORTHO'
camera_data.ortho_scale = 7.2
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.cycles.transparent_max_bounces = 32
scene.render.resolution_x = 1440
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
formats = [i.identifier for i in scene.render.image_settings.bl_rna.properties['file_format'].enum_items]
scene.render.image_settings.file_format = next(x for x in formats if x == 'PNG')
scene.render.filepath = str(OUT / 'fly-brain-dark.png')
scene.render.fps = 30
scene.frame_start = 1
scene.frame_end = 108
scene.frame_set(24)
scene['data_provenance'] = 'Real FlyWire whole-brain and neuropil meshes; project reference model graph. Positions and route shapes are illustrative, not registered cell reconstructions. Pulses illustrate recorded positive model activations, not biological spikes.'
scene['instructions'] = 'Space plays sampled recorded-edge pulse animation. Browser viewer renders every model edge and consumes live telemetry. Sources: assets/brain/README.md.'

# Blender 5 uses a compositor node group; older supported releases use scene.node_tree.
scene.use_nodes = True
tree = getattr(scene, 'node_tree', None)
if tree is None and hasattr(scene, 'compositing_node_group'):
    tree = bpy.data.node_groups.new('Fly Brain / soft optical bloom', 'CompositorNodeTree')
    scene.compositing_node_group = tree
if tree:
    tree.nodes.clear()
    layers = tree.nodes.new('CompositorNodeRLayers')
    layers.scene = scene
    glare = tree.nodes.new('CompositorNodeGlare')
    if 'Type' in glare.inputs:
        glare.inputs['Type'].default_value = 'Fog Glow'
        glare.inputs['Threshold'].default_value = 1.5
    else:
        glare.glare_type = 'FOG_GLOW'
        glare.threshold = 1.5
    try:
        output = tree.nodes.new('CompositorNodeComposite')
        tree.links.new(layers.outputs['Image'], glare.inputs['Image'])
        tree.links.new(glare.outputs['Image'], output.inputs['Image'])
    except RuntimeError:
        tree.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        output = tree.nodes.new('NodeGroupOutput')
        tree.links.new(layers.outputs['Image'], glare.inputs['Image'])
        tree.links.new(glare.outputs['Image'], output.inputs['Image'])

for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.overlay.show_overlays = False

bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'fly-brain.blend'))
print(f'Created {len(anatomy)} anatomical objects and {len(preview_edges)} animated signals', flush=True)
bpy.ops.render.render(write_still=True)
print('DARK_BRAIN_RENDER_COMPLETE', flush=True)
