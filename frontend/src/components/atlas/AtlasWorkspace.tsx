import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Button, Panel, Status, Tooltip } from '../ui';
import { mountLiveAtlas } from '../../../../harness/app/live-atlas.js';
import type {
  LiveAtlasHandle,
  LiveAtlasSnapshot,
} from '../../../../harness/app/live-atlas.js';
import './AtlasWorkspace.css';

const INITIAL_SNAPSHOT: LiveAtlasSnapshot = {
  connectionState: 'connecting',
  connectionMessage: 'Connecting to live stream…',
  gpuMessage: 'Initializing WebGPU…',
  nodeCount: 0,
  edgeCount: 0,
  groups: [],
  lastStep: null,
  acceptedFires: 0,
  droppedMessages: 0,
  droppedPairs: 0,
};

function stateTone(
  state: string,
): 'neutral' | 'positive' | 'warning' | 'negative' {
  if (state === 'connected') return 'positive';
  if (state === 'connecting' || state === 'reconnecting') return 'warning';
  if (state === 'unsupported' || state === 'error') return 'negative';
  return 'neutral';
}

function stateLabel(state: string): string {
  if (state === 'connected') return 'Stream live';
  if (state === 'connecting') return 'Connecting…';
  if (state === 'reconnecting') return 'Reconnecting…';
  if (state === 'background') return 'Stream paused';
  if (state === 'unsupported') return 'Protocol unsupported';
  if (state === 'error') return 'Stream error';
  return 'Stream offline';
}

export interface AtlasWorkspaceProps {
  endpoint?: string;
}

