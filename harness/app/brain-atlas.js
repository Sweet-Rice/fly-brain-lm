export const COLORS = [
  [0.35, 0.79, 1],
  [0.56, 0.88, 0.56],
  [1, 0.72, 0.35],
  [0.82, 0.57, 1],
  [1, 0.49, 0.62],
  [0.35, 0.87, 0.79],
];

export const GROUP_STYLES = {
  Glomerulus: {
    color: [0.45, 0.85, 0.45],
    placement: 'Antennal lobe',
    anatomical: true,
  },
  KC_gamma: {
    color: [0.30, 0.88, 0.97],
    placement: 'Calyx · γ sector',
    anatomical: true,
  },
  KC_alphabeta: {
    color: [0.25, 0.78, 0.68],
    placement: 'Calyx · α/β sector',
    anatomical: true,
  },
  KC_alphaprime_betaprime: {
    color: [0.42, 0.58, 1.00],
    placement: 'Calyx · α′/β′ sector',
    anatomical: true,
  },
  MBON: {
    color: [1.00, 0.72, 0.28],
    placement: 'Lobe of input KC group',
    anatomical: true,
  },
};

export function groupStyle(group, index = 0) {
  const name = group?.name;
  if (name && Object.hasOwn(GROUP_STYLES, name)) {
    const style = GROUP_STYLES[name];
    return {
      color: [...style.color],
      placement: style.placement,
      anatomical: style.anatomical,
    };
  }
  const color = COLORS[(index ?? 0) % COLORS.length];
  return {
    color: [...color],
    placement: 'Grouped grid',
    anatomical: false,
  };
}

// Base template dimensions and waypoints (at scale = 1.0)
export const BASE_AREAS = {
  AL: { x: -150, y: 230, r: 52 },
  calyx: { x: -380, y: -200, r: 216 },
  lobes: {
    gamma: { x: -55, y: 40, r: 22 },
    alphabeta: { x: -110, y: -180, r: 22 },
    alphaprime_betaprime: { x: -110, y: -90, r: 22 },
    shared: { x: -110, y: 40, r: 22 },
  },
  peduncle: { x: -175, y: -15 },
  tracts: {
    alToCalyx: { x: -110, y: -20 },
    calyxToLobe: { x: -175, y: -15 },
  },
};

export function computeCalyxSectors(mapping = null) {
  const kcGroups = ['KC_gamma', 'KC_alphabeta', 'KC_alphaprime_betaprime'];
  const kcCounts = {};
  if (mapping?.groups) {
    const grouped = new Map(mapping.groups.map(g => [g.id, 0]));
    if (mapping.nodes) {
      for (const n of mapping.nodes) {
        if (grouped.has(n.group)) grouped.set(n.group, grouped.get(n.group) + 1);
      }
    }
    for (const name of kcGroups) {
      const g = mapping.groups.find(gr => gr.name === name);
      kcCounts[name] = g ? (grouped.get(g.id) ?? 0) : 0;
    }
  }
  const totalKCs = Object.values(kcCounts).reduce((a, b) => a + b, 0);

  const minFraction = 0.12;
  const fractions = {};
  if (totalKCs > 0) {
    let unallocated = 1.0;
    let variableTotal = 0;
    for (const name of kcGroups) {
      const rawFrac = kcCounts[name] / totalKCs;
      if (rawFrac <= minFraction) {
        fractions[name] = minFraction;
        unallocated -= minFraction;
      } else {
        variableTotal += rawFrac;
      }
    }
    for (const name of kcGroups) {
      if (!fractions[name]) {
        fractions[name] = (kcCounts[name] / totalKCs / variableTotal) * unallocated;
      }
    }
  } else {
    for (const name of kcGroups) {
      fractions[name] = 1 / kcGroups.length;
    }
  }

  let curAngle = (-105 * Math.PI) / 180;
  const calyxSectorAngles = {};
  for (const name of kcGroups) {
    const span = fractions[name] * 2 * Math.PI;
    calyxSectorAngles[name] = { theta0: curAngle, theta1: curAngle + span, count: kcCounts[name] ?? 0 };
    curAngle += span;
  }
  return calyxSectorAngles;
}

