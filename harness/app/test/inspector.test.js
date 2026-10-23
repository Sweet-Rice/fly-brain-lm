import test from "node:test";
import assert from "node:assert/strict";
import { NeuronIndex, mountInspector, MAX_RECENT_STEPS, PAGE_SIZE } from "../inspector.js";

// Minimal DOM mock for testing DOM-bound components in Node.js
class MockElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.type = "";
    this.min = "";
    this.placeholder = "";
    this.htmlFor = "";
    this.value = "";
    this._textContent = "";
    this.focused = false;
  }

  focus() {
    this.focused = true;
    if (globalThis.document) {
      globalThis.document.activeElement = this;
    }
  }

  blur() {
    this.focused = false;
    if (globalThis.document && globalThis.document.activeElement === this) {
      globalThis.document.activeElement = null;
    }
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(v) {
    this._textContent = String(v ?? "");
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }

  removeAttribute(k) {
    this.attributes.delete(k);
  }

  hasAttribute(k) {
    return this.attributes.has(k);
  }
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function setupMockDocument() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const doc = {
    activeElement: null,
    createElement(tag) {
      return new MockElement(tag);
    },
  };
  globalThis.document = doc;
  return () => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  };
}

test("NeuronIndex handles sparse, non-contiguous node IDs and builds correct adjacency", () => {
  const mapping = {
    type: "mapping",
    version: 1,
    groups: [
      { id: 0, name: "Glomerulus" },
      { id: 1, name: "KC_gamma" },
    ],
    nodes: [
      { id: 105, group: 0 },
      { id: 5002, group: 1, body_id: "64728190" },
      { id: 99999, group: 1 },
    ],
    edges: [
      [105, 5002],
      [105, 99999],
      [5002, 99999],
    ],
  };

  const index = new NeuronIndex(mapping);
  assert.equal(index.nodeCount, 3);
  assert.equal(index.edgeCount, 3);

  assert.equal(index.hasNode(105), true);
  assert.equal(index.hasNode(5002), true);
  assert.equal(index.hasNode(99999), true);
  assert.equal(index.hasNode(0), false);
  assert.equal(index.hasNode(1), false);

  const n105 = index.getNode(105);
  assert.equal(n105.id, 105);
  assert.equal(n105.groupName, "Glomerulus");
  assert.equal(n105.bodyId, null);
  assert.equal(n105.inDegree, 0);
  assert.equal(n105.outDegree, 2);
  assert.deepEqual(n105.outNeighbors, [5002, 99999]);

  const n5002 = index.getNode(5002);
  assert.equal(n5002.bodyId, "64728190");
  assert.equal(n5002.inDegree, 1);
  assert.deepEqual(n5002.inNeighbors, [105]);
  assert.equal(n5002.outDegree, 1);
  assert.deepEqual(n5002.outNeighbors, [99999]);

  const n99999 = index.getNode(99999);
  assert.equal(n99999.inDegree, 2);
  assert.deepEqual(n99999.inNeighbors, [105, 5002]);
  assert.equal(n99999.outDegree, 0);
});

test("NeuronIndex handles self-loops without duplicate activity count per step", () => {
  const mapping = {
    type: "mapping",
    version: 1,
    groups: [{ id: 0, name: "Glomerulus" }],
    nodes: [
      { id: 7, group: 0 },
      { id: 8, group: 0 },
    ],
    edges: [
      [7, 7], // self loop
      [7, 8],
    ],
  };

  const index = new NeuronIndex(mapping);
  const n7 = index.getNode(7);
  assert.deepEqual(n7.inNeighbors, [7]);
  assert.deepEqual(n7.outNeighbors, [7, 8]);

  // Step 1: Only self-loop fires
  index.recordFire(1, [[7, 7]]);
  let current7 = index.getNode(7);
  // Self loop [7, 7] MUST NOT count node 7 twice in step 1
  assert.equal(current7.count, 1);
  assert.equal(current7.lastStep, 1);
  assert.deepEqual(current7.recentSteps, [1]);

  // Step 2: Both self-loop [7, 7] and incident edge [7, 8] fire together in step 2
  index.recordFire(2, [
    [7, 7],
    [7, 8],
  ]);
  current7 = index.getNode(7);
  // Node 7 fired in step 2: count increases by 1 for step 2 (total = 2), not by 3
  assert.equal(current7.count, 2);
  assert.equal(current7.lastStep, 2);
  assert.deepEqual(current7.recentSteps, [1, 2]);

  const current8 = index.getNode(8);
  assert.equal(current8.count, 1);
  assert.equal(current8.lastStep, 2);
  assert.deepEqual(current8.recentSteps, [2]);
});

