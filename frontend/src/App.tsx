import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
import {
  Button,
  Field,
  Input,
  Panel,
  Status,
  Textarea,
  Tooltip,
} from './components/ui';
import { ACTIVE_GENERATION_STATES, useGeneration } from './hooks/useGeneration';
import { useTheme } from './hooks/useTheme';

const PROMPT_STARTERS = [
  'Continue a story about a biologist who discovers a hidden language in a fruit fly colony.',
  'Write a field note from a machine learning researcher watching a sparse neural circuit learn.',
  'Explain associative memory using a garden, three scents, and one surprising reward.',
];

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready for a prompt',
  validating: 'Checking prompt',
  submitting: 'Starting generation',
  streaming: 'Signals are moving',
  cancelling: 'Stopping safely',
  completed: 'Generation complete',
  cancelled: 'Generation stopped',
  failed: 'Needs attention',
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
  const { cancel, clear, retryHealth, setApiKey, snapshot, submit } =
    useGeneration();
  const { theme, toggleTheme } = useTheme();
  const [prompt, setPrompt] = useState('');
  const [maxTokens, setMaxTokens] = useState('64');
  const [temperature, setTemperature] = useState('1');
  const [topK, setTopK] = useState('50');
  const [apiKey, setApiKeyInput] = useState('');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const copyTimerRef = useRef<number | null>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const atlasHandleRef = useRef<LiveAtlasHandle | null>(null);
  const active = Boolean(ACTIVE_GENERATION_STATES[snapshot.state]);
  const ready = snapshot.health.ready;
  const healthLoading = snapshot.health.status === 'loading';
  const healthPending = healthLoading || snapshot.health.status === 'checking';
  const healthTone = ready
    ? 'positive'
    : healthLoading
      ? 'warning'
      : snapshot.health.status === 'error'
        ? 'negative'
        : 'neutral';
  const healthLabel = ready
    ? 'Model online'
    : healthLoading
      ? 'Model loading'
      : snapshot.health.status === 'checking'
        ? 'Checking model'
        : 'Model offline';
  const settingsHaveErrors = Boolean(
    snapshot.validationErrors.maxTokens ||
    snapshot.validationErrors.temperature ||
    snapshot.validationErrors.topK,
  );
  const canClear = Boolean(
    prompt ||
    snapshot.text ||
    snapshot.error ||
    Object.keys(snapshot.validationErrors).length ||
    snapshot.state !== 'idle',
  );
  const outputCharacters = useMemo(
    () => [...snapshot.text].length,
    [snapshot.text],
  );

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null)
        window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (settingsHaveErrors && settingsRef.current)
      settingsRef.current.open = true;
  }, [settingsHaveErrors]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active || !ready) return;
    setApiKey(apiKey);
    await submit(
      { prompt, maxTokens, temperature, topK },
      {
        onGenerate: () => {
          try {
            atlasHandleRef.current?.ensureConnected();
          } catch {
            // Stream failure never prevents HTTP generation.
          }
        },
      },
    );
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

  function handleHealthRetry() {
    setApiKey(apiKey);
    void retryHealth();
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
          <Status aria-live="polite" pulse={healthPending} tone={healthTone}>
            {healthLabel}
          </Status>
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
        <section aria-labelledby="page-title" className="hero">
          <div>
            <p className="kicker">
              Local inference · sparse neural architecture
            </p>
            <h1 id="page-title">
              Write into the <em>circuit.</em>
            </h1>
            <p className="hero__lede">
              A focused prompt laboratory for a language model shaped by the
              architecture of the fruit fly brain. Prompts stay on this machine.
            </p>
          </div>
          <a className="atlas-link" href="#neural-atlas">
            Explore neural atlas <ArrowIcon />
          </a>
        </section>

        <div className="workspace">
          <Panel
            className="composer"
            eyebrow="01 / Stimulus"
            title="Compose a prompt"
          >
            <form noValidate onSubmit={(event) => void handleSubmit(event)}>
              <Field
                error={snapshot.validationErrors.prompt}
                htmlFor="prompt"
                hint="Ctrl or Cmd + Enter also starts generation."
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

              <div
                aria-labelledby="prompt-starters-label"
                className="prompt-starters"
                role="group"
              >
                <span id="prompt-starters-label">Try a starting signal</span>
                {PROMPT_STARTERS.map((starter, index) => (
                  <button
                    aria-label={`Use prompt starter ${index + 1}: ${starter}`}
                    disabled={Boolean(prompt)}
                    key={starter}
                    onClick={() => setPrompt(starter)}
                    title={starter}
                    type="button"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </button>
                ))}
              </div>

              <details className="settings" ref={settingsRef}>
                <summary>
                  <span>
                    <SlidersIcon /> Generation settings
                  </span>
                  <span className="settings__summary">
                    {settingsHaveErrors
                      ? 'Check settings'
                      : `${maxTokens} tokens · T ${temperature}`}
                  </span>
                </summary>
                <div className="settings__grid">
                  <Field
                    error={snapshot.validationErrors.maxTokens}
                    htmlFor="max-tokens"
                    hint="1–128"
                    label="Max tokens"
                  >
                    <Input
                      id="max-tokens"
                      max="128"
                      min="1"
                      onChange={(event) => setMaxTokens(event.target.value)}
                      type="number"
                      value={maxTokens}
                    />
                  </Field>
                  <Field
                    error={snapshot.validationErrors.temperature}
                    htmlFor="temperature"
                    hint="0–2"
                    label="Temperature"
                  >
                    <Input
                      id="temperature"
                      max="2"
                      min="0"
                      onChange={(event) => setTemperature(event.target.value)}
                      step="0.1"
                      type="number"
                      value={temperature}
                    />
                  </Field>
                  <Field
                    error={snapshot.validationErrors.topK}
                    htmlFor="top-k"
                    hint="1–50,257"
                    label="Top K"
                  >
                    <Input
                      id="top-k"
                      max="50257"
                      min="1"
                      onChange={(event) => setTopK(event.target.value)}
                      type="number"
                      value={topK}
                    />
                  </Field>
                  <Field
                    htmlFor="api-key"
                    hint="Optional; held in memory only."
                    label="API key"
                  >
                    <Input
                      autoComplete="off"
                      id="api-key"
                      onChange={(event) => {
                        setApiKeyInput(event.target.value);
                        setApiKey(event.target.value);
                      }}
                      placeholder="Bearer token"
                      type="password"
                      value={apiKey}
                    />
                  </Field>
                </div>
              </details>

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

          <Panel
            className="response"
            eyebrow="02 / Response"
            title="Model output"
          >
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

            <div aria-busy={active} className="response__body">
              {snapshot.text ? (
                <pre>{snapshot.text}</pre>
              ) : (
                <div className="empty-response">
                  <div aria-hidden="true" className="empty-response__signal">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <p>Output will assemble here as the model streams.</p>
                  <small>
                    No prompt or response is stored by this interface.
                  </small>
                </div>
              )}
            </div>

            <dl className="run-metrics">
              <div>
                <dt>Characters</dt>
                <dd>{outputCharacters.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>{snapshot.usage?.completion_tokens ?? '—'}</dd>
              </div>
              <div>
                <dt>Finish</dt>
                <dd>{snapshot.finishReason ?? '—'}</dd>
              </div>
            </dl>
          </Panel>
        </div>

        <AtlasWorkspace ref={atlasHandleRef} />
        <section aria-labelledby="service-heading" className="service-strip">
          <div>
            <p className="kicker">Service</p>
            <h2 id="service-heading">
              {snapshot.health.modelId ?? 'Local model'}
            </h2>
          </div>
          <p>{snapshot.health.message}</p>
          {!ready && (
            <Button onClick={handleHealthRetry} size="compact">
              Retry connection
            </Button>
          )}
        </section>
      </main>

      <footer>
        <span>FlyBrainLM / Prompt laboratory</span>
        <span>Local by design · no conversation history</span>
      </footer>
    </>
  );
}