export function getBrainAreas(scale = 1.0, calyxSectorAnglesOrMapping = null) {
  const s = scale;
  const sectors = {};
  let angles;
  if (calyxSectorAnglesOrMapping?.groups) {
    angles = computeCalyxSectors(calyxSectorAnglesOrMapping);
  } else if (calyxSectorAnglesOrMapping && !calyxSectorAnglesOrMapping.KC_gamma) {
    angles = computeCalyxSectors(calyxSectorAnglesOrMapping);
  } else if (calyxSectorAnglesOrMapping) {
    angles = calyxSectorAnglesOrMapping;
  } else {
    angles = computeCalyxSectors(null);
  }
  for (const [key, span] of Object.entries(angles)) {
    sectors[key] = {
      type: 'sector',
      x: BASE_AREAS.calyx.x * s,
      y: BASE_AREAS.calyx.y * s,
      r: BASE_AREAS.calyx.r * s,
      theta0: span.theta0,
      theta1: span.theta1,
    };
  }

  return {
    AL: {
      type: 'circle',
      x: BASE_AREAS.AL.x * s,
      y: BASE_AREAS.AL.y * s,
      r: BASE_AREAS.AL.r * s,
    },
    calyx: {
      type: 'circle',
      x: BASE_AREAS.calyx.x * s,
      y: BASE_AREAS.calyx.y * s,
      r: BASE_AREAS.calyx.r * s,
      sectors,
    },
    lobes: {
      gamma: {
        type: 'circle',
        x: BASE_AREAS.lobes.gamma.x * s,
        y: BASE_AREAS.lobes.gamma.y * s,
        r: BASE_AREAS.lobes.gamma.r * s,
      },
      alphabeta: {
        type: 'circle',
        x: BASE_AREAS.lobes.alphabeta.x * s,
        y: BASE_AREAS.lobes.alphabeta.y * s,
        r: BASE_AREAS.lobes.alphabeta.r * s,
      },
      alphaprime_betaprime: {
        type: 'circle',
        x: BASE_AREAS.lobes.alphaprime_betaprime.x * s,
        y: BASE_AREAS.lobes.alphaprime_betaprime.y * s,
        r: BASE_AREAS.lobes.alphaprime_betaprime.r * s,
      },
      shared: {
        type: 'circle',
        x: BASE_AREAS.lobes.shared.x * s,
        y: BASE_AREAS.lobes.shared.y * s,
        r: BASE_AREAS.lobes.shared.r * s,
      },
    },
    peduncle: {
      x: BASE_AREAS.peduncle.x * s,
      y: BASE_AREAS.peduncle.y * s,
    },
    tracts: {
      alToCalyx: {
        x: BASE_AREAS.tracts.alToCalyx.x * s,
        y: BASE_AREAS.tracts.alToCalyx.y * s,
      },
      calyxToLobe: {
        x: BASE_AREAS.tracts.calyxToLobe.x * s,
        y: BASE_AREAS.tracts.calyxToLobe.y * s,
      },
    },
  };
}

export function isInsideArea(point, area, tolerance = 1e-2) {
  if (!point || !area) return false;
  if (area.type === 'circle') {
    return Math.hypot(point.x - area.x, point.y - area.y) <= area.r + tolerance;
  }
  if (area.type === 'sector') {
    const dist = Math.hypot(point.x - area.x, point.y - area.y);
    if (dist > area.r + tolerance) return false;
    if (dist < 1e-6) return true;
    let angle = Math.atan2(point.y - area.y, point.x - area.x);
    while (angle < area.theta0 - tolerance) angle += 2 * Math.PI;
    while (angle >= area.theta0 + 2 * Math.PI - tolerance) angle -= 2 * Math.PI;
    return angle >= area.theta0 - tolerance && angle <= area.theta1 + tolerance;
  }
  return false;
}

export function isInsidePolygon(point, polygon) {
  if (!point || !polygon || polygon.length < 3) return false;
  let inside = false;
  const x = point.x, y = point.y;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function catmullRomToPoints(controlPoints, numSegmentsPerSpan = 8, closed = true) {
  const pts = [];
  const n = controlPoints.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = controlPoints[(i - 1 + n) % n];
    const p1 = controlPoints[i];
    const p2 = controlPoints[(i + 1) % n];
    const p3 = controlPoints[(i + 2) % n];
    for (let s = 0; s < numSegmentsPerSpan; s++) {
      const t = s / numSegmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (
        (2 * p1[0]) +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
      );
      const y = 0.5 * (
        (2 * p1[1]) +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
      );
      pts.push([x, y]);
    }
  }
  return pts;
}