test("NeuronIndex caps recent fire steps at MAX_RECENT_STEPS (32) and maintains history bounds", () => {
  const mapping = {
    type: "mapping",
    version: 1,
    groups: [{ id: 0, name: "KC_gamma" }],
    nodes: [{ id: 10, group: 0 }],
    edges: [[10, 10]],
  };

  const index = new NeuronIndex(mapping);

  // Fire 45 consecutive steps
  for (let t = 1; t <= 45; t++) {
    index.recordFire(t, [[10, 10]]);
  }

  const node = index.getNode(10);
  assert.equal(node.count, 45);
  assert.equal(node.lastStep, 45);
  assert.equal(node.recentSteps.length, MAX_RECENT_STEPS);
  assert.equal(node.recentSteps.length, 32);

  // Oldest retained step should be 45 - 32 + 1 = 14
  assert.equal(node.recentSteps[0], 14);
  assert.equal(node.recentSteps[31], 45);
  // Ensure strict ascending sequence
  for (let i = 0; i < 31; i++) {
    assert.equal(node.recentSteps[i + 1], node.recentSteps[i] + 1);
  }
});

test("NeuronIndex rejects unknown pairs and does not mutate node activity", () => {
  const mapping = {
    type: "mapping",
    version: 1,
    groups: [{ id: 0, name: "PN" }],
    nodes: [{ id: 1, group: 0 }],
    edges: [[1, 1]],
  };

  const index = new NeuronIndex(mapping);

  // Fire with unknown edges and unknown nodes
  index.recordFire(1, [
    [999, 999], // unknown nodes
    [1, 999], // unknown destination
    [999, 1], // unknown source
    [1, 2], // undeclared edge
  ]);

  const n1 = index.getNode(1);
  assert.equal(n1.count, 0);
  assert.equal(n1.lastStep, null);
  assert.deepEqual(n1.recentSteps, []);
  assert.equal(index.hasNode(999), false);
});

test("NeuronIndex setMapping and reset completely clear previous topology and history", () => {
  const mapping1 = {
    type: "mapping",
    version: 1,
    groups: [{ id: 0, name: "G1" }],
    nodes: [{ id: 100, group: 0 }],
    edges: [[100, 100]],
  };

  const index = new NeuronIndex(mapping1);
  index.recordFire(10, [[100, 100]]);
  assert.equal(index.getNode(100).count, 1);

  // Reset clears everything
  index.reset();
  assert.equal(index.nodeCount, 0);
  assert.equal(index.edgeCount, 0);
  assert.equal(index.hasNode(100), false);

  // New mapping replaces completely
  const mapping2 = {
    type: "mapping",
    version: 1,
    groups: [{ id: 0, name: "G2" }],
    nodes: [{ id: 200, group: 0 }],
    edges: [[200, 200]],
  };
  index.setMapping(mapping2);
  assert.equal(index.nodeCount, 1);
  assert.equal(index.hasNode(100), false);
  assert.equal(index.hasNode(200), true);
  assert.equal(index.getNode(200).count, 0);
  assert.equal(index.getNode(200).lastStep, null);
});

