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
  if (state === 'connected') return 'Live';
  if (state === 'connecting') return 'Connecting…';
  if (state === 'reconnecting') return 'Reconnecting…';
  if (state === 'background') return 'Stream paused';
  if (state === 'unsupported') return 'Protocol unsupported';
  if (state === 'error') return 'Stream error';
  return 'Stream offline';
}

export interface AtlasWorkspaceProps {
  endpoint?: string;
  connectionStyle?: 'lines' | 'dots';
}

export const AtlasWorkspace = forwardRef<LiveAtlasHandle, AtlasWorkspaceProps>(
  function AtlasWorkspace({ endpoint, connectionStyle = 'dots' }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const labelsRef = useRef<HTMLDivElement>(null);
    const inspectorRef = useRef<HTMLDivElement>(null);
    const readoutRef = useRef<HTMLDivElement>(null);
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
        setGeneration: (state) => {
          handleRef.current?.setGeneration(state);
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
      const readout = readoutRef.current;
      if (!canvas || !labels || !inspector || !readout) return;

      const handle = mountLiveAtlas({
        canvas,
        labels,
        inspector,
        readout,
        connectionStyle,
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
    }, [endpoint, connectionStyle]);

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
          <Panel aria-label="Neural atlas" className="atlas-viewport-panel">
            <div className="atlas-panel__header-row">
              <div className="atlas-panel__status-group">
                <Status
                  aria-live="polite"
                  pulse={isPending}
                  tone={stateTone(snapshot.connectionState)}
                >
                  {stateLabel(snapshot.connectionState)}
                </Status>
                {snapshot.nodeCount > 0 && (
                  <span className="atlas-compact-metrics">
                    <span>{snapshot.nodeCount.toLocaleString()} nodes</span>
                    <span aria-hidden="true">·</span>
                    <span>{snapshot.edgeCount.toLocaleString()} edges</span>
                    {droppedTotal > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="atlas-metrics-dropped">
                          {droppedTotal} dropped
                        </span>
                      </>
                    )}
                  </span>
                )}
              </div>
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
                <div
                  aria-label="MBON readout to decoded text"
                  className="atlas-viewport__readout"
                  ref={readoutRef}
                />

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
                    title={snapshot.gpuMessage ?? 'WebGPU unavailable'}
                  >
                    <span>
                      {window.isSecureContext
                        ? 'WebGPU unavailable'
                        : 'HTTPS required for graph'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </Panel>

          {/* Inspector & Group Legend Panel */}
          <Panel aria-label="Circuit details" className="atlas-inspector-panel">
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
                          <th scope="col">Nodes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.groups.map((group) => (
                          <tr
                            key={group.id}
                            title={`Group ${group.id} · ${group.placement}`}
                          >
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
                            <td>{group.count.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </div>
      </div>
    );
  },
);