export const AtlasWorkspace = forwardRef<LiveAtlasHandle, AtlasWorkspaceProps>(
  function AtlasWorkspace({ endpoint }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const labelsRef = useRef<HTMLDivElement>(null);
    const inspectorRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<LiveAtlasHandle | null>(null);

    const [snapshot, setSnapshot] =
      useState<LiveAtlasSnapshot>(INITIAL_SNAPSHOT);

    useImperativeHandle(
      ref,
      () => ({
        ensureConnected: () => {
          handleRef.current?.ensureConnected();
        },
        connect: () => {
          handleRef.current?.connect();
        },
        disconnect: () => {
          handleRef.current?.disconnect();
        },
        fit: () => {
          handleRef.current?.fit();
        },
        zoom: (factor: number) => {
          handleRef.current?.zoom(factor);
        },
        dispose: () => {
          handleRef.current?.dispose();
        },
      }),
      [],
    );

    useEffect(() => {
      const canvas = canvasRef.current;
      const labels = labelsRef.current;
      const inspector = inspectorRef.current;
      if (!canvas || !labels || !inspector) return;

      const handle = mountLiveAtlas({
        canvas,
        labels,
        inspector,
        onState: (nextSnapshot) => {
          setSnapshot(nextSnapshot);
        },
        ...(endpoint ? { endpoint } : {}),
      });

      handleRef.current = handle;

      return () => {
        handleRef.current = null;
        handle.dispose();
      };
    }, [endpoint]);

    const isConnected = snapshot.connectionState === 'connected';
    const isPending =
      snapshot.connectionState === 'connecting' ||
      snapshot.connectionState === 'reconnecting';

    const isGpuUnavailable = Boolean(
      snapshot.gpuMessage &&
      /unavailable|cannot render|failed|lost|error/i.test(snapshot.gpuMessage),
    );

    const droppedTotal = snapshot.droppedMessages + snapshot.droppedPairs;

    function handleFit() {
      handleRef.current?.fit();
    }

    function handleZoomIn() {
      handleRef.current?.zoom(1.25);
    }

    function handleZoomOut() {
      handleRef.current?.zoom(0.8);
    }

    function handleConnect() {
      handleRef.current?.connect();
    }

    function handleDisconnect() {
      handleRef.current?.disconnect();
    }

    return (
      <div className="atlas-workspace-container" id="neural-atlas">
        <div className="atlas-workspace-grid">
          {/* Viewport & Controls Panel */}
          <Panel
            className="atlas-viewport-panel"
            eyebrow="03 / Neural Atlas"
            title="Live brain circuit"
          >
            <div className="atlas-panel__header-row">
              <Status
                aria-live="polite"
                pulse={isPending}
                tone={stateTone(snapshot.connectionState)}
              >
                {stateLabel(snapshot.connectionState)}
              </Status>
              <div className="atlas-panel__header-actions">
                {isConnected || isPending ? (
                  <Button
                    aria-label="Disconnect live websocket stream"
                    onClick={handleDisconnect}
                    size="compact"
                    variant="quiet"
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    aria-label="Connect live websocket stream"
                    onClick={handleConnect}
                    size="compact"
                  >
                    {snapshot.connectionState === 'error'
                      ? 'Retry stream'
                      : 'Connect stream'}
                  </Button>
                )}
              </div>
            </div>

            <div className="atlas-viewport-content">
              {/* Canvas viewport container */}
              <div
                aria-label="Fly brain neural atlas canvas. Use arrow keys to pan, plus/minus to zoom, zero to fit."
                className="atlas-viewport__canvas-container"
                role="region"
              >
                <canvas
                  aria-description="Interactive 2D neural graph. Use arrow keys to pan, plus and minus keys to zoom, zero to fit."
                  aria-label="Fly brain neural atlas visualizer canvas"
                  className="atlas-viewport__canvas"
                  ref={canvasRef}
                  tabIndex={0}
                />
                <div
                  aria-hidden="true"
                  className="atlas-viewport__labels"
                  ref={labelsRef}
                />

                <div className="atlas-viewport__schematic-chip">
                  <span
                    aria-hidden="true"
                    className="atlas-viewport__schematic-dot"
                  />
                  <span>Schematic layout: illustrative positions</span>
                </div>

                <div
                  aria-label="Graph zoom and fit controls"
                  className="atlas-viewport__controls"
                  role="toolbar"
                >
                  <Tooltip content="Fit entire graph in viewport (0 / Home)">
                    <button
                      aria-label="Fit graph in viewport"
                      className="atlas-viewport__controls-button"
                      onClick={handleFit}
                      type="button"
                    >
                      Fit
                    </button>
                  </Tooltip>
                  <Tooltip content="Zoom in (+ / =)">
                    <button
                      aria-label="Zoom in"
                      className="atlas-viewport__controls-button"
                      onClick={handleZoomIn}
                      type="button"
                    >
                      +
                    </button>
                  </Tooltip>
                  <Tooltip content="Zoom out (−)">
                    <button
                      aria-label="Zoom out"
                      className="atlas-viewport__controls-button"
                      onClick={handleZoomOut}
                      type="button"
                    >
                      −
                    </button>
                  </Tooltip>
                </div>

                {isGpuUnavailable && (
                  <div
                    aria-live="polite"
                    className="atlas-viewport__gpu-banner"
                    role="alert"
                  >
                    <strong>WebGPU visualizer unavailable</strong>
                    <p>{snapshot.gpuMessage}</p>
                    <small>
                      Neuron inspection, group legend, and generation remain
                      fully available.
                    </small>
                  </div>
                )}
              </div>

              <div className="atlas-viewport__keyboard-hint">
                <span>
                  Canvas keys: <kbd>Arrow keys</kbd> pan · <kbd>+</kbd>/
                  <kbd>−</kbd> zoom · <kbd>0</kbd> fit
                </span>
                {snapshot.connectionMessage && (
                  <span title={snapshot.connectionMessage}>
                    {snapshot.connectionMessage}
                  </span>
                )}
              </div>

              {/* Real counters from live stream */}
              <dl
                aria-label="Live circuit mapping counters"
                className="atlas-metrics"
              >
                <div>
                  <dt>Mapping Nodes</dt>
                  <dd>{snapshot.nodeCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Declared Edges</dt>
                  <dd>{snapshot.edgeCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Last Step</dt>
                  <dd>
                    {snapshot.lastStep !== null
                      ? snapshot.lastStep.toLocaleString()
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Accepted Fires</dt>
                  <dd>{snapshot.acceptedFires.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Dropped Signals</dt>
                  <dd>{droppedTotal.toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          </Panel>

          {/* Inspector & Group Legend Panel */}
          <Panel
            className="atlas-inspector-panel"
            eyebrow="04 / Circuit Details"
            title="Inspection & Groups"
          >
            <div className="atlas-inspector-content">
              {/* Imperative Inspector mount root */}
              <div
                aria-label="Neuron details inspector"
                className="atlas-inspector-mount"
                ref={inspectorRef}
              />

              {/* Group Legend */}
              <div className="atlas-groups-block">
                <div className="atlas-groups-header">
                  <h3>Circuit groups</h3>
                  <span className="atlas-groups-count">
                    {snapshot.groups.length}{' '}
                    {snapshot.groups.length === 1 ? 'group' : 'groups'}
                  </span>
                </div>

                {snapshot.groups.length === 0 ? (
                  <p className="atlas-empty-notice">
                    Waiting for stream mapping…
                  </p>
                ) : (
                  <div className="atlas-groups-table-wrap">
                    <table className="atlas-groups-table">
                      <caption className="sr-only">
                        Groups in mapping order
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">
                            <span className="sr-only">Colour</span>
                          </th>
                          <th scope="col">Group</th>
                          <th scope="col">ID</th>
                          <th scope="col">Nodes</th>
                          <th scope="col">Placement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.groups.map((group) => (
                          <tr key={group.id}>
                            <td>
                              <span
                                aria-hidden="true"
                                className="atlas-group-swatch"
                                style={{ backgroundColor: group.color }}
                              />
                            </td>
                            <td>
                              <strong>{group.name}</strong>
                            </td>
                            <td>
                              <code>{group.id}</code>
                            </td>
                            <td>{group.count.toLocaleString()}</td>
                            <td>
                              <span className="atlas-placement-tag">
                                {group.placement}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="atlas-caveat-box">
                  <p>
                    <strong>Anatomical note:</strong> Anatomical connectome body
                    IDs (e.g. FlyWire or hemibrain) are unavailable in this
                    model checkpoint mapping. Neurons are indexed by logical
                    circuit ID. Layout positions are illustrative schematic
                    layers rather than measured fruit fly anatomy.
                  </p>
                </div>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    );
  },
);