test("mountInspector builds UI and renders mapping, identity, and explicit body_id status", () => {
  const cleanup = setupMockDocument();
  try {
    const root = new MockElement("div");
    const canvas = new MockElement("canvas");
    const disposer = mountInspector(root, canvas);

    const mapping = {
      type: "mapping",
      version: 1,
      groups: [
        { id: 0, name: "Glomerulus" },
        { id: 1, name: "KC_alphabeta" },
      ],
      nodes: [
        { id: 10, group: 0, body_id: "12345678" },
        { id: 20, group: 1 }, // no body_id
        { id: 30, group: 1, body_id: 720575940629970489 }, // unsafe numeric -> rejected
        { id: 40, group: 1, body_id: "720575940629970489" }, // large decimal string -> preserved exact
        { id: 50, group: 1, body_id: {} }, // object -> rejected
        { id: 60, group: 1, body_id: false }, // boolean -> rejected
        { id: 70, group: 1, body_id: "" }, // empty string -> rejected
        { id: 80, group: 1, body_id: 987654 }, // safe integer -> accepted
      ],
      edges: [[10, 20]],
    };

    canvas.dispatchEvent(new CustomEvent("mapping", { detail: mapping }));

    // Inspect node 10 (has body_id)
    disposer.selectNode(10, { notifyCanvas: false });

    const idVal = findById(root, "neuron-id");
    assert.equal(idVal.textContent, "10");

    const groupVal = findById(root, "neuron-group");
    assert.equal(groupVal.textContent, "Glomerulus");

    const bodyVal = findById(root, "neuron-body-id");
    assert.equal(bodyVal.textContent, "12345678");

    // Inspect node 20 (no body_id -> explicitly "not exported")
    disposer.selectNode(20, { notifyCanvas: false });
    assert.equal(findById(root, "neuron-id").textContent, "20");
    assert.equal(findById(root, "neuron-group").textContent, "KC_alphabeta");
    assert.equal(findById(root, "neuron-body-id").textContent, "not exported");

    // Inspect node 30 (unsafe numeric body_id -> "not exported")
    disposer.selectNode(30, { notifyCanvas: false });
    assert.equal(findById(root, "neuron-body-id").textContent, "not exported");

    // Inspect node 40 (exact decimal string body_id preserved)
    disposer.selectNode(40, { notifyCanvas: false });
    assert.equal(findById(root, "neuron-body-id").textContent, "720575940629970489");

    // Inspect node 50 (object body_id -> "not exported")
    disposer.selectNode(50, { notifyCanvas: false });
    assert.equal(findById(root, "neuron-body-id").textContent, "not exported");

    // Inspect node 60 (boolean body_id -> "not exported")
    disposer.selectNode(60, { notifyCanvas: false });
    assert.equal(findById(root, "neuron-body-id").textContent, "not exported");

    // Inspect node 70 (empty string body_id -> "not exported")
    disposer.selectNode(70, { notifyCanvas: false });
    assert.equal(findById(root, "neuron-body-id").textContent, "not exported");

    // Inspect node 80 (safe integer body_id -> accepted)
    disposer.selectNode(80, { notifyCanvas: false });
    assert.equal(findById(root, "neuron-body-id").textContent, "987654");

    disposer();
  } finally {
    cleanup();
  }
});

