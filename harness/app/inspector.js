export const MAX_RECENT_STEPS = 32;
export const PAGE_SIZE = 10;
export const MISSING_DATA_CAVEAT =
  "No observed fire does not mean inactive; fire means positive KC code not biological spikes";

function parseBodyId(raw) {
  if (typeof raw === "string") {
    return /^\d+$/.test(raw) ? raw : null;
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return raw;
  }
  return null;
}
/**
 * DOM-free index for topology, adjacency, and activity tracking.
 * Memory bounded O(nodes + edges + nodes * MAX_RECENT_STEPS).
 */
export class NeuronIndex {
  constructor(mapping = null) {
    this.reset();
    if (mapping) {
      this.setMapping(mapping);
    }
  }

  reset() {
    this.mapping = null;
    this.nodes = new Map(); // sparse id -> internal node record
    this.groups = new Map(); // group id -> group object
    this.inAdjacency = new Map(); // node id -> sorted array of source ids
    this.outAdjacency = new Map(); // node id -> sorted array of target ids
    this.declaredEdges = new Set(); // "src,dst" -> true
  }

  setMapping(mapping) {
    this.reset();
    if (!mapping || typeof mapping !== "object") return;
    this.mapping = mapping;

    if (Array.isArray(mapping.groups)) {
      for (const group of mapping.groups) {
        if (group && Number.isInteger(group.id) && group.id >= 0) {
          this.groups.set(group.id, {
            id: group.id,
            name: typeof group.name === "string" ? group.name : `Group ${group.id}`,
            ...group,
          });
        }
      }
    }

    if (Array.isArray(mapping.nodes)) {
      for (const node of mapping.nodes) {
        if (node && Number.isInteger(node.id) && node.id >= 0) {
          const groupInfo = this.groups.get(node.group);
          const groupName = groupInfo ? groupInfo.name : `Group ${node.group}`;
          const bodyId = parseBodyId(node.body_id);
          this.nodes.set(node.id, {
            id: node.id,
            group: node.group,
            groupName,
            bodyId,
            count: 0,
            lastStep: null,
            recentSteps: [],
          });
          this.inAdjacency.set(node.id, []);
          this.outAdjacency.set(node.id, []);
        }
      }
    }

    if (Array.isArray(mapping.edges)) {
      for (const edge of mapping.edges) {
        if (!Array.isArray(edge) || edge.length !== 2) continue;
        const [src, dst] = edge;
        if (!this.nodes.has(src) || !this.nodes.has(dst)) continue;
        const key = `${src},${dst}`;
        if (this.declaredEdges.has(key)) continue;
        this.declaredEdges.add(key);
        this.outAdjacency.get(src).push(dst);
        this.inAdjacency.get(dst).push(src);
      }
    }

    // Sort adjacencies for deterministic pagination
    for (const neighbors of this.inAdjacency.values()) {
      neighbors.sort((a, b) => a - b);
    }
    for (const neighbors of this.outAdjacency.values()) {
      neighbors.sort((a, b) => a - b);
    }
  }

  get nodeCount() {
    return this.nodes.size;
  }

  get edgeCount() {
    return this.declaredEdges.size;
  }

  hasNode(id) {
    if (!Number.isInteger(id) || id < 0) return false;
    return this.nodes.has(id);
  }

  hasEdge(src, dst) {
    return this.declaredEdges.has(`${src},${dst}`);
  }

  getNode(id) {
    if (!Number.isInteger(id) || id < 0) return null;
    const node = this.nodes.get(id);
    if (!node) return null;
    const inNeighbors = this.inAdjacency.get(id) || [];
    const outNeighbors = this.outAdjacency.get(id) || [];
    return {
      id: node.id,
      group: node.group,
      groupName: node.groupName,
      bodyId: node.bodyId,
      inDegree: inNeighbors.length,
      outDegree: outNeighbors.length,
      inNeighbors: [...inNeighbors],
      outNeighbors: [...outNeighbors],
      count: node.count,
      lastStep: node.lastStep,
      recentSteps: [...node.recentSteps],
    };
  }

