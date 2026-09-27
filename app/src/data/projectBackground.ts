import { useCallback, useEffect, useState } from 'react';
import { loadProjectBackground, type ProjectBackgroundImage } from './projectMeta';

/**
 * The picture stored against one project, as a rendered page needs it.
 *
 * `idle` is three different situations that a reader does not need told apart —
 * no project, no registry row for it, and a project with no picture — because in
 * all three the answer is "draw nothing" and none of them is a fault. `error` is
 * the fourth, and it IS a fault: the row said there is a picture and the bytes
 * did not arrive, which is a difference the header can state (see the note on
 * `hasBackground` below) rather than pass off as a project with no picture.
 */
export type ProjectBackgroundState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; image: ProjectBackgroundImage }
  | { status: 'error'; message: string };

/**
 * Reads a project's background image, once per project.
 *
 * ★ THE FETCH IS GATED ON `hasBackground`, AND THE GATE IS THE REGISTRY'S CLAIM
 * RATHER THAN A GUESS. A project with no picture would otherwise cost a 404 on
 * every page load to learn what the list already said — and a 404 is a thing the
 * page then has to decide not to report, which is how a real failure gets
 * swallowed. Asking only when a picture is recorded means every rejection below
 * is genuine.
 *
 * ★ `expected` IS IN THE DEPENDENCY LIST ON PURPOSE. Storing a picture changes
 * `hasBackground` from false to true, and the page reloads the registry to learn
 * that; without `expected` here the effect would not re-run and the picture the
 * reader just chose would not appear until a manual reload. Showing a stale
 * header after a successful upload is the exact bug this line prevents.
 */
export function useProjectBackground(slug: string | null, expected: boolean): {
  state: ProjectBackgroundState;
  reload: () => void;
} {
  const [state, setState] = useState<ProjectBackgroundState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!slug || !expected) {
      setState({ status: 'idle' });
      return;
    }

    const controller = new AbortController();
    let live = true;
    setState({ status: 'loading' });

    loadProjectBackground(slug, controller.signal)
      .then((image) => {
        if (live) setState({ status: 'ready', image });
      })
      .catch((err: unknown) => {
        // ★ An abort is this effect being cleaned up, not a failure to report:
        // navigating away from a project must not leave a claim on screen that
        // its picture could not be read.
        if (!live || controller.signal.aborted) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'The project picture could not be read.',
        });
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [slug, expected, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