test("mountInspector keyboard select form validates input, selects node, and emits select-node event", () => {
  const cleanup = setupMockDocument();
  try {
    const root = new MockElement("div");
    const canvas = new MockElement("canvas");
    const selectedEvents = [];
    canvas.addEventListener("select-node", (e) => selectedEvents.push(e.detail));

    const disposer = mountInspector(root, canvas);

    const mapping = {
      type: "mapping",
      version: 1,
      groups: [{ id: 0, name: "MBON" }],
      nodes: [
        { id: 42, group: 0 },
        { id: 99, group: 0 },
      ],
      edges: [[42, 99]],
    };

    canvas.dispatchEvent(new CustomEvent("mapping", { detail: mapping }));

    const form = findById(root, "inspector-select-form");
    const input = findById(root, "inspector-node-input");
    const errorEl = findById(root, "inspector-select-error");

    // Invalid non-existent node
    input.value = "1234";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.match(errorEl.textContent, /not found/i);
    assert.equal(selectedEvents.length, 0);

    // Valid node 42
    input.value = "42";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(errorEl.textContent, "");
    assert.equal(selectedEvents.length, 1);
    assert.deepEqual(selectedEvents[0], { id: 42 });
    assert.equal(findById(root, "neuron-id").textContent, "42");

    // Selecting another neuron replaces selection
    input.value = "99";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(errorEl.textContent, "");
    assert.equal(selectedEvents.length, 2);
    assert.deepEqual(selectedEvents[1], { id: 99 });
    assert.equal(findById(root, "neuron-id").textContent, "99");


    // Deselection via selectNode(null)
    disposer.selectNode(null);
    assert.equal(selectedEvents.length, 3);
    assert.deepEqual(selectedEvents[2], { id: null });
    assert.equal(findById(root, "neuron-details").hidden, true);

    disposer();
  } finally {
    cleanup();
  }
});

test("mountInspector handles node-select from GPU without infinite echo loop", () => {
  const cleanup = setupMockDocument();
  try {
    const root = new MockElement("div");
    const canvas = new MockElement("canvas");
    const selectNodeDispatches = [];
    canvas.addEventListener("select-node", (e) => selectNodeDispatches.push(e.detail));

    const disposer = mountInspector(root, canvas);

    const mapping = {
      type: "mapping",
      version: 1,
      groups: [{ id: 0, name: "PN" }],
      nodes: [{ id: 7, group: 0 }],
      edges: [],
    };
    canvas.dispatchEvent(new CustomEvent("mapping", { detail: mapping }));

    // GPU sends node-select
    canvas.dispatchEvent(new CustomEvent("node-select", { detail: { id: 7 } }));

    // Inspector shows node 7
    assert.equal(findById(root, "neuron-id").textContent, "7");
    // Crucial: Inspector MUST NOT dispatch select-node back to canvas for GPU selections
    assert.equal(selectNodeDispatches.length, 0);
    // Mouse GPU picking must not steal focus
    const input = findById(root, "inspector-node-input");
    assert.equal(input.focused, false);

    // GPU sends unknown node-select -> must clear selection instead of stale previous panel
    canvas.dispatchEvent(new CustomEvent("node-select", { detail: { id: 9999 } }));
    assert.equal(findById(root, "neuron-details").hidden, true);
    assert.equal(disposer.getSelectedNode(), null);
    assert.equal(selectNodeDispatches.length, 0);

    // Re-select node 7 and verify background click clears
    disposer.selectNode(7, { notifyCanvas: false });
    assert.equal(findById(root, "neuron-details").hidden, false);

    // GPU sends node-select null (background click)
    canvas.dispatchEvent(new CustomEvent("node-select", { detail: { id: null } }));
    assert.equal(findById(root, "neuron-details").hidden, true);
    assert.equal(selectNodeDispatches.length, 0);

    disposer();
  } finally {
    cleanup();
  }
});

