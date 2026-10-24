import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AtlasWorkspace } from './components/atlas/AtlasWorkspace';
import type { LiveAtlasHandle } from '../../harness/app/live-atlas.js';
import {
  ArrowIcon,
  BrandMark,
  CopyIcon,
  MoonIcon,
  SlidersIcon,
  SunIcon,
} from './components/BrandMark';
import { GenerationSettings } from './components/GenerationSettings';
import {
  Button,
  Field,
  Panel,
  Status,
  Textarea,
  Tooltip,
} from './components/ui';
import { ACTIVE_GENERATION_STATES, useGeneration } from './hooks/useGeneration';
import { useTheme } from './hooks/useTheme';

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready',
  validating: 'Checking',
  submitting: 'Starting',
  streaming: 'Generating',
  cancelling: 'Stopping',
  completed: 'Done',
  cancelled: 'Stopped',
  failed: 'Failed',
};

function stateTone(
  state: string,
): 'neutral' | 'positive' | 'warning' | 'negative' {
  if (state === 'completed') return 'positive';
  if (state === 'cancelled') return 'warning';
  if (state === 'failed') return 'negative';
  return 'neutral';
}

type CopyState = 'copied' | 'failed' | 'idle';

export function App() {
  const { cancel, clear, retryLoad, runtime, runtimeStatus, snapshot, submit } =
    useGeneration();
  const { theme, toggleTheme } = useTheme();
  const [prompt, setPrompt] = useState('');
  const [maxTokens, setMaxTokens] = useState('64');
  const [temperature, setTemperature] = useState('1');
  const [topK, setTopK] = useState('50');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const copyTimerRef = useRef<number | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const atlasHandleRef = useRef<LiveAtlasHandle | null>(null);
  const active = Boolean(ACTIVE_GENERATION_STATES[snapshot.state]);
  const ready = snapshot.health.ready;
  const healthPending = runtimeStatus.state === 'loading';
  const healthTone =
    runtimeStatus.state === 'ready'
      ? 'positive'
      : runtimeStatus.state === 'error'
        ? 'negative'
        : 'warning';
  const healthLabel =
    runtimeStatus.state === 'loading'
      ? `Loading model ${Math.round(runtimeStatus.progress * 100)}%`
      : runtimeStatus.state === 'ready'
        ? `Model ready · ${snapshot.health.modelId ?? 'vibe2-tinystories'}`
        : 'Model unavailable';
  const canClear = Boolean(
    prompt ||
    snapshot.text ||
    snapshot.error ||
    Object.keys(snapshot.validationErrors).length ||
    snapshot.state !== 'idle',
  );

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null)
        window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    atlasHandleRef.current?.setGeneration(snapshot);
  }, [snapshot]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active || !ready) return;
    const result = await submit({ prompt, maxTokens, temperature, topK });
    if (
      result &&
      !result.success &&
      'errors' in result &&
      (result.errors.maxTokens ||
        result.errors.temperature ||
        result.errors.topK)
    ) {
      setIsSettingsOpen(true);
    }
  }

  async function handleCopy() {
    if (!snapshot.text) return;
    let nextState: CopyState;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(snapshot.text);
      nextState = 'copied';
    } catch {
      nextState = 'failed';
    }
    setCopyState(nextState);
    if (copyTimerRef.current !== null)
      window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
  }

  function handleClear() {
    if (active) return;
    setPrompt('');
    clear();
  }

  function handleOpenSettings() {
    setIsSettingsOpen(true);
  }

  function handleCloseSettings() {
    setIsSettingsOpen(false);
    requestAnimationFrame(() => {
      settingsTriggerRef.current?.focus();
    });
  }

  return (
    <>
      <a className="skip-link" href="#prompt-laboratory">
        Skip to prompt laboratory
      </a>
      <div aria-hidden="true" className="page-grid" />
      <header className="site-header">
        <a aria-label="FlyBrainLM home" className="brand" href="/">
          <span className="brand__mark-wrap">
            <BrandMark />
          </span>
          <span>
            <strong>FlyBrain</strong>
            <span className="brand__suffix">LM</span>
          </span>
        </a>
        <div className="site-header__actions">
          <Status
            aria-live="polite"
            pulse={healthPending}
            title={runtimeStatus.message}
            tone={healthTone}
          >
            {healthLabel}
          </Status>
          {runtimeStatus.state === 'error' && (
            <Button onClick={retryLoad} size="compact" variant="quiet">
              Retry
            </Button>
          )}
          <Tooltip
            content={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            placement="bottom"
          >
            <Button
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              className="icon-button"
              onClick={toggleTheme}
              variant="quiet"
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </Button>
          </Tooltip>
        </div>
      </header>

      <main id="prompt-laboratory" tabIndex={-1}>
        <h1 className="sr-only">FlyBrainLM Prompt Laboratory</h1>

        <div className="workspace">
          <Panel className="composer" title="Prompt">
            <form noValidate onSubmit={(event) => void handleSubmit(event)}>
              <Field
                error={snapshot.validationErrors.prompt}
                htmlFor="prompt"
                label="Prompt"
              >
                <Textarea
                  id="prompt"
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      !event.nativeEvent.isComposing &&
                      !event.repeat &&
                      (event.ctrlKey || event.metaKey) &&
                      event.key === 'Enter'
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Give the circuit something worth continuing…"
                  rows={10}
                  value={prompt}
                />
              </Field>

              {snapshot.error &&
                !Object.keys(snapshot.validationErrors).length && (
                  <div className="error-banner" role="alert">
                    <strong>Generation did not complete.</strong>
                    <span>{snapshot.error}</span>
                  </div>
                )}

              <div className="composer__actions">
                <Button
                  disabled={active || !ready}
                  type="submit"
                  variant="primary"
                >
                  {active ? STATE_LABEL[snapshot.state] : 'Run prompt'}
                  <ArrowIcon />
                </Button>
                <Button
                  aria-expanded={isSettingsOpen}
                  aria-haspopup="dialog"
                  onClick={handleOpenSettings}
                  ref={settingsTriggerRef}
                  type="button"
                  variant="quiet"
                >
                  <SlidersIcon /> Settings
                </Button>
                {active ? (
                  <Button onClick={cancel}>Cancel</Button>
                ) : (
                  <Button
                    disabled={!canClear}
                    onClick={handleClear}
                    variant="quiet"
                  >
                    Clear
                  </Button>
                )}
              </div>
            </form>
          </Panel>

          <Panel className="response" title="Response">
            <div className="response__status-row">
              <Status
                aria-live="polite"
                pulse={active}
                tone={stateTone(snapshot.state)}
              >
                {STATE_LABEL[snapshot.state] ?? snapshot.state}
              </Status>
              {snapshot.text && (
                <Tooltip content="Copy generated text">
                  <Button
                    aria-label={
                      copyState === 'copied'
                        ? 'Generated text copied'
                        : copyState === 'failed'
                          ? 'Copy failed'
                          : 'Copy generated text'
                    }
                    aria-live="polite"
                    className="copy-button"
                    onClick={() => void handleCopy()}
                    size="compact"
                    variant="quiet"
                  >
                    <CopyIcon />{' '}
                    {copyState === 'copied'
                      ? 'Copied'
                      : copyState === 'failed'
                        ? 'Copy failed'
                        : 'Copy'}
                  </Button>
                </Tooltip>
              )}
            </div>

            <div
              aria-busy={active}
              aria-label="Generated model output"
              className="response__body"
              role="region"
              tabIndex={0}
            >
              {snapshot.text ? <pre>{snapshot.text}</pre> : null}
            </div>
          </Panel>
        </div>

        <AtlasWorkspace ref={atlasHandleRef} runtime={runtime} />
      </main>

      <GenerationSettings
        isOpen={isSettingsOpen}
        maxTokens={maxTokens}
        onClose={handleCloseSettings}
        onMaxTokensChange={setMaxTokens}
        onTemperatureChange={setTemperature}
        onTopKChange={setTopK}
        temperature={temperature}
        topK={topK}
        validationErrors={snapshot.validationErrors}
      />
    </>
  );
}
