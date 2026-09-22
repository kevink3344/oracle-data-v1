import type { ReactNode } from 'react';

/**
 * What the app says when an extract cannot be read.
 *
 * The heading and the hint default to the purchase-order extract, which is what
 * every existing caller means, and the defaults are that message verbatim so
 * those callers are unchanged. The Checks page passes its own, because sending a
 * reader to `oracle/output.json` for a missing `checks.json` would be a wrong
 * instruction confidently given.
 */
interface Props {
  error: string;
  reload: () => void;
  heading?: string;
  hint?: ReactNode;
}

const DEFAULT_HINT = (
  <p>
    The app fetches <code>oracle/output.json</code> from the dev server. Run{' '}
    <code>npm run sync:extract</code> to copy it out of <code>data/oracle/</code>.
  </p>
);

export default function ErrorNotice({
  error,
  reload,
  heading = 'The extract could not be read.',
  hint = DEFAULT_HINT,
}: Props) {
  return (
    <div className="notice notice--err" role="alert">
      <div>
        <p>
          <strong>{heading}</strong> {error}
        </p>
        {hint}
        <p>
          <button type="button" className="btn btn--system btn--sm" onClick={reload}>
            Try again
          </button>
        </p>
      </div>
    </div>
  );
}
