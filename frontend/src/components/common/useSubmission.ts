import { useCallback, useRef, useState } from 'react';
import { ApiError, errorMessage, fieldErrors, newIdempotencyKey } from '../../lib/api/apiClient';

/**
 * State for a money-changing form submission.
 *
 * - Ignores a second submit while one is in flight (double-click protection).
 * - Sends one idempotency key per distinct attempt. If the outcome is unknown
 *   (network drop, server error) the key is kept, so pressing the button again
 *   replays the same operation instead of creating a second one. A definite
 *   rejection, or the user editing the form, starts a fresh key.
 */
export function useSubmission(scope: string) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = useRef(newIdempotencyKey(scope));
  const inFlight = useRef(false);

  /** Call whenever the user changes an input. */
  const touched = useCallback(() => {
    key.current = newIdempotencyKey(scope);
    setError(null);
  }, [scope]);

  const run = useCallback(
    async <T,>(operation: (idempotencyKey: string) => Promise<T>, fallback: string): Promise<T | undefined> => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setSubmitting(true);
      setError(null);
      setErrors({});
      try {
        const result = await operation(key.current);
        key.current = newIdempotencyKey(scope);
        return result;
      } catch (err) {
        setErrors(fieldErrors(err));
        setError(errorMessage(err, fallback));
        if (!(err instanceof ApiError && err.retryable)) key.current = newIdempotencyKey(scope);
        return undefined;
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [scope]
  );

  return { submitting, error, errors, setErrors, touched, run };
}
