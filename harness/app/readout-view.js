/**
 * Graph Readout View Module.
 *
 * Visually connects MBON nodes through a common model readout hub to decoded text.
 * Architectural truth: DopamineMixer.step creates head readout then gating/out_norm/out_proj;
 * residual blocks and norm_f + tied embedding projection create logits.
 * Diagram links are ARCHITECTURAL readout links, not measured per-MBON word attribution
 * or direct biological synapses.
 */

import { isGenerationActive } from './generation.js';

export const READOUT_DOM_IDS = Object.freeze({
  ROOT: 'readout-root',
  OVERLAY: 'readout-overlay',
  LINKS: 'readout-links-svg',
  CARD: 'readout-card',
  HEADER: 'readout-header',
  PIPELINE: 'readout-pipeline-label',
  SOURCE_BADGE: 'readout-source-badge',
  TOKEN_VIEW: 'readout-token-view',
  TOKEN_META: 'readout-token-meta',
  TOKEN_ID: 'readout-token-id',
  TOKEN_STATUS: 'readout-token-status',
  PIECE_GROUP: 'readout-piece-group',
  PIECE_BADGE: 'readout-piece-badge',
  TEXT_BOX: 'readout-text',
  CONTROLS: 'readout-controls',
  PREV_BTN: 'readout-prev',
  NEXT_BTN: 'readout-next',
  LATEST_BTN: 'readout-latest',
  POS_LABEL: 'readout-pos',
});

export const READOUT_CLASSES = Object.freeze({
  OVERLAY: 'readout-overlay',
  LINKS: 'readout-links',
  LINK_MBON: 'readout-mbon-link',
  LINK_HUB: 'readout-hub-link',
  HUB_NODE: 'readout-hub-node',
  HUB_LABEL: 'readout-hub-label',
  CARD: 'readout-card',
  HEADER: 'readout-header',
  PIPELINE: 'readout-pipeline-label',
  SOURCE_BADGE: 'readout-source-badge',
  TOKEN_VIEW: 'readout-token-view',
  TOKEN_META: 'readout-token-meta',
  TOKEN_ID: 'readout-token-id',
  TOKEN_STATUS: 'readout-token-status',
  PIECE_GROUP: 'readout-piece-group',
  PIECE_BADGE: 'readout-piece-badge',
  TEXT_BOX: 'readout-text-box',
  CONTROLS: 'readout-controls',
  BTN: 'readout-btn',
  POS_LABEL: 'readout-pos-label',
});

const MAX_COMPLETION_TOKENS = 128;
const PIECE_SIZE = 32;

/**
 * Splits text into bounded pieces of up to `size` Unicode codepoints.
 *
 * @param {string} text
 * @param {number} [size=32]
 * @returns {string[]}
 */