test("mountInspector full neighbor list navigation and pagination handles high-degree nodes", () => {
  const cleanup = setupMockDocument();
  try {
    const root = new MockElement("div");
    const canvas = new MockElement("canvas");
    const selectedEvents = [];
    canvas.addEventListener("select-node", (e) => selectedEvents.push(e.detail));

    const disposer = mountInspector(root, canvas);

    // Hub node 0 with 25 incoming neighbors (101..125)
    const nodes = [{ id: 0, group: 0 }];
    const edges = [];
    for (let i = 1; i <= 25; i++) {
      const neighborId = 100 + i;
      nodes.push({ id: neighborId, group: 0 });
      edges.push([neighborId, 0]);
    }

    canvas.dispatchEvent(
      new CustomEvent("mapping", {
        detail: {
          type: "mapping",
          version: 1,
          groups: [{ id: 0, name: "Hub" }],
          nodes,
          edges,
        },
      })
    );

    disposer.selectNode(0, { notifyCanvas: false });

    assert.equal(findById(root, "neuron-in-degree").textContent, "25");
    assert.equal(findById(root, "neuron-out-degree").textContent, "0");

    const inPageInfo = findById(root, "neuron-in-page");
    const inPrevBtn = findById(root, "neuron-in-prev");
    const inNextBtn = findById(root, "neuron-in-next");
    const outPrevBtn = findById(root, "neuron-out-prev");
    const outNextBtn = findById(root, "neuron-out-next");
    const inNeighborsList = findById(root, "neuron-in-neighbors");

    // Distinct incoming/outgoing aria-labels
    assert.equal(inPrevBtn.getAttribute("aria-label"), "Previous incoming neighbors page");
    assert.equal(inNextBtn.getAttribute("aria-label"), "Next incoming neighbors page");
    assert.equal(outPrevBtn.getAttribute("aria-label"), "Previous outgoing neighbors page");
    assert.equal(outNextBtn.getAttribute("aria-label"), "Next outgoing neighbors page");

    // Page 1: 10 items (101..110)
    assert.equal(inPageInfo.textContent, "Page 1 of 3");
    assert.equal(inPrevBtn.disabled, true);
    assert.equal(inNextBtn.disabled, false);
    assert.equal(inNeighborsList.children.length, PAGE_SIZE);
    assert.equal(inNeighborsList.children[0].textContent, "101");
    assert.equal(inNeighborsList.children[9].textContent, "110");

    // Next -> Page 2: 10 items (111..120)
    inNextBtn.dispatchEvent(new Event("click"));
    assert.equal(inPageInfo.textContent, "Page 2 of 3");
    assert.equal(inPrevBtn.disabled, false);
    assert.equal(inNextBtn.disabled, false);
    assert.equal(inNeighborsList.children.length, PAGE_SIZE);
    assert.equal(inNeighborsList.children[0].textContent, "111");

    // Next -> Page 3: 5 items (121..125)
    inNextBtn.dispatchEvent(new Event("click"));
    assert.equal(inPageInfo.textContent, "Page 3 of 3");
    assert.equal(inPrevBtn.disabled, false);
    assert.equal(inNextBtn.disabled, true); // No next page
    assert.equal(inNeighborsList.children.length, 5);
    assert.equal(inNeighborsList.children[4].textContent, "125");

    // Click neighbor button 125 -> selects node 125, moves focus to stable target (input), emits select-node
    const btn125 = inNeighborsList.children[4];
    btn125.dispatchEvent(new Event("click"));
    assert.equal(selectedEvents.length, 1);
    assert.deepEqual(selectedEvents[0], { id: 125 });
    assert.equal(findById(root, "neuron-id").textContent, "125");
    const input = findById(root, "inspector-node-input");
    assert.equal(input.focused, true);
    assert.equal(globalThis.document.activeElement, input);
    disposer();
  } finally {
    cleanup();
  }
});

