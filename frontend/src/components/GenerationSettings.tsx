import { useEffect, useRef, type MouseEvent } from 'react';
import type { ValidationErrors } from '../../../harness/app/inference-contract/v1/types.js';
import { Button, Field, Input } from './ui';
import './GenerationSettings.css';

export interface GenerationSettingsProps {
  apiKey: string;
  isOpen: boolean;
  maxTokens: string;
  onApiKeyChange: (value: string) => void;
  onClose: () => void;
  onMaxTokensChange: (value: string) => void;
  onTemperatureChange: (value: string) => void;
  onTopKChange: (value: string) => void;
  temperature: string;
  topK: string;
  validationErrors: ValidationErrors;
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 20 20">
      <path d="m5 5 10 10m0-10L5 15" />
    </svg>
  );
}

export function GenerationSettings({
  apiKey,
  isOpen,
  maxTokens,
  onApiKeyChange,
  onClose,
  onMaxTokensChange,
  onTemperatureChange,
  onTopKChange,
  temperature,
  topK,
  validationErrors,
}: GenerationSettingsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const maxTokensInputRef = useRef<HTMLInputElement>(null);
  const temperatureInputRef = useRef<HTMLInputElement>(null);
  const topKInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
      if (validationErrors.maxTokens) {
        maxTokensInputRef.current?.focus();
      } else if (validationErrors.temperature) {
        temperatureInputRef.current?.focus();
      } else if (validationErrors.topK) {
        topKInputRef.current?.focus();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [
    isOpen,
    validationErrors.maxTokens,
    validationErrors.temperature,
    validationErrors.topK,
  ]);

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== dialogRef.current) return;
    const rect = dialogRef.current.getBoundingClientRect();
    const isInside =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!isInside) {
      onClose();
    }
  }

  return (
    <dialog
      aria-labelledby="generation-settings-title"
      className="generation-settings"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={handleBackdropClick}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        if (
          event.shiftKey &&
          document.activeElement === closeButtonRef.current
        ) {
          event.preventDefault();
          doneButtonRef.current?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === doneButtonRef.current
        ) {
          event.preventDefault();
          closeButtonRef.current?.focus();
        }
      }}
      ref={dialogRef}
    >
      <div className="generation-settings__card">
        <div className="generation-settings__header">
          <div>
            <p className="kicker">01 / Configuration</p>
            <h2
              className="generation-settings__title"
              id="generation-settings-title"
            >
              Generation settings
            </h2>
          </div>
          <Button
            aria-label="Close generation settings"
            className="icon-button"
            onClick={onClose}
            ref={closeButtonRef}
            size="compact"
            type="button"
            variant="quiet"
          >
            <CloseIcon />
          </Button>
        </div>

        <div className="generation-settings__grid">
          <Field
            error={validationErrors.maxTokens}
            hint="1–128"
            htmlFor="max-tokens"
            label="Max tokens"
          >
            <Input
              id="max-tokens"
              max="128"
              min="1"
              onChange={(event) => onMaxTokensChange(event.target.value)}
              ref={maxTokensInputRef}
              type="number"
              value={maxTokens}
            />
          </Field>

          <Field
            error={validationErrors.temperature}
            hint="0–2"
            htmlFor="temperature"
            label="Temperature"
          >
            <Input
              id="temperature"
              max="2"
              min="0"
              onChange={(event) => onTemperatureChange(event.target.value)}
              ref={temperatureInputRef}
              step="0.1"
              type="number"
              value={temperature}
            />
          </Field>

          <Field
            error={validationErrors.topK}
            hint="1–50,257"
            htmlFor="top-k"
            label="Top K"
          >
            <Input
              id="top-k"
              max="50257"
              min="1"
              onChange={(event) => onTopKChange(event.target.value)}
              ref={topKInputRef}
              type="number"
              value={topK}
            />
          </Field>

          <Field
            hint="Optional; held in memory only."
            htmlFor="api-key"
            label="API key"
          >
            <Input
              autoComplete="off"
              id="api-key"
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder="Bearer token"
              type="password"
              value={apiKey}
            />
          </Field>
        </div>

        <div className="generation-settings__footer">
          <Button
            onClick={onClose}
            ref={doneButtonRef}
            size="compact"
            type="button"
            variant="primary"
          >
            Done
          </Button>
        </div>
      </div>
    </dialog>
  );
}
