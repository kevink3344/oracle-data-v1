import { Link, useLocation } from 'react-router-dom';
import { ALL_LEAVES, blockFor } from '../nav/menu';

/**
 * A screen that has not been built yet — and says so, in full.
 *
 * This exists because of the failure mode it replaces. Before the menu tree, the
 * rail listed eight greyed-out placeholders and the router listed five paths, so
 * a leaf and its URL had no way to check on each other. The rail now names 27
 * destinations, nearly all of them real URLs pointing at nothing, and a `NavLink`
 * into an unrouted path falls through to `path="*"` and lands back on the
 * Dashboard — arriving somewhere with no explanation, which reads as "the click
 * did nothing".
 *
 * §8 of `menu-groups.md` offers three ways to handle a leaf with no screen, and
 * rules out exactly one:
 *
 *   1. **Render it with an empty state that names the reason.** ← this file
 *   2. Render it disabled in the rail, greyed, with a `title`.
 *   3. Hide it. *"Only option 3 is wrong, and only because it hides a real gap
 *      rather than framing it."*
 *
 * Option 2 is what the old rail did, and it has a cost worth naming: a disabled
 * row is invisible to a search engine, invisible to a keyboard user's Tab order
 * in the usual sense, and impossible to link to. A colleague cannot be sent "the
 * encumbrances screen" if the encumbrances screen is a `<span>`. So this takes
 * option 1 — the recommended one — and the reason travels with it.
 *
 * `nav/menu.ts` is read back here rather than a prop being passed down, so the
 * page cannot describe a leaf differently from how the rail labels it.
 */
export default function Pending() {
  const { pathname } = useLocation();
  const leaf = ALL_LEAVES.find((l) => l.to === pathname) ?? null;
  const block = leaf ? blockFor(leaf.to) : undefined;

  if (!leaf) {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          <div className="page-head">
            <div>
              <h1>Not found</h1>
              <p className="page-head__sub">
                Nothing is registered at <code>{pathname}</code>. Every destination in the menu has a
                page; this one is not in the menu.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const siblings = (block?.leaves ?? []).filter((l) => l.to !== leaf.to);

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>{leaf.label}</h1>
            <p className="page-head__sub">
              {block ? `${block.title} · ` : ''}
              This screen is specified but not built yet. It is in the menu so the gap is visible,
              and it is a real page so it can be linked to and named rather than silently skipped.
            </p>
          </div>
          <div className="page-head__actions">
            <Link className="btn btn--ghost" to="/">
              Dashboard
            </Link>
          </div>
        </div>
      </div>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Why there is nothing here</h2>
            <p className="panel__sub">
              A leaf in the menu is a question; this one is unanswered for a specific reason.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <p>{leaf.note}</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">What it is meant to read</h2>
            <p className="panel__sub">
              Recorded once, in the menu definition, so the rail, this page and the API cannot
              drift apart on what a leaf is for.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <p>
            <strong>Reads</strong> — <code>{leaf.reads}</code>
          </p>
          {leaf.api ? (
            <p>
              <strong>Already served by</strong> — <code>GET {leaf.api}</code>, which is both the
              Express route and the documented OpenAPI path.
            </p>
          ) : null}
          {leaf.derived ? (
            <p>
              <strong>Computed, not extracted</strong> — this leaf is arithmetic over other figures
              rather than a column in the extract, and the screen has to say so, because every other
              number in this app is read out of the database as-is.
            </p>
          ) : null}
          <p>
            <strong>From the plan</strong> — <code>docs/plans/menu-groups.md</code> {leaf.plan}
          </p>
        </div>
      </section>

      {siblings.length > 0 ? (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">Elsewhere in {block?.title}</h2>
              <p className="panel__sub">
                The rest of the block, whether or not it is built — the ones that are open.
              </p>
            </div>
          </div>
          <div className="panel__body">
            <p>
              {siblings.map((s, i) => (
                <span key={s.to}>
                  {i > 0 ? ' · ' : ''}
                  <Link to={s.to}>{s.label}</Link>
                  {s.built ? null : ' (not built)'}
                </span>
              ))}
            </p>
          </div>
        </section>
      ) : null}
    </div>
  );
}