const CENTRAL_BRAIN_LEFT_CP = [
  [0, -320],      // dorsal midline notch
  [-160, -380],   // medial dorsal rise
  [-320, -445],   // dorsal crest
  [-450, -445],   // dorsal shoulder above calyx
  [-570, -395],   // dorsal-lateral shoulder
  [-625, -290],   // upper lateral edge
  [-640, -160],   // lateral crest
  [-615, -20],    // mid lateral edge
  [-530, 80],     // optic lobe junction
  [-440, 160],    // narrowing to SEZ
  [-330, 240],    // SEZ upper
  [-230, 320],    // SEZ lower
  [-130, 380],    // ventral curve
  [0, 390],       // ventral midline bottom
];

export function getCentralBrainPolygon(scale = 1.0) {
  const leftHalf = CENTRAL_BRAIN_LEFT_CP.map(([x, y]) => [x * scale, y * scale]);
  const rightHalf = leftHalf.slice(1, -1).reverse().map(([x, y]) => [-x, y]);
  const cp = leftHalf.concat(rightHalf);
  return catmullRomToPoints(cp, 6, true);
}

// Ear-clipping triangulation for simple polygons
export function triangulatePolygon(vertices) {
  const n = vertices.length;
  if (n < 3) return [];
  const indices = Array.from({ length: n }, (_, i) => i);
  const triangles = [];

  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += vertices[i][0] * vertices[j][1] - vertices[j][0] * vertices[i][1];
  }
  if (area < 0) indices.reverse();

  function isEar(i0, i1, i2) {
    const p0 = vertices[i0], p1 = vertices[i1], p2 = vertices[i2];
    const cp = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    if (cp <= 1e-7) return false;
    for (let k = 0; k < indices.length; k++) {
      const idx = indices[k];
      if (idx === i0 || idx === i1 || idx === i2) continue;
      const p = vertices[idx];
      const cp1 = (p1[0] - p0[0]) * (p[1] - p0[1]) - (p1[1] - p0[1]) * (p[0] - p0[0]);
      const cp2 = (p2[0] - p1[0]) * (p[1] - p1[1]) - (p2[1] - p1[1]) * (p[0] - p1[0]);
      const cp3 = (p0[0] - p2[0]) * (p[1] - p2[1]) - (p0[1] - p2[1]) * (p[0] - p2[0]);
      if (cp1 >= -1e-7 && cp2 >= -1e-7 && cp3 >= -1e-7) return false;
    }
    return true;
  }

  let count = indices.length;
  let curr = 0;
  let iterations = 0;
  while (count > 2 && iterations < n * 4) {
    const prev = (curr - 1 + count) % count;
    const next = (curr + 1) % count;
    const i0 = indices[prev], i1 = indices[curr], i2 = indices[next];
    if (isEar(i0, i1, i2)) {
      triangles.push([vertices[i0], vertices[i1], vertices[i2]]);
      indices.splice(curr, 1);
      count--;
      curr = prev % count;
    } else {
      curr = (curr + 1) % count;
    }
    iterations++;
  }
  return triangles;
}

