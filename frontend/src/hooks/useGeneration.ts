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
import { createVibe2Runtime } from '../../../harness/app/vibe2/runtime.js';
import type { Vibe2RuntimeStatus } from '../../../harness/app/vibe2/runtime.js';

export function useGeneration() {
  const [runtime] = useState(() =>
    createVibe2Runtime({
      baseUrl:
  import.meta.env.VITE_MODEL_BASE_URL ||
  `${import.meta.env.BASE_URL}models/vibe2-tinystories/`,
    }),
  );
  const [controller] = useState(
    () => new GenerationController({ fetch: runtime.fetch }),
  );
  const [runtimeStatus, setRuntimeStatus] = useState<Vibe2RuntimeStatus>(
    () => runtime.status,
  );
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
    const unsubscribeStatus = runtime.subscribeStatus((status) => {
      setRuntimeStatus(status);
      void controller.checkHealth();
    });
    void controller.checkHealth();
    return () => {
      subscribed = false;
      unsubscribe();
      unsubscribeStatus();
      // React refresh and development remounts preserve hook state. Delay final
      // disposal so an immediate remount can retain this controller safely.
      disposeTimer.current = window.setTimeout(() => {
        controller.dispose();
        runtime.dispose();
      }, 0);
    };
  }, [controller, runtime]);

  const submit = useCallback(
    (
      input: GenerationInput,
      options?: GenerationSubmitOptions,
    ): Promise<GenerationResult> => controller.submit(input, options),
    [controller],
  );
  const cancel = useCallback(() => controller.cancel(), [controller]);
  const clear = useCallback(() => controller.clear(), [controller]);

  return {
    cancel,
    clear,
    retryLoad: runtime.retry,
    runtime,
    runtimeStatus,
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