  recordFire(t, pairs) {
    let step = t;
    let edgePairs = pairs;
    if (typeof t === "object" && t !== null && "t" in t) {
      step = t.t;
      edgePairs = t.pairs;
    }
    if (!Number.isInteger(step) || step < 0 || !Array.isArray(edgePairs)) return;
    // Collect active nodes participating in declared edges this step.
    // Self-loops [u, u] or multiple incident edges at step t
    // must NOT count node u multiple times in the same step.
    const activeInStep = new Set();
    for (const pair of edgePairs) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [src, dst] = pair;
      if (!this.declaredEdges.has(`${src},${dst}`)) continue;
      activeInStep.add(src);
      activeInStep.add(dst);
    }

    for (const id of activeInStep) {
      const node = this.nodes.get(id);
      if (!node) continue;
      node.count++;
      node.lastStep = step;
      node.recentSteps.push(step);
      if (node.recentSteps.length > MAX_RECENT_STEPS) {
        node.recentSteps.shift();
      }
    }
  }
}

/**
 * Mounts the neuron inspector panel inside root and attaches event listeners to canvas.
 * Returns a disposer function.
 */
export function mountInspector(root, canvas = null) {
  const index = new NeuronIndex();
  let selectedId = null;
  let activeTab = "identity";
  let userChoseLinks = false;
  let inPage = 0;
  let outPage = 0;
  let updateScheduled = false;
  let frameHandle = null;

  const requestFrame = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 0);

  const cancelFrame = typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame
    : (handle) => clearTimeout(handle);

  const createEl = (tag, id, className, text) => {
    const el = document.createElement(tag);
    if (id) el.id = id;
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  };

  // Build DOM structure
  const panel = createEl("div", "inspector-panel", "inspector-panel");

  const header = createEl("div", "inspector-header", "inspector-header");
  const title = createEl("h3", "inspector-title", "inspector-title", "Neuron Inspector");
  const status = createEl("span", "inspector-status", "inspector-status", "No mapping received.");
  header.append(title, status);

  // Selection form
  const form = createEl("form", "inspector-select-form", "inspector-select-form");
  const formLabel = createEl("label", null, "inspector-label", "Neuron ID");
  formLabel.htmlFor = "inspector-node-input";
  const inputGroup = createEl("div", null, "inspector-input-group");
  const input = createEl("input", "inspector-node-input", "inspector-input");
  input.type = "number";
  input.min = "0";
  input.placeholder = "e.g. 7";
  const selectBtn = createEl("button", "inspector-select-btn", "inspector-btn", "Inspect");
  selectBtn.type = "submit";
  const clearBtn = createEl("button", "inspector-clear-btn", "inspector-btn", "Clear");
  clearBtn.type = "button";
  inputGroup.append(input, selectBtn, clearBtn);
  const errorMsg = createEl("div", "inspector-select-error", "inspector-error");
  errorMsg.setAttribute("role", "alert");
  form.append(formLabel, inputGroup, errorMsg);

  // Empty state notice
  const emptyNotice = createEl("div", "inspector-empty", "inspector-empty", "Waiting for a mapping.");

  // Details container
  const details = createEl("div", "neuron-details", "neuron-details");
  details.hidden = true;

  // Tabs container and buttons
  const tabsContainer = createEl("div", "inspector-tabs", "inspector-tabs");
  tabsContainer.setAttribute("role", "tablist");
  tabsContainer.setAttribute("aria-label", "Neuron detail views");

  const tabDefs = [
    { id: "identity", label: "Identity", panelId: "neuron-section-identity" },
    { id: "links", label: "Links", panelId: "neuron-section-links" },
    { id: "activity", label: "Activity", panelId: "neuron-section-activity" },
  ];

  const tabButtons = {};
  for (const def of tabDefs) {
    const btn = createEl("button", `inspector-tab-${def.id}`, "inspector-tab", def.label);
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", def.panelId);
    btn.setAttribute("aria-selected", "false");
    btn.setAttribute("aria-pressed", "false");
    btn.dataset.tab = def.id;
    btn.addEventListener("click", () => {
      userChoseLinks = (def.id === "links");
      setActiveTab(def.id);
    });
    tabButtons[def.id] = btn;
    tabsContainer.append(btn);
  }

  tabsContainer.addEventListener("keydown", (e) => {
    const tabs = tabDefs.map(d => tabButtons[d.id]);
    const currentIndex = tabs.findIndex(t => t === (globalThis.document?.activeElement || null));
    if (currentIndex === -1) return;
    let nextIndex = -1;
    if (e.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex >= 0) {
      e.preventDefault();
      const nextTab = tabs[nextIndex];
      if (typeof nextTab.focus === "function") nextTab.focus();
      nextTab.click();
    }
  });

  // Identity
  const identSection = createEl("div", "neuron-section-identity", "neuron-section");
  identSection.setAttribute("role", "tabpanel");
  identSection.setAttribute("aria-labelledby", "inspector-tab-identity");
  const idRow = createEl("div", null, "neuron-row");
  const idLabel = createEl("span", null, "neuron-label", "Neuron ID: ");
  const idVal = createEl("span", "neuron-id", "neuron-value");
  idRow.append(idLabel, idVal);

  const groupRow = createEl("div", null, "neuron-row");
  const groupLabel = createEl("span", null, "neuron-label", "Group / Role: ");
  const groupVal = createEl("span", "neuron-group", "neuron-value");
  groupRow.append(groupLabel, groupVal);

  const bodyRow = createEl("div", null, "neuron-row");
  const bodyLabel = createEl("span", null, "neuron-label", "Body ID: ");
  const bodyVal = createEl("span", "neuron-body-id", "neuron-value");
  bodyRow.append(bodyLabel, bodyVal);

  identSection.append(idRow, groupRow, bodyRow);

  // Connectivity
  const connSection = createEl("div", "neuron-section-links", "neuron-section");
  connSection.setAttribute("role", "tabpanel");
  connSection.setAttribute("aria-labelledby", "inspector-tab-links");
  const connHeading = createEl("h4", null, "neuron-heading", "Connectivity");

  // Inbound
  const inRow = createEl("div", null, "neuron-row");
  const inLabel = createEl("span", null, "neuron-label", "In-degree: ");
  const inDegreeVal = createEl("span", "neuron-in-degree", "neuron-value", "0");
  inRow.append(inLabel, inDegreeVal);

  const inNav = createEl("div", null, "neuron-pagination");
  const inNavLabel = createEl("span", null, "neuron-sublabel", "Incoming: ");
  const inPrevBtn = createEl("button", "neuron-in-prev", "inspector-btn", "Prev");
  inPrevBtn.type = "button";
  inPrevBtn.setAttribute("aria-label", "Previous incoming neighbors page");
  const inPageInfo = createEl("span", "neuron-in-page", "neuron-page-info", "—");
  const inNextBtn = createEl("button", "neuron-in-next", "inspector-btn", "Next");
  inNextBtn.type = "button";
  inNextBtn.setAttribute("aria-label", "Next incoming neighbors page");
  inNav.append(inNavLabel, inPrevBtn, inPageInfo, inNextBtn);
  const inNeighborsList = createEl("div", "neuron-in-neighbors", "neuron-neighbors-list");

  // Outbound
  const outRow = createEl("div", null, "neuron-row");
  const outLabel = createEl("span", null, "neuron-label", "Out-degree: ");
  const outDegreeVal = createEl("span", "neuron-out-degree", "neuron-value", "0");
  outRow.append(outLabel, outDegreeVal);

  const outNav = createEl("div", null, "neuron-pagination");
  const outNavLabel = createEl("span", null, "neuron-sublabel", "Outgoing: ");
  const outPrevBtn = createEl("button", "neuron-out-prev", "inspector-btn", "Prev");
  outPrevBtn.type = "button";
  outPrevBtn.setAttribute("aria-label", "Previous outgoing neighbors page");
  const outPageInfo = createEl("span", "neuron-out-page", "neuron-page-info", "—");
  const outNextBtn = createEl("button", "neuron-out-next", "inspector-btn", "Next");
  outNextBtn.type = "button";
  outNextBtn.setAttribute("aria-label", "Next outgoing neighbors page");
  outNav.append(outNavLabel, outPrevBtn, outPageInfo, outNextBtn);
  const outNeighborsList = createEl("div", "neuron-out-neighbors", "neuron-neighbors-list");

  connSection.append(connHeading, inRow, inNav, inNeighborsList, outRow, outNav, outNeighborsList);

  // Activity
  const actSection = createEl("div", "neuron-section-activity", "neuron-section");
  actSection.setAttribute("role", "tabpanel");
  actSection.setAttribute("aria-labelledby", "inspector-tab-activity");
  const actHeading = createEl("h4", null, "neuron-heading", "Observed Activity");

  const countRow = createEl("div", null, "neuron-row");
  const countLabel = createEl("span", null, "neuron-label", "Observed fires: ");
  const countVal = createEl("span", "neuron-fire-count", "neuron-value", "0");
  countRow.append(countLabel, countVal);

  const stepRow = createEl("div", null, "neuron-row");
  const stepLabel = createEl("span", null, "neuron-label", "Last fire step: ");
  const stepVal = createEl("span", "neuron-last-step", "neuron-value", "—");
  stepRow.append(stepLabel, stepVal);

  const recentRow = createEl("div", null, "neuron-row");
  const recentLabel = createEl("span", null, "neuron-label", "Recent fire steps: ");
  const recentVal = createEl("span", "neuron-recent-steps", "neuron-value", "none");
  recentRow.append(recentLabel, recentVal);

  const caveat = createEl("div", "neuron-fire-caveat", "neuron-caveat", MISSING_DATA_CAVEAT);

  actSection.append(actHeading, countRow, stepRow, recentRow, caveat);

  function setActiveTab(tabName) {
    activeTab = tabName;
    for (const def of tabDefs) {
      const isActive = (def.id === tabName);
      const tBtn = tabButtons[def.id];
      if (tBtn) {
        tBtn.setAttribute("aria-selected", isActive ? "true" : "false");
        tBtn.setAttribute("aria-pressed", isActive ? "true" : "false");
        tBtn.className = isActive ? "inspector-tab active" : "inspector-tab";
      }
    }
    identSection.hidden = (tabName !== "identity");
    if (identSection.hidden) {
      identSection.setAttribute("hidden", "");
    } else {
      identSection.removeAttribute("hidden");
    }

    connSection.hidden = (tabName !== "links");
    if (connSection.hidden) {
      connSection.setAttribute("hidden", "");
    } else {
      connSection.removeAttribute("hidden");
    }

    actSection.hidden = (tabName !== "activity");
    if (actSection.hidden) {
      actSection.setAttribute("hidden", "");
    } else {
      actSection.removeAttribute("hidden");
    }
  }

  setActiveTab("identity");

  details.append(tabsContainer, identSection, connSection, actSection);
  panel.append(header, form, emptyNotice, details);
  root.replaceChildren(panel);

  function renderNeighbors() {
    if (selectedId === null) return;
    const node = index.getNode(selectedId);
    if (!node) return;

    // Incoming neighbors pagination
    const inNeighbors = node.inNeighbors;
    inDegreeVal.textContent = String(node.inDegree);
    const inTotalPages = Math.ceil(inNeighbors.length / PAGE_SIZE) || 0;
    if (inPage >= inTotalPages) inPage = Math.max(0, inTotalPages - 1);
    inPrevBtn.disabled = inPage <= 0;
    inNextBtn.disabled = inPage >= inTotalPages - 1 || inTotalPages === 0;
    inPageInfo.textContent = inTotalPages > 0 ? `Page ${inPage + 1} of ${inTotalPages}` : "—";

    const inSlice = inNeighbors.slice(inPage * PAGE_SIZE, (inPage + 1) * PAGE_SIZE);
    const inBtns = inSlice.map(id => {
      const btn = createEl("button", null, "inspector-neighbor-btn", String(id));
      btn.type = "button";
      btn.dataset.id = String(id);
      btn.addEventListener("click", () => {
        userChoseLinks = true;
        selectNode(id, { notifyCanvas: true, focusTarget: true });
      });
      return btn;
    });
    if (inBtns.length === 0) {
      inNeighborsList.replaceChildren(createEl("span", null, "neuron-empty-neighbors", "(none)"));
    } else {
      inNeighborsList.replaceChildren(...inBtns);
    }

    // Outgoing neighbors pagination
    const outNeighbors = node.outNeighbors;
    outDegreeVal.textContent = String(node.outDegree);
    const outTotalPages = Math.ceil(outNeighbors.length / PAGE_SIZE) || 0;
    if (outPage >= outTotalPages) outPage = Math.max(0, outTotalPages - 1);
    outPrevBtn.disabled = outPage <= 0;
    outNextBtn.disabled = outPage >= outTotalPages - 1 || outTotalPages === 0;
    outPageInfo.textContent = outTotalPages > 0 ? `Page ${outPage + 1} of ${outTotalPages}` : "—";

    const outSlice = outNeighbors.slice(outPage * PAGE_SIZE, (outPage + 1) * PAGE_SIZE);
    const outBtns = outSlice.map(id => {
      const btn = createEl("button", null, "inspector-neighbor-btn", String(id));
      btn.type = "button";
      btn.dataset.id = String(id);
      btn.addEventListener("click", () => {
        userChoseLinks = true;
        selectNode(id, { notifyCanvas: true, focusTarget: true });
      });
      return btn;
    });
    if (outBtns.length === 0) {
      outNeighborsList.replaceChildren(createEl("span", null, "neuron-empty-neighbors", "(none)"));
    } else {
      outNeighborsList.replaceChildren(...outBtns);
    }
  }

  function renderActivity(node) {
    countVal.textContent = String(node.count);
    stepVal.textContent = node.lastStep !== null ? String(node.lastStep) : "—";
    recentVal.textContent = node.recentSteps.length > 0 ? node.recentSteps.join(", ") : "none";
    caveat.textContent = MISSING_DATA_CAVEAT;
  }

  function render() {
    if (selectedId === null) {
      details.hidden = true;
      emptyNotice.hidden = false;
      emptyNotice.textContent = index.nodeCount > 0
        ? "Select a neuron to inspect details."
        : "Waiting for a mapping.";
      return;
    }

    const node = index.getNode(selectedId);
    if (!node) {
      selectedId = null;
      userChoseLinks = false;
      setActiveTab("identity");
      render();
      return;
    }

    details.hidden = false;
    emptyNotice.hidden = true;

    idVal.textContent = String(node.id);
    groupVal.textContent = node.groupName;
    bodyVal.textContent = node.bodyId !== null && node.bodyId !== undefined
      ? String(node.bodyId)
      : "not exported";

    renderNeighbors();
    renderActivity(node);
  }

  function scheduleActivityUpdate() {
    if (updateScheduled) return;
    updateScheduled = true;
    frameHandle = requestFrame(() => {
      updateScheduled = false;
      if (selectedId !== null) {
        const node = index.getNode(selectedId);
        if (node) {
          renderActivity(node);
        }
      }
    });
  }

  function showInputError(message) {
    errorMsg.textContent = message;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", "inspector-select-error");
  }

  function clearInputError() {
    errorMsg.textContent = "";
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  }

  function selectNode(id, { notifyCanvas = true, focusTarget = false } = {}) {
    if (id === null || id === undefined) {
      selectedId = null;
      userChoseLinks = false;
      setActiveTab("identity");
      inPage = 0;
      outPage = 0;
      input.value = "";
      clearInputError();
      if (updateScheduled) {
        cancelFrame(frameHandle);
        updateScheduled = false;
      }
      render();
      if (notifyCanvas && canvas && typeof canvas.dispatchEvent === "function") {
        canvas.dispatchEvent(new CustomEvent("select-node", { detail: { id: null } }));
      }
      return;
    }

    const numericId = typeof id === "string" ? (id.trim() === "" ? NaN : Number(id)) : id;
    if (!Number.isInteger(numericId) || numericId < 0 || !index.hasNode(numericId)) {
      showInputError(`Node ${id} not found.`);
      return;
    }

    clearInputError();
    selectedId = numericId;
    inPage = 0;
    outPage = 0;
    input.value = String(numericId);
    if (userChoseLinks) {
      setActiveTab("links");
    } else {
      setActiveTab("identity");
    }

    if (updateScheduled) {
      cancelFrame(frameHandle);
      updateScheduled = false;
    }
    render();
    if (focusTarget && typeof input.focus === "function") {
      input.focus();
    }

    if (notifyCanvas && canvas && typeof canvas.dispatchEvent === "function") {
      canvas.dispatchEvent(new CustomEvent("select-node", { detail: { id: numericId } }));
    }
  }

  // Neighbor pagination listeners
  inPrevBtn.addEventListener("click", () => {
    if (inPage > 0) {
      inPage--;
      renderNeighbors();
    }
  });
  inNextBtn.addEventListener("click", () => {
    const node = index.getNode(selectedId);
    const totalPages = Math.ceil((node?.inNeighbors.length || 0) / PAGE_SIZE);
    if (inPage < totalPages - 1) {
      inPage++;
      renderNeighbors();
    }
  });
  outPrevBtn.addEventListener("click", () => {
    if (outPage > 0) {
      outPage--;
      renderNeighbors();
    }
  });
  outNextBtn.addEventListener("click", () => {
    const node = index.getNode(selectedId);
    const totalPages = Math.ceil((node?.outNeighbors.length || 0) / PAGE_SIZE);
    if (outPage < totalPages - 1) {
      outPage++;
      renderNeighbors();
    }
  });

  // Form listeners
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = input.value.trim();
    if (!val) {
      showInputError("Please enter a node ID.");
      return;
    }
    const num = Number(val);
    if (!Number.isInteger(num) || num < 0) {
      showInputError("Invalid node ID.");
      return;
    }
    if (!index.hasNode(num)) {
      showInputError(`Node ${val} not found.`);
      return;
    }
    selectNode(num, { notifyCanvas: true });
  });
  clearBtn.addEventListener("click", () => {
    selectNode(null, { notifyCanvas: true });
  });

  // Canvas event handlers
  const onMapping = (event) => {
    const mapping = event?.detail ?? null;
    index.setMapping(mapping);
    selectedId = null;
    userChoseLinks = false;
    setActiveTab("identity");
    inPage = 0;
    outPage = 0;
    input.value = "";
    clearInputError();
    if (updateScheduled) {
      cancelFrame(frameHandle);
      updateScheduled = false;
    }
    status.textContent = mapping ? `Mapping active · ${index.nodeCount} nodes` : "No mapping received.";
    render();
  };

  const onFire = (event) => {
    const { t, pairs } = event?.detail || {};
    index.recordFire(t, pairs);
    if (selectedId !== null) {
      const node = index.nodes.get(selectedId);
      if (node && node.lastStep === t) {
        scheduleActivityUpdate();
      }
    }
  };

  const onReset = () => {
    index.reset();
    selectedId = null;
    userChoseLinks = false;
    setActiveTab("identity");
    inPage = 0;
    outPage = 0;
    input.value = "";
    clearInputError();
    if (updateScheduled) {
      cancelFrame(frameHandle);
      updateScheduled = false;
    }
    status.textContent = "No mapping received.";
    render();
  };

  const onNodeSelect = (event) => {
    const id = event?.detail?.id ?? null;
    if (id !== null && index.hasNode(id)) {
      selectNode(id, { notifyCanvas: false });
    } else {
      selectNode(null, { notifyCanvas: false });
    }
  };

  if (canvas && typeof canvas.addEventListener === "function") {
    canvas.addEventListener("mapping", onMapping);
    canvas.addEventListener("fire", onFire);
    canvas.addEventListener("reset", onReset);
    canvas.addEventListener("node-select", onNodeSelect);
  }

  const disposer = () => {
    if (canvas && typeof canvas.removeEventListener === "function") {
      canvas.removeEventListener("mapping", onMapping);
      canvas.removeEventListener("fire", onFire);
      canvas.removeEventListener("reset", onReset);
      canvas.removeEventListener("node-select", onNodeSelect);
    }
    if (updateScheduled) {
      cancelFrame(frameHandle);
      updateScheduled = false;
    }
    root.replaceChildren();
  };

  disposer.index = index;
  disposer.selectNode = selectNode;
  disposer.getSelectedNode = () => (selectedId !== null ? index.getNode(selectedId) : null);
  disposer.flush = () => {
    if (updateScheduled) {
      cancelFrame(frameHandle);
      updateScheduled = false;
      if (selectedId !== null) {
        const node = index.getNode(selectedId);
        if (node) {
          renderActivity(node);
        }
      }
    }
  };

  return disposer;
}