export function splitIntoPieces(text, size = PIECE_SIZE) {
  if (typeof text !== 'string' || text.length === 0) return [''];
  const pieces = [];
  let piece = '';
  let width = 0;
  for (const character of text) {
    const escapedWidth = Array.from(JSON.stringify(character)).length - 2;
    if (piece && width + escapedWidth > size) {
      pieces.push(piece);
      piece = '';
      width = 0;
    }
    piece += character;
    width += escapedWidth;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * Mounts the MBON graph readout visualization into root.
 *
 * @param {HTMLElement} root - Container (div#readout-workspace inside .graph-view)
 * @param {HTMLCanvasElement} canvas - Graph WebGPU canvas
 * @returns {{
 *   setGeneration: (state: any) => void,
 *   reset: () => void,
 *   dispose: () => void,
 * }}
 */
export function mountReadout(root, canvas) {
  if (!root) throw new Error('mountReadout requires a root element');

  let isDisposed = false;

  // Stream telemetry state
  let currentRunId = null;
  let currentRequestId = null;
  let lastSeq = -1;
  let epoch = -1;
  let lifecycle = null;
  let completionTokens = [];
  let omittedTokens = 0;

  // Local SSE state fallback
  let localGenerationState = null;
  let currentLocalRunId = null;
  let ignoredLocalRunId = null;

  // Navigation state
  let followLatest = true;
  let selectedTokenIndex = -1; // -1 = latest token
  let selectedPieceIndex = -1; // -1 = latest piece of token
  let selectedSsePieceIndex = -1; // for local SSE pieces

  // Node positions from GPU layout
  let layoutNodes = [];

  // Root styling & class
  root.classList.add(READOUT_CLASSES.OVERLAY);
  root.style.pointerEvents = 'none';

  // SVG for connections
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = READOUT_DOM_IDS.LINKS;
  svg.setAttribute('class', READOUT_CLASSES.LINKS);
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.style.inset = '0';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.pointerEvents = 'none';
  svg.style.overflow = 'visible';

  // Card DOM
  const card = document.createElement('div');
  card.id = READOUT_DOM_IDS.CARD;
  card.className = READOUT_CLASSES.CARD;

  // Header: Pipeline flow title & source provenance
  const header = document.createElement('div');
  header.className = READOUT_CLASSES.HEADER;

  const pipelineLabel = document.createElement('div');
  pipelineLabel.id = READOUT_DOM_IDS.PIPELINE;
  pipelineLabel.className = READOUT_CLASSES.PIPELINE;
  pipelineLabel.textContent = 'Readout';
  pipelineLabel.title = 'MBON → model readout → decoded text. Architectural path, not attribution.';

  const sourceBadge = document.createElement('span');
  sourceBadge.id = READOUT_DOM_IDS.SOURCE_BADGE;
  sourceBadge.className = READOUT_CLASSES.SOURCE_BADGE;

  header.append(pipelineLabel, sourceBadge);

  // Token Details Area
  const tokenView = document.createElement('div');
  tokenView.className = READOUT_CLASSES.TOKEN_VIEW;

  const tokenMeta = document.createElement('div');
  tokenMeta.className = READOUT_CLASSES.TOKEN_META;

  const tokenIdBadge = document.createElement('span');
  tokenIdBadge.id = READOUT_DOM_IDS.TOKEN_ID;
  tokenIdBadge.className = READOUT_CLASSES.TOKEN_ID;

  const tokenStatusBadge = document.createElement('span');
  tokenStatusBadge.id = READOUT_DOM_IDS.TOKEN_STATUS;
  tokenStatusBadge.className = READOUT_CLASSES.TOKEN_STATUS;

  const pieceGroup = document.createElement('span');
  pieceGroup.className = READOUT_CLASSES.PIECE_GROUP;


  const pieceBadge = document.createElement('span');
  pieceBadge.id = READOUT_DOM_IDS.PIECE_BADGE;
  pieceBadge.className = READOUT_CLASSES.PIECE_BADGE;
  pieceBadge.textContent = '';


  pieceGroup.append(pieceBadge);
  tokenMeta.append(tokenIdBadge, tokenStatusBadge, pieceGroup);

  const textBox = document.createElement('div');
  textBox.id = READOUT_DOM_IDS.TEXT_BOX;
  textBox.className = READOUT_CLASSES.TEXT_BOX;
  textBox.textContent = '—';

  tokenView.append(tokenMeta, textBox);

  // Controls toolbar
  const controls = document.createElement('div');
  controls.className = READOUT_CLASSES.CONTROLS;

  const prevBtn = document.createElement('button');
  prevBtn.id = READOUT_DOM_IDS.PREV_BTN;
  prevBtn.className = READOUT_CLASSES.BTN;
  prevBtn.type = 'button';
  prevBtn.textContent = 'Previous';

  const posLabel = document.createElement('span');
  posLabel.id = READOUT_DOM_IDS.POS_LABEL;
  posLabel.className = READOUT_CLASSES.POS_LABEL;
  posLabel.textContent = '—';

  const nextBtn = document.createElement('button');
  nextBtn.id = READOUT_DOM_IDS.NEXT_BTN;
  nextBtn.className = READOUT_CLASSES.BTN;
  nextBtn.type = 'button';
  nextBtn.textContent = 'Next';

  const latestBtn = document.createElement('button');
  latestBtn.id = READOUT_DOM_IDS.LATEST_BTN;
  latestBtn.className = READOUT_CLASSES.BTN;
  latestBtn.type = 'button';
  latestBtn.textContent = 'Latest';

  controls.append(prevBtn, posLabel, nextBtn, latestBtn);

  card.append(header, tokenView, controls);
  root.replaceChildren(svg, card);

  // Default initial state: hide overlay until MBON nodes arrive
  root.style.display = 'none';

  let renderPending = false;
  let rafHandle = null;

  function scheduleRender() {
    if (renderPending || isDisposed) return;
    renderPending = true;
    rafHandle = requestAnimationFrame(() => {
      renderPending = false;
      rafHandle = null;
      renderCard();
      updateLinksGeometry();
    });
  }

  // --- Rendering ---
  function renderCard() {
    if (isDisposed) return;

    // Determine data source: Stream Telemetry vs Local SSE
    const hasStreamTokens = completionTokens.length > 0;
    const hasLocalText = Boolean(localGenerationState?.text);

    if (hasStreamTokens) {
      // 1. STREAM TELEMETRY MODE
      const totalTokens = completionTokens.length;
      let tokIdx = followLatest ? totalTokens - 1 : selectedTokenIndex;
      if (tokIdx < 0 || tokIdx >= totalTokens) tokIdx = totalTokens - 1;

      const activeToken = completionTokens[tokIdx];
      const pieces = splitIntoPieces(activeToken.token_text, PIECE_SIZE);
      const totalPieces = pieces.length;

      let pieceIdx = followLatest ? totalPieces - 1 : selectedPieceIndex;
      if (pieceIdx < 0 || pieceIdx >= totalPieces) {
        pieceIdx = followLatest ? totalPieces - 1 : 0;
      }

      // Source badge (Stream)
      sourceBadge.textContent = 'Live';
      sourceBadge.title = `Stream run: ${currentRunId}; request: ${activeToken.request_id}${lifecycle ? `; ${lifecycle.impl}, ${lifecycle.model_id}, checkpoint ${lifecycle.ckpt_digest}` : ''}`;
      sourceBadge.setAttribute('data-source', 'stream');

      // Token ID & status
      tokenIdBadge.textContent = `#${activeToken.token_id}`;
      tokenIdBadge.title = `Token index ${activeToken.token_index}`;
      tokenStatusBadge.title = `Graph step ${activeToken.t}`;

      if (activeToken.t === -1 || activeToken.step_status === 'unprocessed') {
        tokenStatusBadge.textContent = 'unprocessed';
        tokenStatusBadge.setAttribute('data-status', 'unprocessed');
      } else if (activeToken.step_status === 'stepped_fired') {
        tokenStatusBadge.textContent = 'fired';
        tokenStatusBadge.setAttribute('data-status', 'stepped_fired');
      } else if (activeToken.step_status === 'stepped_silent') {
        tokenStatusBadge.textContent = 'silent';
        tokenStatusBadge.setAttribute('data-status', 'stepped_silent');
      } else {
        tokenStatusBadge.textContent = 'stepped';
        tokenStatusBadge.setAttribute('data-status', 'stepped');
      }

      // Piece badge & controls
      if (totalPieces > 1) {
        pieceGroup.style.display = '';
        pieceBadge.textContent = `Piece ${pieceIdx + 1}/${totalPieces}`;
      } else {
        pieceGroup.style.display = 'none';
        pieceBadge.textContent = '';
      }

      // Text box
      const textPiece = pieces[pieceIdx];
      if (textPiece && textPiece.length > 0) {
        textBox.textContent = JSON.stringify(textPiece);
        textBox.setAttribute('data-state', 'text');
      } else if (activeToken.token_bytes && activeToken.token_bytes.length > 0) {
        textBox.textContent = '[UTF-8 bytes pending]';
        textBox.setAttribute('data-state', 'bytes');
      } else {
        textBox.textContent = '[empty token]';
        textBox.setAttribute('data-state', 'empty');
      }
      textBox.title = `Raw bytes: ${activeToken.token_bytes || '(none)'}`;

      // Navigation toolbar
      const isAtFirst = tokIdx === 0 && pieceIdx === 0;
      const isAtLast = tokIdx === totalTokens - 1 && pieceIdx === totalPieces - 1;
      prevBtn.disabled = isAtFirst;
      nextBtn.disabled = isAtLast;
      latestBtn.disabled = followLatest || (tokIdx === totalTokens - 1 && pieceIdx === totalPieces - 1);
      controls.style.display = totalTokens > 1 || totalPieces > 1 ? '' : 'none';

      posLabel.textContent = `${tokIdx + 1}/${totalTokens}${omittedTokens ? ` · ${omittedTokens} omitted` : ''}`;

    } else if (hasLocalText) {
      // 2. LOCAL SSE FALLBACK MODE
      const sseText = localGenerationState.text || '';
      const pieces = splitIntoPieces(sseText, PIECE_SIZE);
      const totalPieces = pieces.length;

      let pieceIdx = followLatest ? totalPieces - 1 : selectedSsePieceIndex;
      if (pieceIdx < 0 || pieceIdx >= totalPieces) {
        pieceIdx = followLatest ? totalPieces - 1 : 0;
      }

      // Source badge (Local SSE)
      sourceBadge.textContent = 'Local';
      sourceBadge.title = `Local frontend run: ${localGenerationState.runId || 'unknown'}`;
      sourceBadge.setAttribute('data-source', 'local_sse');

      tokenIdBadge.textContent = `Piece ${pieceIdx + 1}/${totalPieces}`;
      tokenIdBadge.title = '';
      tokenStatusBadge.title = '';
      tokenStatusBadge.textContent = localGenerationState.state || 'local SSE';
      tokenStatusBadge.setAttribute('data-status', 'local');

      if (totalPieces > 1) {
        pieceGroup.style.display = '';
        pieceBadge.textContent = `Piece ${pieceIdx + 1}/${totalPieces}`;
      } else {
        pieceGroup.style.display = 'none';
        pieceBadge.textContent = '';
      }

      const textPiece = pieces[pieceIdx];
      textBox.textContent = textPiece.length > 0 ? JSON.stringify(textPiece) : '[empty piece]';
      textBox.setAttribute('data-state', 'text');
      textBox.title = 'Actual local SSE text; no token IDs or graph-step alignment available';

      prevBtn.disabled = pieceIdx === 0;
      nextBtn.disabled = pieceIdx === totalPieces - 1;
      latestBtn.disabled = followLatest || pieceIdx === totalPieces - 1;
      controls.style.display = totalPieces > 1 ? '' : 'none';
      posLabel.textContent = `${pieceIdx + 1}/${totalPieces}`;

    } else {
      // 3. AWAITING OUTPUT
      sourceBadge.textContent = '';
      sourceBadge.title = 'No stream or local generation output received yet';
      sourceBadge.removeAttribute('data-source');
      tokenIdBadge.textContent = '';
      tokenIdBadge.title = '';
      tokenStatusBadge.textContent = '';
      tokenStatusBadge.title = '';
      tokenStatusBadge.removeAttribute('data-status');
      pieceGroup.style.display = 'none';
      pieceBadge.textContent = '';
      textBox.textContent = '—';
      textBox.setAttribute('data-state', 'none');
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      latestBtn.disabled = true;
      controls.style.display = 'none';
      posLabel.textContent = '—';
    }
  }

  // --- SVG Link Geometry ---
  function updateLinksGeometry() {
    if (isDisposed || !svg) return;
    if (!layoutNodes || layoutNodes.length === 0) {
      root.style.display = 'none';
      svg.replaceChildren();
      return;
    }
    root.style.display = '';

    const rootRect = root.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) return;
    const cardLeft = cardRect.left - rootRect.left;
    const cardTop = cardRect.top - rootRect.top;
    const hubX = Math.max(10, cardLeft - 32);
    const hubY = cardTop + Math.min(36, cardRect.height / 2);
    const cardConnX = cardLeft;
    const cardConnY = hubY;

    const elements = [];

    // MBON -> hub paths
    for (const node of layoutNodes) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', READOUT_CLASSES.LINK_MBON);
      path.setAttribute('data-node-id', String(node.id));

      path.setAttribute('fill', 'none');

      const dx = hubX - node.x;
      const cp1x = node.x + dx * 0.5;
      const cp1y = node.y;
      const cp2x = node.x + dx * 0.5;
      const cp2y = hubY;
      path.setAttribute('d', `M ${node.x.toFixed(1)} ${node.y.toFixed(1)} C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${hubX.toFixed(1)} ${hubY.toFixed(1)}`);
      elements.push(path);
    }

    // Hub -> card path
    const hubToCard = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hubToCard.setAttribute('class', READOUT_CLASSES.LINK_HUB);
    hubToCard.setAttribute('d', `M ${hubX.toFixed(1)} ${hubY.toFixed(1)} L ${cardConnX.toFixed(1)} ${cardConnY.toFixed(1)}`);
    hubToCard.setAttribute('fill', 'none');
    hubToCard.setAttribute('stroke', 'rgba(255, 184, 72, 0.6)');
    hubToCard.setAttribute('stroke-width', '2');
    elements.push(hubToCard);

    // Hub node circle
    const hubCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hubCircle.setAttribute('class', READOUT_CLASSES.HUB_NODE);
    hubCircle.setAttribute('cx', hubX.toFixed(1));
    hubCircle.setAttribute('cy', hubY.toFixed(1));
    hubCircle.setAttribute('r', '4');
    hubCircle.setAttribute('fill', '#ffb848');
    hubCircle.setAttribute('stroke', '#1a1f29');
    hubCircle.setAttribute('stroke-width', '1.5');
    elements.push(hubCircle);

    // Hub label
    const hubLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    hubLabel.setAttribute('class', READOUT_CLASSES.HUB_LABEL);
    hubLabel.setAttribute('x', hubX.toFixed(1));
    hubLabel.setAttribute('y', (hubY - 7).toFixed(1));
    hubLabel.setAttribute('text-anchor', 'middle');
    hubLabel.setAttribute('fill', '#ffb848');
    hubLabel.setAttribute('font-size', '9px');
    hubLabel.setAttribute('font-family', 'sans-serif');
    hubLabel.textContent = 'Readout';
    elements.push(hubLabel);

    svg.replaceChildren(...elements);
  }

  // --- Navigation Event Handlers ---
  prevBtn.addEventListener('click', () => {
    if (completionTokens.length > 0) {
      followLatest = false;
      const totalTokens = completionTokens.length;
      let tokIdx = selectedTokenIndex >= 0 ? selectedTokenIndex : totalTokens - 1;
      const activeTok = completionTokens[tokIdx];
      const pieces = splitIntoPieces(activeTok.token_text, PIECE_SIZE);
      let pieceIdx = selectedPieceIndex >= 0 ? selectedPieceIndex : pieces.length - 1;

      if (pieceIdx > 0) {
        selectedPieceIndex = pieceIdx - 1;
        selectedTokenIndex = tokIdx;
      } else if (tokIdx > 0) {
        selectedTokenIndex = tokIdx - 1;
        const prevTok = completionTokens[selectedTokenIndex];
        const prevPieces = splitIntoPieces(prevTok.token_text, PIECE_SIZE);
        selectedPieceIndex = prevPieces.length - 1;
      }
    } else if (localGenerationState?.text) {
      followLatest = false;
      const pieces = splitIntoPieces(localGenerationState.text, PIECE_SIZE);
      let pieceIdx = selectedSsePieceIndex >= 0 ? selectedSsePieceIndex : pieces.length - 1;
      if (pieceIdx > 0) {
        selectedSsePieceIndex = pieceIdx - 1;
      }
    }
    renderCard();
  });

  nextBtn.addEventListener('click', () => {
    if (completionTokens.length > 0) {
      const totalTokens = completionTokens.length;
      let tokIdx = selectedTokenIndex >= 0 ? selectedTokenIndex : totalTokens - 1;
      const activeTok = completionTokens[tokIdx];
      const pieces = splitIntoPieces(activeTok.token_text, PIECE_SIZE);
      let pieceIdx = selectedPieceIndex >= 0 ? selectedPieceIndex : pieces.length - 1;

      if (pieceIdx < pieces.length - 1) {
        selectedPieceIndex = pieceIdx + 1;
        selectedTokenIndex = tokIdx;
      } else if (tokIdx < totalTokens - 1) {
        selectedTokenIndex = tokIdx + 1;
        selectedPieceIndex = 0;
        if (selectedTokenIndex === totalTokens - 1) {
          const nextTok = completionTokens[selectedTokenIndex];
          const nextPieces = splitIntoPieces(nextTok.token_text, PIECE_SIZE);
          if (nextPieces.length <= 1) followLatest = true;
        }
      } else {
        followLatest = true;
      }
    } else if (localGenerationState?.text) {
      const pieces = splitIntoPieces(localGenerationState.text, PIECE_SIZE);
      let pieceIdx = selectedSsePieceIndex >= 0 ? selectedSsePieceIndex : pieces.length - 1;
      if (pieceIdx < pieces.length - 1) {
        selectedSsePieceIndex = pieceIdx + 1;
        if (selectedSsePieceIndex === pieces.length - 1) followLatest = true;
      } else {
        followLatest = true;
      }
    }
    renderCard();
  });

  latestBtn.addEventListener('click', () => {
    followLatest = true;
    selectedTokenIndex = -1;
    selectedPieceIndex = -1;
    selectedSsePieceIndex = -1;
    renderCard();
  });


  // --- Canvas & Layout Events ---
  const onReadoutLayout = (event) => {
    if (isDisposed) return;
    const detail = event?.detail;
    layoutNodes = detail?.nodes ? detail.nodes.slice() : [];
    updateLinksGeometry();
  };
  const onTelemetry = (event) => {
    if (isDisposed) return;
    acceptMessage(event?.detail);
  };
  const onMapping = () => {
    if (!isDisposed) reset();
  };
  const onReset = () => {
    if (!isDisposed) reset();
  };

  canvas?.addEventListener('readout-layout', onReadoutLayout);
  canvas?.addEventListener('telemetry', onTelemetry);
  canvas?.addEventListener('mapping', onMapping);
  canvas?.addEventListener('reset', onReset);

  const onResize = () => {
    if (!isDisposed) updateLinksGeometry();
  };
  window.addEventListener('resize', onResize);

  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      if (!isDisposed) updateLinksGeometry();
    });
    resizeObserver.observe(root);
  }

  // --- Telemetry Ingestion ---
  const acceptMessage = (msg) => {
    if (isDisposed) return false;

    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      return false;
    }
    // Ignore memory telemetry extensions
    if (msg.type === 'memory_summary' || msg.type === 'memory_slice') {
      return false;
    }

    const acceptedTypes = ['request_lifecycle', 'token_step', 'stream_status'];
    if (!acceptedTypes.includes(msg.type)) return false;

    // Validate envelope scalar types before mutating state
    if (typeof msg.run_id !== 'string' || msg.run_id.length === 0) return false;
    if (!Number.isInteger(msg.seq) || msg.seq < 0) return false;
    if (!Number.isInteger(msg.epoch) || msg.epoch < 0) return false;

    if (msg.run_id === currentRunId && msg.seq <= lastSeq) {
      return false;
    }
    if (msg.run_id === currentRunId && msg.epoch < epoch) return false;

    // Message-specific validation
    if (msg.type === 'stream_status') {
      if (!['gap', 'resync', 'epoch_reset'].includes(msg.event)) return false;
      if (!Number.isInteger(msg.dropped_steps) || msg.dropped_steps < 0) return false;
      if (!Number.isInteger(msg.server_time_ms) || msg.server_time_ms < 0) return false;
    } else if (msg.type === 'request_lifecycle') {
      if (typeof msg.request_id !== 'string' || msg.request_id.length === 0) return false;
      if (typeof msg.impl !== 'string' || typeof msg.model_id !== 'string' || typeof msg.ckpt_digest !== 'string') return false;
      if (!['queued', 'prefill', 'decode', 'completed', 'cancelled', 'failed'].includes(msg.phase)) return false;
      if (!Number.isInteger(msg.t_start) || msg.t_start < -1) return false;
      if (!Number.isInteger(msg.prompt_raw_tokens) || msg.prompt_raw_tokens < 0) return false;
      if (!Number.isInteger(msg.prompt_tokens) || msg.prompt_tokens < 0) return false;
      if (!Number.isInteger(msg.max_tokens) || msg.max_tokens < 0) return false;
      if (!Number.isInteger(msg.completion_tokens) || msg.completion_tokens < 0) return false;
      if (!['none', 'stop', 'length', 'cancelled', 'error'].includes(msg.finish_reason)) return false;
      if (!Number.isInteger(msg.server_time_ms) || msg.server_time_ms < 0) return false;
      if (typeof msg.timestamp_ns !== 'string' || !/^[0-9]+$/.test(msg.timestamp_ns)) return false;
    } else if (msg.type === 'token_step') {
      if (typeof msg.request_id !== 'string' || msg.request_id.length === 0) return false;
      if (!['prompt', 'completion'].includes(msg.kind)) return false;
      if (!Number.isInteger(msg.token_index) || msg.token_index < 0) return false;
      if (!Number.isInteger(msg.token_id) || msg.token_id < 0) return false;
      if (typeof msg.token_text !== 'string') return false;
      if (typeof msg.token_bytes !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(msg.token_bytes)) return false;
      if (!['stepped_fired', 'stepped_silent', 'unprocessed'].includes(msg.step_status)) return false;
      if (!Number.isInteger(msg.t) || msg.t < -1) return false;
      if (!Number.isInteger(msg.step_rel_us) || msg.step_rel_us < 0) return false;
      if (!Number.isInteger(msg.emit_rel_us) || msg.emit_rel_us < 0) return false;
      if (typeof msg.step_ns !== 'string' || !/^[0-9]+$/.test(msg.step_ns)) return false;
      if (typeof msg.emit_ns !== 'string' || !/^[0-9]+$/.test(msg.emit_ns)) return false;
      if ((msg.step_status === 'unprocessed') !== (msg.t === -1)) return false;
    }

    // Atomic State Commit
    if (msg.run_id !== currentRunId) {
      currentRunId = msg.run_id;
      lifecycle = null;
      omittedTokens = 0;
      currentRequestId = null;
      lastSeq = -1;
      completionTokens = [];
      followLatest = true;
      selectedTokenIndex = -1;
      selectedPieceIndex = -1;
    } else if (msg.epoch > epoch) {
      completionTokens = [];
      omittedTokens = 0;
      followLatest = true;
      selectedTokenIndex = selectedPieceIndex = -1;
    }
    lastSeq = msg.seq;
    epoch = msg.epoch;

    if (msg.type === 'stream_status') {
      if (msg.event === 'gap' || msg.event === 'epoch_reset' || msg.event === 'resync') {
        completionTokens = [];
        omittedTokens = 0;
        followLatest = true;
        selectedTokenIndex = -1;
        selectedPieceIndex = -1;
      }
      scheduleRender();
      return true;
    }

    if (msg.type === 'request_lifecycle') {
      if (msg.request_id !== currentRequestId) {
        currentRequestId = msg.request_id;
        completionTokens = [];
        omittedTokens = 0;
        followLatest = true;
        selectedTokenIndex = selectedPieceIndex = -1;
      }
      lifecycle = msg;
      scheduleRender();
      return true;
    }

    if (msg.type === 'token_step') {
      // Process completion tokens only
      if (msg.kind === 'completion') {
        if (msg.request_id !== currentRequestId) {
          currentRequestId = msg.request_id;
          completionTokens = [];
          omittedTokens = 0;
          followLatest = true;
          selectedTokenIndex = -1;
          selectedPieceIndex = -1;
        }
        completionTokens.push(msg);
        if (completionTokens.length > MAX_COMPLETION_TOKENS) {
          completionTokens.shift();
          omittedTokens++;
          if (!followLatest) {
            if (selectedTokenIndex === 0) selectedPieceIndex = 0;
            selectedTokenIndex = Math.max(0, selectedTokenIndex - 1);
          }
        }
        if (followLatest) {
          selectedTokenIndex = -1;
          selectedPieceIndex = -1;
        }
        scheduleRender();
      }
      return true;
    }

    return true;
  };

  const setGeneration = (state) => {
    if (isDisposed || !state || typeof state !== 'object') return;
    if (state.runId && state.runId === ignoredLocalRunId) return;
    const changedRun = state.runId !== currentLocalRunId;
    localGenerationState = state;
    if (changedRun) {
      currentLocalRunId = state.runId;
      ignoredLocalRunId = null;
      completionTokens = [];
      omittedTokens = 0;
      followLatest = true;
      selectedTokenIndex = selectedPieceIndex = selectedSsePieceIndex = -1;
    }
    // Update card if stream tokens are not overriding
    if (completionTokens.length === 0) {
      scheduleRender();
    }
  };

  const reset = () => {
    ignoredLocalRunId = isGenerationActive(localGenerationState?.state) ? null : currentLocalRunId;
    completionTokens = [];
    omittedTokens = 0;
    epoch = -1;
    currentRunId = null;
    currentRequestId = null;
    lastSeq = -1;
    lifecycle = null;
    localGenerationState = null;
    currentLocalRunId = null;
    followLatest = true;
    selectedTokenIndex = -1;
    selectedPieceIndex = -1;
    selectedSsePieceIndex = -1;
    scheduleRender();
  };

  const dispose = () => {
    if (isDisposed) return;
    isDisposed = true;
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    resizeObserver?.disconnect();
    window.removeEventListener('resize', onResize);
    canvas?.removeEventListener('readout-layout', onReadoutLayout);
    canvas?.removeEventListener('telemetry', onTelemetry);
    canvas?.removeEventListener('mapping', onMapping);
    canvas?.removeEventListener('reset', onReset);
    root.replaceChildren();
    root.style.display = 'none';
  };

  return {
    setGeneration,
    reset,
    dispose,
  };
}