export function buildBrainRegions(scale = 1.0, calyxSectorAngles = null, callouts = []) {
  const s = scale;
  const vertices = [];

  function triangle(a, b, c, color, alpha) {
    for (const [x, y] of [a, b, c]) {
      vertices.push(x, y, color[0], color[1], color[2], alpha, -1);
    }
  }

  // Widths are authored in template units; the real capture fits at ~0.4 px per unit,
  // so strokes are doubled to stay ~1–1.5 CSS px wide instead of sub-pixel.
  const STROKE_SCALE = 2;

  function polyline(pts, color, alpha, width = 1.5, closed = false) {
    const n = pts.length;
    const count = closed ? n : n - 1;
    const half = (width * STROKE_SCALE) / 2;
    for (let i = 0; i < count; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;
      const p1 = [a[0] + nx, a[1] + ny];
      const p2 = [a[0] - nx, a[1] - ny];
      const p3 = [b[0] - nx, b[1] - ny];
      const p4 = [b[0] + nx, b[1] + ny];
      triangle(p1, p2, p3, color, alpha);
      triangle(p1, p3, p4, color, alpha);
    }
  }

  function circleFill(cx, cy, r, color, alpha, segments = 48) {
    for (let i = 0; i < segments; i++) {
      const a = (i * 2 * Math.PI) / segments;
      const b = ((i + 1) * 2 * Math.PI) / segments;
      triangle([cx, cy], [cx + r * Math.cos(a), cy + r * Math.sin(a)], [cx + r * Math.cos(b), cy + r * Math.sin(b)], color, alpha);
    }
  }

  function circleOutline(cx, cy, r, color, alpha, width = 1.5, segments = 48) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const a = (i * 2 * Math.PI) / segments;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    polyline(pts, color, alpha, width, true);
  }

  function ellipseFill(cx, cy, rx, ry, color, alpha, segments = 48) {
    for (let i = 0; i < segments; i++) {
      const a = (i * 2 * Math.PI) / segments;
      const b = ((i + 1) * 2 * Math.PI) / segments;
      triangle([cx, cy], [cx + rx * Math.cos(a), cy + ry * Math.sin(a)], [cx + rx * Math.cos(b), cy + ry * Math.sin(b)], color, alpha);
    }
  }

  function ellipseOutline(cx, cy, rx, ry, color, alpha, width = 1.5, segments = 48) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const a = (i * 2 * Math.PI) / segments;
      pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    polyline(pts, color, alpha, width, true);
  }

  const slateColor = [0.45, 0.52, 0.62];
  const greenColor = [0.45, 0.85, 0.45];
  const cyanColor = [0.30, 0.85, 0.90];
  const peduncleColor = [0.35, 0.65, 0.85];
  const amberColor = [1.00, 0.72, 0.28];
  const canvasColor = [0.039, 0.051, 0.071];

  // 1. Central brain outline and fill (smooth, >=48 segments)
  const centralBrainPoly = getCentralBrainPolygon(s);
  const cbTris = triangulatePolygon(centralBrainPoly);
  for (const [p1, p2, p3] of cbTris) {
    triangle(p1, p2, p3, slateColor, 0.05);
  }
  polyline(centralBrainPoly, slateColor, 0.32, 1.8, true);

  // 2. Both optic lobes (left & right kidney-shaped lobes with inner medulla/lobula outlines)
  const leftOpticCP = [
    [-620, -180],
    [-720, -320],
    [-860, -330],
    [-970, -220],
    [-1000, -70],
    [-980, 90],
    [-880, 220],
    [-740, 230],
    [-620, 130],
    [-590, -10],
  ].map(([x, y]) => [x * s, y * s]);

  const leftOptic = catmullRomToPoints(leftOpticCP, 6, true);
  const rightOptic = leftOptic.map(([x, y]) => [-x, y]).reverse();

  for (const [p1, p2, p3] of triangulatePolygon(leftOptic)) {
    triangle(p1, p2, p3, slateColor, 0.05);
  }
  polyline(leftOptic, slateColor, 0.30, 1.8, true);

  for (const [p1, p2, p3] of triangulatePolygon(rightOptic)) {
    triangle(p1, p2, p3, slateColor, 0.05);
  }
  polyline(rightOptic, slateColor, 0.30, 1.8, true);

  // Inner optic lobe outlines: Medulla and Lobula (slate outlines)
  const leftMedullaCP = [
    [-720, -250],
    [-850, -240],
    [-920, -70],
    [-900, 80],
    [-780, 170],
  ].map(([x, y]) => [x * s, y * s]);
  const leftMedulla = catmullRomToPoints(leftMedullaCP, 6, false);
  const rightMedulla = leftMedulla.map(([x, y]) => [-x, y]);
  polyline(leftMedulla, slateColor, 0.25, 1.3, false);
  polyline(rightMedulla, slateColor, 0.25, 1.3, false);

  const leftLobulaCP = [
    [-660, -180],
    [-740, -150],
    [-790, -30],
    [-770, 70],
    [-680, 110],
  ].map(([x, y]) => [x * s, y * s]);
  const leftLobula = catmullRomToPoints(leftLobulaCP, 6, false);
  const rightLobula = leftLobula.map(([x, y]) => [-x, y]);
  polyline(leftLobula, slateColor, 0.25, 1.3, false);
  polyline(rightLobula, slateColor, 0.25, 1.3, false);

  // 3. Esophageal foramen hole near ventral midline
  ellipseFill(0, 180 * s, 28 * s, 42 * s, canvasColor, 1.0, 48);
  ellipseOutline(0, 180 * s, 28 * s, 42 * s, slateColor, 0.35, 1.5, 48);

  // 4. Viewer's-left circuit neuropils
  // Left AL
  circleFill(BASE_AREAS.AL.x * s, BASE_AREAS.AL.y * s, BASE_AREAS.AL.r * s, greenColor, 0.08, 48);
  circleOutline(BASE_AREAS.AL.x * s, BASE_AREAS.AL.y * s, BASE_AREAS.AL.r * s, greenColor, 0.40, 1.8, 48);

  // Left Calyx
  circleFill(BASE_AREAS.calyx.x * s, BASE_AREAS.calyx.y * s, BASE_AREAS.calyx.r * s, cyanColor, 0.08, 48);
  circleOutline(BASE_AREAS.calyx.x * s, BASE_AREAS.calyx.y * s, BASE_AREAS.calyx.r * s, cyanColor, 0.40, 1.8, 48);

  // Calyx sector divider lines
  if (calyxSectorAngles) {
    for (const span of Object.values(calyxSectorAngles)) {
      const x1 = (BASE_AREAS.calyx.x + BASE_AREAS.calyx.r * Math.cos(span.theta0)) * s;
      const y1 = (BASE_AREAS.calyx.y + BASE_AREAS.calyx.r * Math.sin(span.theta0)) * s;
      polyline([[BASE_AREAS.calyx.x * s, BASE_AREAS.calyx.y * s], [x1, y1]], cyanColor, 0.28, 1.2, false);
    }
  }

  // Left Peduncle: tube running ventro-medially from calyx to heel
  const leftPeduncle = [
    [-234, -48],
    [-212, -73],
    [-115, 20],
    [-133, 50],
  ].map(([x, y]) => [x * s, y * s]);
  for (const [p1, p2, p3] of triangulatePolygon(leftPeduncle)) {
    triangle(p1, p2, p3, peduncleColor, 0.08);
  }
  polyline(leftPeduncle, peduncleColor, 0.35, 1.5, true);

  // Left Mushroom Body Lobes: Vertical lobe (alpha/alpha') + Heel + Medial lobe (beta/beta'/gamma)
  const leftMBLobeBase = [
    [-15, 20],
    [-5, 30],
    [-2, 40],
    [-5, 50],
    [-15, 60],
    [-60, 60],
    [-110, 60],
    [-125, 55],
    [-133, 42],
    [-133, 0],
    [-133, -60],
    [-133, -120],
    [-133, -180],
    [-133, -240],
    [-128, -252],
    [-119, -260],
    [-110, -263],
    [-101, -260],
    [-92, -252],
    [-87, -240],
    [-87, -180],
    [-87, -120],
    [-87, -60],
    [-87, 0],
    [-87, 20],
    [-60, 20],
  ];
  const leftMBLobe = leftMBLobeBase.map(([x, y]) => [x * s, y * s]);
  for (const [p1, p2, p3] of triangulatePolygon(leftMBLobe)) {
    triangle(p1, p2, p3, amberColor, 0.08);
  }
  polyline(leftMBLobe, amberColor, 0.40, 1.6, true);

  // 5. Viewer's-right hemisphere context neuropils (mirrored outline-only, no fill, no dots)
  circleOutline(-BASE_AREAS.AL.x * s, BASE_AREAS.AL.y * s, BASE_AREAS.AL.r * s, slateColor, 0.22, 1.4, 48);
  circleOutline(-BASE_AREAS.calyx.x * s, BASE_AREAS.calyx.y * s, BASE_AREAS.calyx.r * s, slateColor, 0.22, 1.4, 48);

  const rightPeduncle = leftPeduncle.map(([x, y]) => [-x, y]);
  polyline(rightPeduncle, slateColor, 0.22, 1.4, true);

  const rightMBLobe = leftMBLobe.map(([x, y]) => [-x, y]).reverse();
  polyline(rightMBLobe, slateColor, 0.22, 1.4, true);

  // 6. Callout leader lines
  for (const callout of callouts) {
    if (callout.from && callout.to) {
      const color = callout.color ?? slateColor;
      polyline(
        [[callout.from.x, callout.from.y], [callout.to.x, callout.to.y]],
        color,
        0.45,
        1.2,
        false
      );
    }
  }

  return new Float32Array(vertices);
}
