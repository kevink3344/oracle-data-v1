# The Network view — interaction plan

**Status:** the view renders and is **not interactive enough to read**. This plan fixes that.
**Measured state, 2026-09-25:** 26 circles, 25 edges, **0 labels in the DOM**, `cursor: grab`,
26 nodes tabbable but with no visible focus target.

---

## 1. What is wrong, measured

The report is *"none of the nodes move or anything"*. That is accurate, and the measurement says
what is missing:

| Probe | Value | What it means |
|---|---|---|
| `.lin__dot` | 26 | The circles draw. |
| `.lin__netlabel` | **0** | **No label exists in the DOM.** The names are unreachable without hovering the exact circle. |
| `.lin__netlabel-group` | 0 | Same — nothing is hidden, nothing is shown. |
| `.lin__halo` | 2 | Hubs are flagged (2 vendors span >1 account). |
| `cursor` | `grab` | The only affordance says "pan", never "this is clickable". |
| `tabindex=0` | 26 | Tabbable — but with **no focus ring on the circle**, so keyboard focus is invisible. |

**So there are three separate failures, not one:**

1. **No labels.** A network of unlabelled dots is a picture, not a chart. The reference images
   work because their nodes are *decorative*; ours carry names a reader needs.
2. **No discoverable affordance.** Hover reveals a label, but nothing indicates that. A reader
   who does not happen to hover learns nothing.
3. **No feedback on interaction.** Clicking selects a node, but the selection is a 3px ring — easy
   to miss, and it does not say *what* was selected or what it connects to.

---

## 2. The design principle

**A network view is a map, and a map tells you where you are and what is around you.**

The reference image is a *poster* — it shows a shape and nothing else. Ours has to answer
questions, so every interaction must do one of three things:

- **Orient** — where am I, what am I looking at?
- **Identify** — what is this node?
- **Relate** — what is this node connected to?

Any interaction that does none of those is decoration and should be cut.

---

## 3. The plan, in priority order

### P1 — Labels that are always readable (the biggest gap)

**Problem:** 0 labels in the DOM. The names are the data.

**Fix — three tiers, so the graph is legible without becoming a wall of text:**

| Tier | Which nodes | Behaviour |
|---|---|---|
| **Always labelled** | project, accounts, hubs | These are the skeleton. A reader must see them without doing anything. |
| **Labelled on hover/focus** | vendors, invoices, checks | Revealed individually — the reference image's "shape first, names on demand". |
| **Labelled when filtered** | any node matching a search | So a search result is visible without hunting. |

★ **The always-on tier is what makes the view readable at rest.** Right now a reader sees 26
identical dots; with the skeleton labelled they see *"Athens Drive → 526, 527, 529, 532"* and the
dots become structure.

★ **Label collision is the risk, and it is measurable.** With 4 accounts + 2 hubs labelled, check
that no two labels overlap: compare their bounding boxes. If they do, the cluster separation needs
raising rather than the labels hiding.

### P2 — A visible affordance and a focus ring

**Problem:** nothing says the circles are interactive, and keyboard focus is invisible.

**Fix:**
- `cursor: pointer` on the circle (the SVG currently says `grab` everywhere).
- A **focus ring on the circle**, not the `<g>` — the `<g>` has `tabindex` but no box, so
  `:focus-visible` on it draws nothing. Same defect the card version already recorded.
- A one-line hint in the canvas bar: *"click a node to see what it connects to"*. Cheap, and it
  converts a hidden feature into a discoverable one.

### P3 — Selection that shows relationships (the "relate" step)

**Problem:** selecting a node highlights it and nothing else. The question a reader has is
*"what is this connected to?"* — and the graph already knows.

**Fix — on select, dim everything not adjacent:**

```
selected node      → full colour, ring
its neighbours     → full colour
its edges          → full colour, thicker
everything else    → opacity 0.15
```

★ **This is the single highest-value interaction**, because it answers the Network's own question
in one click. It is also cheap: the adjacency is already in `edges`.

★ **It must be reversible** — clicking the background or pressing Escape clears it. A dimmed graph
with no way back is a trap.

### P4 — Hover that follows the pointer

**Problem:** hover reveals a label, but only after the pointer is already on a 9px circle.

**Fix:** a **tooltip that follows the cursor** showing label, kind, amount and degree. This is
standard for a node-link diagram and it removes the need to hit a small target precisely.

★ Keep the in-place label too (P1) — the tooltip is for precision, the label for scanning.

### P5 — Optional: drag a node

**Problem:** the layout is frozen after 400 ticks. A reader who wants to untangle a cluster cannot.

**Fix:** allow dragging a node, with `fx`/`fy` pinned while dragged and **released on drop** so the
layout re-settles. This is the one feature where React Flow would genuinely help — and it is also
~30 lines with `d3-force`, because the simulation is already there.

★ **Recommendation: defer this.** It is the most expensive item and the least valuable. The
skeleton labels (P1) plus selection dimming (P3) answer the reader's questions; dragging is for
tuning a picture. Ship P1–P4, then decide.

---

## 4. On React Flow (asked directly)

**Recommendation: do not use it for this view.** The reasoning, stated so it can be overruled:

| | React Flow | What this view needs |
|---|---|---|
| **Its purpose** | A node-graph **editor** — drag to connect, `Handle`s, edge routing | A **read-only** diagram |
| **Layout** | **None.** It renders positions you supply | `d3-force` computes them (already in place) |
| **Rendering** | HTML/SVG nodes in its own container, own stylesheet, own provider | The app's SVG + tokens |
| **The one feature it adds** | Interactive editing (P5) | Deferred as the least valuable item |

★ **It would not replace `d3-force`** — it would sit *on top of* it, adding a dependency, a
stylesheet and a context provider to draw circles and lines that are already drawn.

★ **The honest counter-argument:** if P5 (dragging) becomes a hard requirement, React Flow's drag
handling is better tested than a hand-rolled version. That is a real trade, and it is why P5 is
listed separately rather than dismissed.

---

## 5. What "done" looks like

Measured, not eyeballed:

- [ ] `document.querySelectorAll('.lin__netlabel').length >= 6` at rest (project + 4 accounts + hubs)
- [ ] No two always-on labels overlap (bounding-box comparison)
- [ ] `getComputedStyle(dot).cursor === 'pointer'`
- [ ] A focused node has a visible ring (`:focus-visible` on the circle, not the `<g>`)
- [ ] Selecting a node dims exactly the non-adjacent nodes: `dimmed === total - 1 - degree`
- [ ] Escape clears the selection
- [ ] The hover tooltip renders the label, kind, amount and degree

---

## 6. Order of work

1. **P1 labels** — the view becomes readable at rest. Biggest gain, no new dependency.
2. **P3 selection dimming** — answers "what is this connected to". Uses data already present.
3. **P2 affordance + focus ring** — makes P1 and P3 discoverable.
4. **P4 tooltip** — precision on top of scanning.
5. **P5 drag** — only if wanted after the above.