test("mountInspector activity shows fire counts and steps", () => {
  const cleanup = setupMockDocument();
  try {
    const root = new MockElement("div");
    const canvas = new MockElement("canvas");
    const disposer = mountInspector(root, canvas);

    const mapping = {
      type: "mapping",
      version: 1,
      groups: [{ id: 0, name: "KC_alphaprime_betaprime" }],
      nodes: [
        { id: 5, group: 0 },
        { id: 6, group: 0 },
      ],
      edges: [[5, 6]],
    };
    canvas.dispatchEvent(new CustomEvent("mapping", { detail: mapping }));
    disposer.selectNode(5, { notifyCanvas: false });

    // Initial state before fires
    assert.equal(findById(root, "neuron-fire-count").textContent, "0");
    assert.equal(findById(root, "neuron-last-step").textContent, "—");
    assert.equal(findById(root, "neuron-recent-steps").textContent, "none");

    // Fire steps
    canvas.dispatchEvent(new CustomEvent("fire", { detail: { t: 10, pairs: [[5, 6]] } }));
    disposer.flush();

    assert.equal(findById(root, "neuron-fire-count").textContent, "1");
    assert.equal(findById(root, "neuron-last-step").textContent, "10");
    assert.equal(findById(root, "neuron-recent-steps").textContent, "10");

    canvas.dispatchEvent(new CustomEvent("fire", { detail: { t: 25, pairs: [[5, 6]] } }));
    disposer.flush();

    assert.equal(findById(root, "neuron-fire-count").textContent, "2");
    assert.equal(findById(root, "neuron-last-step").textContent, "25");
    assert.equal(findById(root, "neuron-recent-steps").textContent, "10, 25");

    // Fire activity must not steal focus
    const input = findById(root, "inspector-node-input");
    assert.equal(input.focused, false);
    disposer();
  } finally {
    cleanup();
  }
});

test("mountInspector reset and mapping replacement clear selection and stale history", () => {
  const cleanup = setupMockDocument();
  try {
    const root = new MockElement("div");
    const canvas = new MockElement("canvas");
    const disposer = mountInspector(root, canvas);

    const mapping1 = {
      type: "mapping",
      version: 1,
      groups: [{ id: 0, name: "PN" }],
      nodes: [{ id: 1, group: 0 }],
      edges: [[1, 1]],
    };
    canvas.dispatchEvent(new CustomEvent("mapping", { detail: mapping1 }));
    disposer.selectNode(1, { notifyCanvas: false });
    canvas.dispatchEvent(new CustomEvent("fire", { detail: { t: 5, pairs: [[1, 1]] } }));
    disposer.flush();

    assert.equal(findById(root, "neuron-id").textContent, "1");
    assert.equal(findById(root, "neuron-fire-count").textContent, "1");

    // Canvas emits reset
    canvas.dispatchEvent(new Event("reset"));

    assert.equal(findById(root, "neuron-details").hidden, true);
    assert.equal(findById(root, "inspector-empty").hidden, false);
    assert.equal(disposer.getSelectedNode(), null);

    // Canvas emits new mapping
    const mapping2 = {
      type: "mapping",
      version: 1,
      groups: [{ id: 0, name: "MBON" }],
      nodes: [{ id: 2, group: 0 }],
      edges: [[2, 2]],
    };
    canvas.dispatchEvent(new CustomEvent("mapping", { detail: mapping2 }));

    // Selection must remain cleared, old node 1 history must be gone
    assert.equal(disposer.getSelectedNode(), null);
    assert.equal(findById(root, "neuron-details").hidden, true);

    disposer();
  } finally {
    cleanup();
  }
});

test("mountInspector functions when canvas is null (selection absent GPU still works)", () => {
  const cleanup = setupMockDocument();
  try {
    const root = new MockElement("div");
    // No canvas provided
    const disposer = mountInspector(root, null);

    const mapping = {
      type: "mapping",
      version: 1,
      groups: [{ id: 0, name: "Local" }],
      nodes: [
        { id: 10, group: 0 },
        { id: 20, group: 0 },
      ],
      edges: [[10, 20]],
    };

    disposer.index.setMapping(mapping);

    // Keyboard selection works
    const input = findById(root, "inspector-node-input");
    const form = findById(root, "inspector-select-form");
    input.value = "10";
    form.dispatchEvent(new Event("submit", { cancelable: true }));

    assert.equal(findById(root, "neuron-id").textContent, "10");
    assert.equal(findById(root, "neuron-details").hidden, false);

    // Selecting another neuron replaces selection
    input.value = "20";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(findById(root, "neuron-id").textContent, "20");
    assert.equal(findById(root, "neuron-details").hidden, false);


    // Deselection works via selectNode(null)
    disposer.selectNode(null);
    assert.equal(findById(root, "neuron-details").hidden, true);

    disposer();
  } finally {
    cleanup();
  }
});

