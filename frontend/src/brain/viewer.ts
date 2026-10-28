import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  BrainActivity,
  buildBrainGraph,
  curvePoint,
  PULSE_SECONDS,
} from './graph';
import type { Atlas, BrainGraph, Mapping } from './graph';

const curveGLSL = `vec3 bezier(vec3 a,vec3 b,vec3 c,vec3 d,float t){float s=1.-t;return s*s*s*a+3.*s*s*t*b+3.*s*t*t*c+t*t*t*d;}`;
const pointFragment = `varying vec3 vColor; varying float vAlpha;
void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;
float glow=exp(-4.*r*r);gl_FragColor=vec4(vColor,glow*vAlpha);}`;
function destroy(root: T.Object3D) {
  root.traverse((o) => {
    if (
      o instanceof T.Mesh ||
      o instanceof T.Points ||
      o instanceof T.LineSegments
    ) {
      (o.geometry as T.BufferGeometry).dispose();
      const materials = (
        Array.isArray(o.material) ? o.material : [o.material]
      ) as T.Material[];
      for (const m of materials) m.dispose();
    }
  });
  root.clear();
}
export async function initializeBrain3D(
  canvas: HTMLCanvasElement,
  onStatus: (message: string) => void,
  labels: HTMLElement | null = null,
  options: { signal?: AbortSignal; connectionStyle?: 'lines' | 'dots' } = {},
): Promise<() => void> {
  if (options.signal?.aborted) return () => {};
  let disposed = false,
    frame = 0;
  let renderer: T.WebGLRenderer | undefined;
  let controls: OrbitControls | undefined;
  let observer: ResizeObserver | undefined;
  let atlas: Atlas | undefined,
    mapping: Mapping | null = null,
    graph: BrainGraph | null = null;
  let activity: BrainActivity | null = null;
  let nodeGeometry: T.BufferGeometry | undefined,
    pulseGeometry: T.BufferGeometry | undefined;
  let dirtyProjection = true;
  const epoch = performance.now();
  const seconds = () => (performance.now() - epoch) / 1000;
  const pendingFires = new Map<string, number>();
  const scene = new T.Scene();
  scene.background = new T.Color('#050c14');
  const camera = new T.PerspectiveCamera(37, 1, 0.01, 100);
  const anatomy = new T.Group(),
    circuit = new T.Group();
  scene.add(anatomy, circuit);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const uniforms = {
    uTime: { value: 0 },
    uReduced: { value: motion.matches ? 1 : 0 },
    uDpr: { value: 1 },
  };
  const listeners: (() => void)[] = [];
  const request = new AbortController();
  function listen<E extends Event>(
    target: EventTarget,
    type: string,
    fn: (e: E) => void,
  ) {
    const handler = fn as EventListener;
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  }
  function invalidate() {
    if (disposed || !renderer || frame || document.hidden) return;
    frame = requestAnimationFrame(draw);
  }
  function project() {
    if (!graph || !labels) return;
    camera.updateMatrixWorld();
    const width = canvas.clientWidth,
      height = canvas.clientHeight;
    const toScreen = (v: T.Vector3) => {
      v.project(camera);
      return {
        x: ((v.x + 1) * width) / 2,
        y: ((1 - v.y) * height) / 2,
        visible: v.z > -1 && v.z < 1,
      };
    };
    labels.querySelectorAll<HTMLElement>('[data-region]').forEach((el) => {
      const region = atlas?.regions[el.dataset.region!];
      if (!region) return;
      const pos = toScreen(new T.Vector3(...region.center));
      el.style.transform = `translate(${pos.x}px, ${pos.y - 18}px) translate(-50%, -100%)`;
      el.hidden = !pos.visible;
    });
    const nodes = graph.nodes
      .filter((n) => n.group === 'MBON')
      .map((n) => ({ id: n.id, ...toScreen(new T.Vector3(...n.position)) }))
      .filter((n) => n.visible);
    canvas.dispatchEvent(
      new CustomEvent('readout-layout', { detail: { nodes, width, height } }),
    );
  }
  function draw() {
    frame = 0;
    if (disposed || !renderer || document.hidden) return;
    uniforms.uTime.value = seconds();
    controls?.update();
    if (dirtyProjection) {
      project();
      dirtyProjection = false;
    }
    renderer.render(scene, camera);
    if (activity && seconds() < activity.deadline) invalidate();
  }
  function fit(circuitOnly = false) {
    const bounds =
      circuitOnly && graph?.nodes.length
        ? new T.Box3().setFromPoints(
            graph.nodes.map((n) => new T.Vector3(...n.position)),
          )
        : new T.Box3(
            new T.Vector3(-3, -1.65, -1.5),
            new T.Vector3(3, 1.65, 1.5),
          );
    const center = bounds.getCenter(new T.Vector3());
    const size = bounds.getSize(new T.Vector3());
    const distance =
      (Math.max(size.y, size.x / Math.max(camera.aspect, 0.2)) /
        (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)))) *
        1.28 +
      size.z / 2;
    controls?.target.copy(center);
    camera.position
      .copy(center)
      .add(new T.Vector3(0.12, 0.08, 1).normalize().multiplyScalar(distance));
    camera.lookAt(center);
    controls?.update();
    dirtyProjection = true;
    invalidate();
  }
  function clearCircuit() {
    destroy(circuit);
    graph = null;
    activity = null;
    nodeGeometry = pulseGeometry = undefined;
    pendingFires.clear();
    labels?.replaceChildren();
    delete canvas.dataset.nodes;
    delete canvas.dataset.edges;
    canvas.dispatchEvent(
      new CustomEvent('readout-layout', {
        detail: {
          nodes: [],
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        },
      }),
    );
  }
  function installMapping() {
    if (!atlas || !mapping || disposed) return;
    destroy(circuit);
    graph = buildBrainGraph(mapping, atlas);
    activity = new BrainActivity(graph);
    for (const [key, time] of pendingFires) {
      const pair = key.split(',').map(Number) as [number, number];
      if (seconds() - time < PULSE_SECONDS) activity.fire([pair], time);
    }
    pendingFires.clear();
    const positions = graph.nodes.flatMap((n) => n.position),
      colors = graph.nodes.flatMap((n) => n.color);
    nodeGeometry = new T.BufferGeometry();
    nodeGeometry.setAttribute(
      'position',
      new T.Float32BufferAttribute(positions, 3),
    );
    nodeGeometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
    nodeGeometry.setAttribute(
      'aStart',
      new T.BufferAttribute(activity.nodes, 1).setUsage(T.DynamicDrawUsage),
    );
    nodeGeometry.setAttribute(
      'aSelected',
      new T.Float32BufferAttribute(new Float32Array(graph.nodes.length), 1),
    );
    const nodeMaterial = new T.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      vertexShader: `attribute vec3 color; attribute float aStart; attribute float aSelected; uniform float uTime;uniform float uDpr;varying vec3 vColor;varying float vAlpha;
      void main(){float age=uTime-aStart;float hot=step(0.,age)*(1.-smoothstep(0.,${PULSE_SECONDS},age));vec4 p=modelViewMatrix*vec4(position,1.);
      gl_Position=projectionMatrix*p;gl_PointSize=clamp((1.8+hot*2.4+aSelected*5.)*uDpr*5./max(2.,-p.z),1.,18.);
      vColor=mix(color,vec3(1.),hot*.5+aSelected*.5);vAlpha=.32+hot*.4;}`,
      fragmentShader: pointFragment,
    });
    circuit.add(new T.Points(nodeGeometry, nodeMaterial));
    const linePositions: number[] = [],
      lineColors: number[] = [];
    // Static context is sampled to avoid an opaque knot. Every edge still has a
    // pulse slot, so live activity is never sampled or dropped by this budget.
    const contextStride = Math.max(1, Math.ceil(graph.edges.length / 1200));
    for (
      let edgeIndex = 0;
      edgeIndex < graph.edges.length;
      edgeIndex += contextStride
    ) {
      const edge = graph.edges[edgeIndex]!;
      const color = graph.nodes[graph.slots.get(edge.source)!]!.color;
      for (let s = 0; s < 12; s++) {
        linePositions.push(
          ...curvePoint(edge.points, s / 12),
          ...curvePoint(edge.points, (s + 1) / 12),
        );
        lineColors.push(...color, ...color);
      }
    }
    const lines = new T.BufferGeometry();
    lines.setAttribute(
      'position',
      new T.Float32BufferAttribute(linePositions, 3),
    );
    lines.setAttribute('color', new T.Float32BufferAttribute(lineColors, 3));
    circuit.add(
      new T.LineSegments(
        lines,
        new T.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: options.connectionStyle === 'lines' ? 0.1 : 0.045,
          depthWrite: false,
          blending: T.NormalBlending,
        }),
      ),
    );
    pulseGeometry = new T.BufferGeometry();
    for (let i = 0; i < 4; i++)
      pulseGeometry.setAttribute(
        i === 0 ? 'position' : `aP${i}`,
        new T.Float32BufferAttribute(
          graph.edges.flatMap((e) => e.points[i]!),
          3,
        ),
      );
    pulseGeometry.setAttribute(
      'color',
      new T.Float32BufferAttribute(
        graph.edges.flatMap(
          (e) => graph!.nodes[graph!.slots.get(e.source)!]!.color,
        ),
        3,
      ),
    );
    pulseGeometry.setAttribute(
      'aStart',
      new T.BufferAttribute(activity.edges, 1).setUsage(T.DynamicDrawUsage),
    );
    // One GPU animated particle per real directed edge; event traffic only updates timestamps.
    const pulses = new T.Points(
      pulseGeometry,
      new T.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
        vertexShader: `${curveGLSL} attribute vec3 aP1;attribute vec3 aP2;attribute vec3 aP3;attribute vec3 color;attribute float aStart;
      uniform float uTime;uniform float uReduced;uniform float uDpr;varying vec3 vColor;varying float vAlpha;
      void main(){float age=(uTime-aStart)/${PULSE_SECONDS};float alive=step(0.,age)*(1.-step(1.,age));
      float t=mix(clamp(age,0.,1.),.5,uReduced);vec3 p=bezier(position,aP1,aP2,aP3,t);vec4 mv=modelViewMatrix*vec4(p,1.);
      gl_Position=projectionMatrix*mv;gl_PointSize=clamp(5.5*uDpr*5./max(2.,-mv.z),2.,14.);vColor=mix(color,vec3(1.),.7);vAlpha=alive*(1.-age*.4)*.65;}`,
        fragmentShader: pointFragment,
      }),
    );
    pulses.frustumCulled = false;
    circuit.add(pulses);
    labels?.replaceChildren(
      ...[
        ['AL_R', 'ANTENNAL LOBE'],
        ['MB_CA_R', 'KENYON CELLS'],
        ['MB_ML_R', 'MB OUTPUT'],
      ].map(([region, name]) => {
        const el = document.createElement('span');
        el.dataset.region = region!;
        el.textContent = name!;
        return el;
      }),
    );
    canvas.dataset.nodes = String(graph.nodes.length);
    canvas.dataset.edges = String(graph.edges.length);
    dirtyProjection = true;
    invalidate();
    onStatus(
      `3D ready. ${graph.nodes.length.toLocaleString()} model nodes and ${graph.edges.length.toLocaleString()} directed edges. FlyWire anatomical context; illustrative positions.`,
    );
  }
  function select(id: number | null) {
    const attr = nodeGeometry?.getAttribute('aSelected');
    if (attr && graph) {
      for (let i = 0; i < graph.nodes.length; i++)
        attr.setX(i, graph.nodes[i]!.id === id ? 1 : 0);
      attr.needsUpdate = true;
    }
    invalidate();
  }
  listen<CustomEvent<Mapping>>(canvas, 'mapping', (e) => {
    clearCircuit();
    mapping = e.detail;
    installMapping();
  });
  listen(canvas, 'reset', () => {
    mapping = null;
    clearCircuit();
    invalidate();
  });
  listen<CustomEvent<{ pairs: [number, number][] }>>(canvas, 'fire', (e) => {
    if (activity?.fire(e.detail.pairs, seconds())) {
      nodeGeometry!.getAttribute('aStart').needsUpdate = true;
      pulseGeometry!.getAttribute('aStart').needsUpdate = true;
      invalidate();
    } else if (!atlas && mapping) {
      for (const pair of e.detail.pairs)
        pendingFires.set(pair.join(','), seconds());
    }
  });
  listen<CustomEvent<{ id: number | null }>>(canvas, 'select-node', (e) =>
    select(e.detail.id),
  );
  listen(canvas, 'fit', () => fit());
  listen(canvas, 'focus-circuit', () => fit(true));
  listen<CustomEvent<number>>(canvas, 'zoom', (e) => {
    if (!controls || !Number.isFinite(e.detail) || e.detail <= 0) return;
    const offset = camera.position
      .clone()
      .sub(controls.target)
      .divideScalar(e.detail);
    offset.clampLength(controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    invalidate();
  });
  let down: { x: number; y: number } | null = null;
  listen<PointerEvent>(canvas, 'pointerdown', (e) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    canvas.focus({ preventScroll: true });
  });
  listen(canvas, 'pointercancel', () => {
    down = null;
  });
  listen<PointerEvent>(canvas, 'pointerup', (e) => {
    if (
      !down ||
      Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 ||
      !graph
    ) {
      down = null;
      return;
    }
    down = null;
    const rect = canvas.getBoundingClientRect();
    let best = 11 * 11,
      id: number | null = null;
    camera.updateMatrixWorld();
    for (const n of graph.nodes) {
      const p = new T.Vector3(...n.position).project(camera);
      if (p.z < -1 || p.z > 1) continue;
      const distance =
        (((p.x + 1) * rect.width) / 2 - e.clientX + rect.left) ** 2 +
        (((1 - p.y) * rect.height) / 2 - e.clientY + rect.top) ** 2;
      if (distance < best) {
        best = distance;
        id = n.id;
      }
    }
    select(id);
    canvas.dispatchEvent(new CustomEvent('node-select', { detail: { id } }));
  });
  listen<KeyboardEvent>(canvas, 'keydown', (e) => {
    if (!controls) return;
    if (e.key === '0' || e.key === 'Home') fit();
    else if (e.key === '+' || e.key === '=' || e.key === '-')
      canvas.dispatchEvent(
        new CustomEvent('zoom', { detail: e.key === '-' ? 0.8 : 1.25 }),
      );
    else if (e.key.startsWith('Arrow')) {
      const offset = camera.position.clone().sub(controls.target);
      const sphere = new T.Spherical().setFromVector3(offset);
      if (e.key === 'ArrowLeft') sphere.theta -= 0.1;
      if (e.key === 'ArrowRight') sphere.theta += 0.1;
      if (e.key === 'ArrowUp') sphere.phi -= 0.1;
      if (e.key === 'ArrowDown') sphere.phi += 0.1;
      sphere.makeSafe();
      camera.position
        .copy(controls.target)
        .add(new T.Vector3().setFromSpherical(sphere));
      controls.update();
    } else if (e.key === 'Escape') {
      select(null);
      canvas.dispatchEvent(
        new CustomEvent('node-select', { detail: { id: null } }),
      );
    } else return;
    e.preventDefault();
    invalidate();
  });
  listen(document, 'visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else invalidate();
  });
  listen(motion, 'change', () => {
    uniforms.uReduced.value = motion.matches ? 1 : 0;
    invalidate();
  });
  listen(canvas, 'webglcontextlost', (e) => {
    e.preventDefault();
    onStatus('3D graphics context lost. Reload to restore the viewer.');
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    request.abort();
    observer?.disconnect();
    controls?.dispose();
    listeners.splice(0).forEach((fn) => fn());
    destroy(anatomy);
    clearCircuit();
    renderer?.dispose();
    delete canvas.dataset.layout;
    delete canvas.dataset.nodes;
    delete canvas.dataset.edges;
  };
  listen(options.signal ?? request.signal, 'abort', dispose);
  try {
    onStatus('Loading 3D FlyWire anatomy…');
    renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    uniforms.uDpr.value = renderer.getPixelRatio();
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.minDistance = 0.5;
    controls.maxDistance = 40;
    controls.addEventListener('change', () => {
      dirtyProjection = true;
      invalidate();
    });
    observer = new ResizeObserver(() => {
      if (!renderer) return;
      const w = Math.max(1, canvas.clientWidth),
        h = Math.max(1, canvas.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirtyProjection = true;
      invalidate();
    });
    observer.observe(canvas);
    camera.aspect =
      Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();
    fit();
    const base = `${import.meta.env.BASE_URL}brain/`;
    const responses = await Promise.all([
      fetch(`${base}flywire-brain.glb`, { signal: request.signal }),
      fetch(`${base}regions.json`, { signal: request.signal }),
    ]);
    if (responses.some((r) => !r.ok))
      throw new Error('The bundled brain geometry could not be loaded');
    const [binary, metadata] = await Promise.all([
      responses[0].arrayBuffer(),
      responses[1].json() as Promise<Atlas>,
    ]);
    if (disposed) return dispose;
    const gltf = await new GLTFLoader().parseAsync(binary, base);
    if (disposed) {
      destroy(gltf.scene);
      return dispose;
    }
    atlas = metadata;
    gltf.scene.traverse((o) => {
      if (!(o instanceof T.Mesh)) return;
      const materials = (
        Array.isArray(o.material) ? o.material : [o.material]
      ) as T.Material[];
      for (const m of materials) m.dispose();
      const region = atlas!.regions[o.name];
      const isShell = o.name === 'Whole_brain';
      const isCircuit = /^(MB_|AL_)/.test(o.name);
      o.material = new T.ShaderMaterial({
        transparent: true,
        side: T.DoubleSide,
        depthWrite: false,
        blending: T.AdditiveBlending,
        uniforms: {
          tint: { value: new T.Color(...(region?.color ?? [0.25, 0.5, 0.6])) },
          opacity: { value: isShell ? 0.09 : isCircuit ? 0.3 : 0.11 },
        },
        vertexShader:
          'varying vec3 n;varying vec3 v;void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=normalize(-p.xyz);gl_Position=projectionMatrix*p;}',
        fragmentShader:
          'uniform vec3 tint;uniform float opacity;varying vec3 n;varying vec3 v;void main(){float rim=pow(1.-abs(dot(normalize(n),normalize(v))),2.);float light=.3+.7*abs(dot(normalize(n),normalize(vec3(-.3,.7,1.))));gl_FragColor=vec4(tint*(.6+rim*.9),opacity*(.12+rim*.88)*light);}',
      });
    });
    anatomy.add(gltf.scene);
    canvas.dataset.layout = 'brain3d';
    if (mapping) installMapping();
    else onStatus('3D anatomy ready. Waiting for live model activity.');
    invalidate();
  } catch (error) {
    if (!disposed) {
      dispose();
      onStatus(
        `3D renderer unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return dispose;
}
