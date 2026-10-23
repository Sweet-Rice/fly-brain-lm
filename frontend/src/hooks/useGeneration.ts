import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GenerationController,
  GENERATION_STATES,
} from '../../../harness/app/generation.js';
import type {
  GenerationClientSnapshot,
  GenerationInput,
  GenerationResult,
  GenerationSubmitOptions,
} from '../../../harness/app/inference-contract/v1/types.js';

export function useGeneration() {
  const [controller] = useState(() => new GenerationController());
  const disposeTimer = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<GenerationClientSnapshot>(() =>
    controller.getState(),
  );

  useEffect(() => {
    if (disposeTimer.current !== null) {
      window.clearTimeout(disposeTimer.current);
      disposeTimer.current = null;
    }
    let subscribed = true;
    const unsubscribe = controller.subscribe(setSnapshot);
    queueMicrotask(() => {
      if (subscribed) setSnapshot(controller.getState());
    });
    controller.startHealthPolling();
    return () => {
      subscribed = false;
      unsubscribe();
      controller.stopHealthPolling();
      // React refresh and development remounts preserve hook state. Delay final
      // disposal so an immediate remount can retain this controller safely.
      disposeTimer.current = window.setTimeout(() => controller.dispose(), 0);
    };
  }, [controller]);

  const submit = useCallback(
    (
      input: GenerationInput,
      options?: GenerationSubmitOptions,
    ): Promise<GenerationResult> => controller.submit(input, options),
    [controller],
  );
  const cancel = useCallback(() => controller.cancel(), [controller]);
  const clear = useCallback(() => controller.clear(), [controller]);
  const retryHealth = useCallback(() => controller.checkHealth(), [controller]);
  const setApiKey = useCallback(
    (key: string) => controller.setApiKey(key),
    [controller],
  );

  return {
    cancel,
    clear,
    retryHealth,
    setApiKey,
    snapshot,
    submit,
  };
}

export const ACTIVE_GENERATION_STATES: Record<string, true> = {
  [GENERATION_STATES.VALIDATING]: true,
  [GENERATION_STATES.SUBMITTING]: true,
  [GENERATION_STATES.STREAMING]: true,
  [GENERATION_STATES.CANCELLING]: true,
};