test("ID selection preserves scientific notation, rejects fractions, and exposes accessible errors", () => {
  const cleanup = setupMockDocument();
  try {
    const root = new MockElement("div");
    const canvas = new MockElement("canvas");
    const selectedEvents = [];
    canvas.addEventListener("select-node", (e) => selectedEvents.push(e.detail));

    const disposer = mountInspector(root, canvas);

    const mapping = {
      type: "mapping",
      version: 1,
      groups: [{ id: 0, name: "PN" }],
      nodes: [
        { id: 1, group: 0 },
        { id: 100, group: 0 },
      ],
      edges: [[1, 100]],
    };
    canvas.dispatchEvent(new CustomEvent("mapping", { detail: mapping }));

    const form = findById(root, "inspector-select-form");
    const input = findById(root, "inspector-node-input");
    const errorEl = findById(root, "inspector-select-error");

    // 1. Scientific notation "1e2" evaluates to 100 and selects node 100, NOT node 1
    input.value = "1e2";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(selectedEvents.length, 1);
    assert.deepEqual(selectedEvents[0], { id: 100 }, "1e2 must select 100, not truncate to 1");
    assert.equal(findById(root, "neuron-id").textContent, "100");
    assert.equal(input.getAttribute("aria-invalid"), null);
    assert.equal(input.getAttribute("aria-describedby"), null);
    assert.equal(errorEl.textContent, "");

    // 2. Decimal string "1.5" in form must NOT truncate to 1; must set ARIA error attributes
    input.value = "1.5";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(selectedEvents.length, 1, "invalid decimal must not dispatch select-node");
    assert.equal(findById(root, "neuron-id").textContent, "100", "selection must remain unchanged");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.getAttribute("aria-describedby"), "inspector-select-error");

    // 3. Direct call selectNode("1.5") must NOT truncate to 1; must set ARIA error attributes
    disposer.selectNode("1.5");
    assert.equal(selectedEvents.length, 1);
    assert.equal(findById(root, "neuron-id").textContent, "100");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.getAttribute("aria-describedby"), "inspector-select-error");

    // 4. Successful selection clears aria-invalid and aria-describedby
    input.value = "1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(selectedEvents.length, 2);
    assert.deepEqual(selectedEvents[1], { id: 1 });
    assert.equal(findById(root, "neuron-id").textContent, "1");
    assert.equal(input.getAttribute("aria-invalid"), null);
    assert.equal(input.getAttribute("aria-describedby"), null);
    assert.equal(errorEl.textContent, "");

    // 5. Triggering error again then resetting canvas clears ARIA attributes
    disposer.selectNode("invalid-id");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.getAttribute("aria-describedby"), "inspector-select-error");

    canvas.dispatchEvent(new Event("reset"));
    assert.equal(input.getAttribute("aria-invalid"), null);
    assert.equal(input.getAttribute("aria-describedby"), null);
    assert.equal(errorEl.textContent, "");

    disposer();
  } finally {
    cleanup();
  }
});

test("NeuronIndex node runtime IDs follow ProtocolReceiver integer rule (Number.isInteger)", () => {
  const index = new NeuronIndex({
    type: "mapping",
    version: 1,
    groups: [{ id: 0, name: "PN" }],
    nodes: [
      { id: 0, group: 0 },
      { id: 9007199254740993, group: 0 },
    ],
    edges: [],
  });

  assert.equal(index.hasNode(0), true);
  assert.equal(index.hasNode(9007199254740993), true);
  assert.equal(index.hasNode(1.5), false);
  assert.equal(index.hasNode(-1), false);
  assert.equal(index.getNode(9007199254740993)?.id, 9007199254740993);
});
