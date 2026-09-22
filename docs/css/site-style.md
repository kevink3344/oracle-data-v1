# WCPSS Site Style Reference

Extracted design language from **https://www.wcpss.net/** (Wake County Public School System, NC).

This document is a **portable style guide**, not a copy of the site's stylesheets. The source CSS is a
minified Finalsite "Composer" theme bundle (~520 KB) plus a ~476 KB application bundle — most of it is
CMS chrome that has no value for an internal reporting app. What follows is the *design system* that
theme implements: tokens, type scale, layout grid, and component patterns, rewritten as clean,
dependency-free CSS you can paste into a new application.

> **Provenance**
> - Homepage HTML: `https://www.wcpss.net/`
> - Theme CSS: `https://www.wcpss.net/uploaded/themes/default_25/main.css`
> - App CSS: `https://www.wcpss.net/assets/application-<hash>.css`
> - Tokens live in an inline `<style id="fsHSLColors">` block in the page `<head>`
> - Captured: 2026-09-15
> - Values below were read from the stylesheets **and** confirmed via `getComputedStyle` on the live page.

> **Project overrides**
> This document is mostly source truth with a few deliberate local deviations. Where this application
> diverges from wcpss.net, the deviation is marked with a **Project override** callout so the two are
> never confused. Current overrides:
> - **Border radius → `3px`** on every rectangular surface (source uses `4px` on buttons, and `0` on
>   cards). See §4.1.
> - **Accessible button labels** for the brand colors that fail WCAG AA. See §6.5.
> - **Neutral page titles** instead of the source's orange `h1`. See §11.

---

## 1. Design Tokens

The site is built on a **named-slot color system**. Rather than semantic names (`--color-danger`),
Finalsite themes expose generic slots (`primary`, `secondary`, `tertiary`, `cc-fourth` … `cc-eighth`)
that the district fills with brand colors. Each color also exposes **H / S / L channels** so any rule
can build tints and transparent variants without a preprocessor.

### 1.1 The token block (verbatim from the page `<head>`)

```css
:root {
  /* Primary — WCPSS navy */
  --primary-color-h: 205.79;
  --primary-color-s: 72.15%;
  --primary-color-l: 30.98%;
  --primary-color-hsl: var(--primary-color-h), var(--primary-color-s), var(--primary-color-l);
  --primary-color: #165788;

  /* Secondary — accent orange */
  --secondary-color-h: 24.92;
  --secondary-color-s: 77.69%;
  --secondary-color-l: 49.22%;
  --secondary-color-hsl: var(--secondary-color-h), var(--secondary-color-s), var(--secondary-color-l);
  --secondary-color: #df6d1c;

  /* Tertiary — sky blue */
  --tertiary-color-h: 190.1;
  --tertiary-color-s: 100.00%;
  --tertiary-color-l: 40.78%;
  --tertiary-color-hsl: var(--tertiary-color-h), var(--tertiary-color-s), var(--tertiary-color-l);
  --tertiary-color: #00add0;

  /* Extended palette */
  --cc-fourth-color:  #fed100;  /* hsl 49.37 100% 49.80%  — yellow  */
  --cc-fifth-color:   #6e273d;  /* hsl 341.41 47.65% 29.22% — maroon */
  --cc-sixth-color:   #BED600;  /* hsl 66.73 100% 41.96%   — lime   */
  --cc-seventh-color: #c90062;  /* hsl 330.75 100% 39.41%  — pink   */
  --cc-eighth-color:  #455560;  /* hsl 204.44 16.36% 32.35% — slate */

  /* Type */
  --main-font:   'Open Sans';
  --accent-font: 'Solway';
}
```

### 1.2 Palette

| Token | Hex | Role in the brand |
|---|---|---|
| `--primary-color` | ![#165788](https://placehold.co/12x12/165788/165788.png) `#165788` | Primary brand navy — buttons, links, solid cards |
| `--secondary-color` | ![#df6d1c](https://placehold.co/12x12/df6d1c/df6d1c.png) `#df6d1c` | Accent orange — **all `h1` headings**, highlights |
| `--tertiary-color` | ![#00add0](https://placehold.co/12x12/00add0/00add0.png) `#00add0` | Sky blue — info / secondary actions |
| `--cc-fourth-color` | ![#fed100](https://placehold.co/12x12/fed100/fed100.png) `#fed100` | Yellow — attention / callouts |
| `--cc-fifth-color` | ![#6e273d](https://placehold.co/12x12/6e273d/6e273d.png) `#6e273d` | Maroon — deep accent |
| `--cc-sixth-color` | ![#BED600](https://placehold.co/12x12/BED600/BED600.png) `#BED600` | Lime — success / positive |
| `--cc-seventh-color` | ![#c90062](https://placehold.co/12x12/c90062/c90062.png) `#c90062` | Pink — emphasis / alerts |
| `--cc-eighth-color` | ![#455560](https://placehold.co/12x12/455560/455560.png) `#455560` | Slate — neutral dark |

**Neutral ramp** (by frequency of use in the source CSS):

| Hex | Role |
|---|---|
| `#ffffff` / `#fff` | Surface, card backgrounds, outline-button fill |
| `#fafafa` | Subtle surface |
| `#f5f5f5` | Default `button-system` fill, faint borders |
| `#e5e5e5` | `button-light` fill, hover fill for `system`, dividers |
| `#d4d4d4` | `button-light` hover, muted borders, inactive fills |
| `#a3a3a3` | Disabled text / icon |
| `#727272` | `button-light` hover border, muted text |
| `#525252` | **Body copy default**, `button-dark` hover |
| `#404040` | Secondary dark text |
| `#262626` | `button-dark` fill, **default heading color**, card base text |
| `#171717` | Strongest text, empty-state text |
| `#000000` | Rare hard black |

> **Key observation:** body copy is `#525252` (mid grey), while *paragraphs inside content regions*
> compute to `#262626`. Headings are `#262626` — **except every `h1`, which is the accent orange
> `--secondary-color` (`#df6d1c`)**. That orange-heading rule is the single most distinctive thing
> about this look.

### 1.3 Auto-contrast text color (worth knowing)

The button system derives its label color from the background using **CSS relative color syntax**:

```css
color: hsl(from var(--primary-color) 0 0 round(abs(l - 100), 100));
```

`round(abs(l - 100), 100)` collapses the lightness to either `0` or `100`, so the expression resolves
to **pure black or pure white**, whichever is furthest from the background:

| Background | Lightness | Resolved label |
|---|---|---|
| `#165788` primary | 30.98% | white |
| `#df6d1c` secondary | 49.22% | white |
| `#00add0` tertiary | 40.78% | white |
| `#455560` slate | 32.35% | white |
| `#262626` dark | 14.9% | white |
| `#f5f5f5` system | 96.08% | black |
| `#e5e5e5` light | 89.8% | black |
| `#ffffff` white | 100% | black |

⚠️ **Portability warning:** `hsl(from …)` is Chromium 119+ / Safari 16.4+ / Firefox 128+ only, and
Safari has had bugs with `round()` inside relative color syntax. The source CSS never falls back for it.
For a new app, **resolve these to literal `#fff` / `#262626`** as shown in §6.

⚠️ **Correctness warning:** this heuristic only reads **lightness** and flips at `L = 50%`, which is not
where the real white/dark contrast crossover sits. Measured against WCAG 2.x contrast ratios, it
**picks the wrong label for half the brand palette**:

| Background | L | Picks | White ratio | `#262626` ratio | Verdict |
|---|---|---|---|---|---|
| `#165788` primary | 30.98% | white | **7.63** | 1.98 | ✅ correct |
| `#df6d1c` secondary | 49.22% | white | **3.31** | 4.57 | ❌ **fails AA** — dark would pass |
| `#00add0` tertiary | 40.78% | white | **2.66** | 5.68 | ❌ **fails AA** — dark would pass |
| `#fed100` yellow | 49.80% | white | **1.47** | 10.33 | ❌ **fails badly** — dark would pass |
| `#6e273d` maroon | 29.22% | white | **10.39** | 1.46 | ✅ correct |
| `#BED600` lime | 41.96% | white | **1.64** | 9.23 | ❌ **fails badly** — dark would pass |
| `#c90062` pink | 39.41% | white | **5.74** | 2.64 | ✅ correct |
| `#455560` slate | 32.35% | white | **7.72** | 1.96 | ✅ correct |

Bold = the ratio the theme actually ships. Four of eight brand colors render sub-AA button labels on
wcpss.net today. **Do not port this function** — hard-code the label color per variant (§6.4).

### 1.4 Channel-based tints

Because `--*-color-hsl` exists, the theme builds translucent variants without extra tokens:

```css
box-shadow: 0 0 0 2px hsl(var(--tertiary-color-hsl), 0.3);  /* focus ring */
```

Reproduce in a new app with modern syntax:

```css
--primary-color-rgb: 22, 87, 136;   /* #165788 */
--primary-10: rgb(var(--primary-color-rgb) / 0.10);
--primary-30: rgb(var(--primary-color-rgb) / 0.30);
```

---

## 2. Typography

### 2.1 Font families

```css
--font-body:   'Open Sans', sans-serif;   /* 139+ rules — everything */
--font-accent: 'Solway', serif;           /* 4 rules — lead-in, blockquote, post titles */
```

Both load from Google Fonts. The site requests the **variable-width** axis for Open Sans:

```html
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wdth,wght@0,75..100,300..800;1,75..100,300..800&family=Solway:wght@300;400;700&display=swap" rel="stylesheet">
```

Two icon fonts are also loadable but are **not** worth porting — replace with inline SVG:
`IcoMoon` (`/uploaded/themes/default_25/fonts/icomoon.woff2`) and `bpa-font-icons`.

> Do **not** copy the `@font-face` blocks that reference local paths — they will 404 outside the CMS.

### 2.2 Type scale

Weight distribution in the source: `400` ×158, `700` ×83, `600` ×80. `letter-spacing` is essentially
always `0` (74 rules) — `.5px` appears only 10 times, on small uppercase labels.

#### Headings

All headings share: `margin-top: 0`, `font-weight: 700`, `color: #262626`, `font-family: 'Open Sans', sans-serif`.

| Element | Size | Line height | Margin bottom | Notes |
|---|---|---|---|---|
| `h1` | `2.5rem` / 40px | `3.25rem` / 52px | `48px` | **Color overridden to `--secondary-color` `#df6d1c`** |
| `h2` | `2rem` / 32px | `2.5rem` / 40px | `20px` | `font-weight: 600` |
| `h3` | `1.5rem` / 24px | `2.25rem` / 36px | `10px` | |
| `h4` | `1.25rem` / 20px | `1.75rem` / 28px | `10px` | |
| `h5` | `1.125rem` / 18px | `1.5rem` / 24px | `10px` | |
| `h6` | `1rem` / 16px | `1.5rem` / 24px | `10px` | |

`p + h1`, `p + h2` get `margin-top: 40px`. At the desktop breakpoint the `h1` scales to
`3rem` / `3.75rem` with `margin-bottom: 60px`.

**Verified computed values on the live page:** `h1` = 48px / 60px line-height / 700 / `rgb(223,109,28)`.

#### Body & text

| Role | Size | Line height | Weight | Color |
|---|---|---|---|---|
| `body` | `1.125rem` / 18px | `1.5555…` / 28px | 400 | `#525252` |
| Content paragraph | `1rem` / 16px | `1.5` / 24px | 400 | `#262626` |
| Lead-in | `1.375rem` / 22px | — | — | **Solway** |
| Blockquote | — | — | — | **Solway** |
| Breadcrumb | `.75rem` / 12px | `1.3333` | 400 | `#262626`, `text-transform: uppercase` |
| Buttons | see §6 | | | |

**Most-used `font-size` values across the whole stylesheet:**
`.875rem` (156) · `1rem` (90) · `1.125rem` (74) · `1.5rem` (15) · `16px` (14) · `.75rem` (14) · `1.25rem` (12).

**Most-used `line-height` ratios:** `1.5` (75) · `1.4286` (74) · `1.2143` (74) · `1.3333` (71) · `1` (50).

> The recurring `1.2142857143` / `1.4285714286` / `1.3333333333` ratios are px line-heights divided by
> px font-size (17/14, 20/14, 24/18). Prefer a unitless ratio or a rem value in a new app.

---

## 3. Layout

### 3.1 Content width

The theme's only wrapper is **1180px**, centred — used by `#fsPageBody`, `.compartment`,
`.fsBreadcrumb nav`, and the footer banner:

```css
.compartment {
  position: relative;
  margin: 0 auto;
  max-width: 1180px;
}
```

Secondary widths found: `1200px` (media-query boundaries), `1020px`, `128px`.

```css
:root {
  --content-width: 1180px;
  --gutter: 40px;
}
```

### 3.2 Breakpoints

Breakpoints are **mobile-first `min-width`**, with a small set of `max-width` overrides. The five that
carry the site:

| Breakpoint | Uses | Role |
|---|---|---|
| `600px` | 129 | **Primary** — phone → tablet |
| `800px` | 45 (+4) | Tablet |
| `900px` | 19 | Tablet landscape |
| `1000px` | 21 | Small desktop |
| `1024px` | 50 | **Primary** — tablet → desktop |
| `1200px` | 5 (+10 max) | Large desktop cap |

```css
/* Recommended modern equivalent */
@media (min-width: 600px)  { /* sm  — phone landscape, 2-up grids */ }
@media (min-width: 800px)  { /* md  — tablet portrait        */ }
@media (min-width: 1024px) { /* lg  — tablet landscape / small desktop */ }
@media (min-width: 1200px) { /* xl  — desktop               */ }
```

Note the source uses `@media(min-width: 600px)` with **no space** after `@media` — a minifier artifact,
not intentional. Also seen: `@media(hover: hover)` (2 uses) for pointer-specific affordances.

### 3.3 Spacing

There is **no spacing scale variable** — values are hard-coded. The de-facto rhythm, by frequency:

**Padding (declarations ×N):** `11px 23px` ×76 · `15px 31px` ×58 · `15px 27px` ×56 · `25px 27px` ×56 ·
`20px` ×12 · `28px 28px 36px` ×9 · `0 20px` ×6 · `40px` ×5.

**Margin:** `0 0 10px` ×188 (the universal button bottom-margin) · `0` ×84 · `0 auto` ×17 · `0 0 20px` ×7 ·
`40px 0` ×6.

**Grid gap:** `20px` ×4 · `8px` ×3 · `12px` ×2.

```css
/* Derived 4px-based scale — safe, faithful to the observed rhythm */
:root {
  --space-1:  4px;
  --space-2:  8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  20px;
  --space-6:  24px;
  --space-8:  32px;
  --space-10: 40px;
  --space-15: 60px;
  --space-20: 80px;
}
```

---

## 4. Radii, Borders, Shadows

### 4.1 Border radius

#### What the source does

A single **4px** radius carries almost all of the chrome — 197 of 256 declarations. But it is applied
narrowly: **buttons and small chrome, not content containers.** `.card` has **no** `border-radius` at
all, and `.fsElementDialog` is explicitly `border-radius: 0`. Cards on the public site are
square-cornered.

| Value | Count | Applied to |
|---|---|---|
| `4px` | 197 | **Buttons** and most small chrome — the de-facto default |
| `50%` | 13 | Circular icon buttons, carousel arrows, pager dots |
| `8px` | 9 | Larger panels — nav flyouts (`.fsNavPageInfo`), quicklink tiles, Weglot lists |
| `100%` | 8 | Carousel arrows, close buttons |
| `3px` | 7 | Nav submenus, mobile search form, `.fsConstituentSearchForm` inputs, category/tag chips, CTA title |
| `0` | 7 | `.fsElementDialog`, header search input, tag filters, thumbnails |
| `40px` | 6 | Pill-shaped carousel arrows |
| one-offs | 9 | `3px 0 0 3px` ×2, `0 8px 8px 0`, `999px`, `20px`, `16px`, `6px`, `5px`, `2px` |

Note that **`3px` already exists in the source** as a secondary radius — nav submenus, the mobile
search form, constituent-search inputs, and post category/tag chips all use it. Promoting it
project-wide (below) reuses an existing source value rather than inventing one.

#### Project override — 3px on every rectangular surface

> ⚠️ **This application deliberately overrides the source.** The source's `4px` covers buttons but
> leaves cards square; this project standardises **`3px`** so controls and cards share one radius.

```css
--radius: 3px;
```

**Applies to:** buttons, cards, panels, inputs, selects, textareas, search fields, dropdowns and menus,
modals, drawers, tabs, tags/badges, toasts, alerts, code blocks, and table containers.

**Does not apply to shapes whose identity *is* the radius.** A blanket find/replace from `4px` to `3px`
is safe, but never let one touch `50%`, `100%` or `999px` — that turns a circle into a rounded square:

| Token | Value | Components |
|---|---|---|
| `--radius-circle` | `50%` | Avatars, circular icon buttons, pager dots, progress rings, spinners |
| `--radius-pill` | `999px` | Pills, toggle switches, fully-rounded status chips |
| `--radius-none` | `0` | Edge-to-edge media, full-bleed table wrappers, hairline dividers |

```css
:root {
  --radius:        3px;   /* every rectangular surface */
  --radius-sm:     3px;   /* kept for API symmetry */
  --radius-none:   0;
  --radius-pill:   999px;
  --radius-circle: 50%;
}

/* One rule keeps every rectangular surface consistent */
.btn, .card, .panel, .input, .select, .textarea, .search,
.dropdown, .modal, .drawer, .tab, .tag, .badge, .toast,
.alert, .code, .table-wrap {
  border-radius: var(--radius);
}

/* Shape tokens win where the shape matters */
.avatar, .icon-btn--round, .pager-dot { border-radius: var(--radius-circle); }
.pill, .switch, .chip--pill        { border-radius: var(--radius-pill); }
.figure--bleed > img              { border-radius: var(--radius-none); }
```

### 4.2 Borders

Border colors track the palette — the top border colors are `#f5f5f5` (26), `--primary-color` (25),
`--secondary-color` (22), `#d4d4d4` (21), `#e5e5e5` (21).

A signature pattern is the **4px colored top/left border** on cards:

```css
.card.top-border-secondary > .content {
  border-top: 4px solid var(--secondary-color);
  padding: 16px 0 0;
}
.card.border-primary > .content {
  border: 4px solid var(--primary-color);
  padding: 28px 28px 36px;
}
```

### 4.3 Shadows

| Value | Use |
|---|---|
| `0 4px 24px 0 rgba(0,0,0,.2)` | Modal / overlay |
| `0 4px 32px 0 rgba(0,0,0,.12)` | Elevated card |
| `0 4px 40px rgba(0,0,0,.06)` | Soft card |
| `0 4px 34px 0 rgba(0,0,0,.06)` | Soft card (alt) |
| `0 0 0 2px hsl(var(--tertiary-color-hsl), .3)` | **Focus ring** |
| `0 0 0 4px rgba(0,0,0,.25)` | Strong focus ring |

```css
--shadow-sm: 0 4px 24px rgba(0, 0, 0, .06);
--shadow-md: 0 4px 32px rgba(0, 0, 0, .12);
--shadow-lg: 0 4px 24px  rgba(0, 0, 0, .20);
```

---

## 5. Motion

A single house transition dominates: **`.4s all`** (560 of 716 declarations, 78%).

| Value | Count | Use |
|---|---|---|
| `.4s all` | 560 | Default for all interactive elements |
| `.3s` | 36 | Tabs, accordions |
| `.4s background` | 14 | Nav hover |
| `1s color` / `1s background` | 14 / 12 | Theme-color swap |
| `.4s opacity` | 6 | Fades |
| `.85s transform ease-out, .85s opacity ease-out` | 4 | Hero entrances |

```css
--transition: .4s all;
```

⚠️ **Accessibility:** the source has no `prefers-reduced-motion` guard. Add one in a new app:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 6. Buttons

The button system is **two orthogonal class axes**:

```html
<a class="button-size button-variant [hollow-button] [full-width-button]">Label</a>
```

- **Size:** `.small-button` | `.medium-button` | `.large-button`
- **Variant:** `.button-primary` `.button-secondary` `.button-blue` `.button-yellow` `.button-maroon`
  `.button-lime` `.button-pink` `.button-gray` `.button-white` `.button-light` `.button-dark` `.button-system`
- **Modifiers:** `.hollow-button` (outline) · `.full-width-button` (100% width)

### 6.1 Sizes

| Class | Padding | Font size | Weight | Line height |
|---|---|---|---|---|
| `.small-button` | `11px 23px` | `.875rem` / 14px | 400 | `1.2142857143` |
| `.medium-button` | `15px 31px` | `1rem` / 16px | 600 | `1.5` |
| `.large-button` | `25px 27px` | `1.125rem` / 18px | 700 | `1.3333333333` |

Shared by all: `display:inline-block` · `margin:0 0 10px` · `border:1px solid` · `text-align:center` ·
`text-decoration:none` · `border-radius:4px` · `cursor:pointer` · `transition:.4s all` ·
`font-family:'Open Sans',sans-serif`.

> The `border-radius:4px` is the source value. **In this project it resolves to `3px`** via the
> `--radius` token (§4.1). Keep the token, not the literal.

### 6.2 Variant → color mapping

Every variant maps to a palette slot; hover is a fixed literal, not a computed tint.

| Variant | Background | Hover |
|---|---|---|
| `.button-primary` | `--primary-color` `#165788` | `#266a9d` |
| `.button-secondary` | `--secondary-color` `#df6d1c` | `#f59049` |
| `.button-blue` | `--tertiary-color` `#00add0` | `#3ecce9` |
| `.button-yellow` | `--cc-fourth-color` `#fed100` | `#ffe56a` |
| `.button-maroon` | `--cc-fifth-color` `#6e273d` | `#994861` |
| `.button-lime` | `--cc-sixth-color` `#BED600` | `#ddf427` |
| `.button-pink` | `--cc-seventh-color` `#c90062` | `#ae0055` |
| `.button-gray` | `--cc-eighth-color` `#455560` | `#2a363e` |
| `.button-system` | `#f5f5f5` | `#e5e5e5` |
| `.button-light` | `#e5e5e5` | `#d4d4d4` |
| `.button-dark` | `#262626` | `#525252` |
| `.button-white` | `#fff` | `hsla(0,0%,100%,.75)` |

Label color is the auto-contrast value from §1.3 — **white on every variant except `system`, `light`
and `white`**. Per the table in §1.3, that means `.button-blue`, `.button-yellow` and `.button-lime`
ship labels that **fail WCAG AA** (2.66:1, 1.47:1 and 1.64:1). See §6.5 for the accessible variants.

### 6.3 Hollow (outline) variant

`.hollow-button` swaps the fill for white and keeps a **1px colored border**:

```css
.small-button.button-primary.hollow-button {
  border: 1px solid var(--primary-color);
  background: #fff;
  color: #262626;
}
/* on hover it fills */
.small-button.button-primary.hollow-button:hover,
.small-button.button-primary.hollow-button:focus {
  border-color: var(--primary-color);
  background: var(--primary-color);
  color: #fff;
}
```

### 6.4 Ported button CSS

```css
.btn {
  display: inline-block;
  margin: 0 0 var(--space-3);
  padding: 11px 23px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: #f5f5f5;
  color: #262626;
  font-family: var(--font-body);
  font-size: .875rem;
  font-weight: 400;
  line-height: 1.2142857143;
  letter-spacing: 0;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  transition: var(--transition);
}
.btn:hover, .btn:focus-visible { background: #e5e5e5; border-color: #e5e5e5; }

.btn--md { padding: 15px 31px; font-size: 1rem;   font-weight: 600; line-height: 1.5; }
.btn--lg { padding: 25px 27px; font-size: 1.125rem; font-weight: 700; line-height: 1.3333333333; }

.btn--primary   { background: #165788; border-color: #165788; color: #fff; }
.btn--primary:hover, .btn--primary:focus-visible { background: #266a9d; border-color: #266a9d; }

.btn--secondary { background: #df6d1c; border-color: #df6d1c; color: #fff; }
.btn--secondary:hover, .btn--secondary:focus-visible { background: #f59049; border-color: #f59049; }

.btn--blue      { background: #00add0; border-color: #00add0; color: #fff; }
.btn--blue:hover    { background: #3ecce9; border-color: #3ecce9; }

.btn--yellow    { background: #fed100; border-color: #fed100; color: #fff; }
.btn--yellow:hover  { background: #ffe56a; border-color: #ffe56a; }

.btn--maroon    { background: #6e273d; border-color: #6e273d; color: #fff; }
.btn--maroon:hover  { background: #994861; border-color: #994861; }

.btn--lime      { background: #BED600; border-color: #BED600; color: #fff; }
.btn--lime:hover    { background: #ddf427; border-color: #ddf427; }

.btn--pink      { background: #c90062; border-color: #c90062; color: #fff; }
.btn--pink:hover    { background: #ae0055; border-color: #ae0055; }

.btn--gray      { background: #455560; border-color: #455560; color: #fff; }
.btn--gray:hover    { background: #2a363e; border-color: #2a363e; }

.btn--dark      { background: #262626; border-color: #262626; color: #fff; }
.btn--dark:hover    { background: #525252; border-color: #525252; }

.btn--light     { background: #e5e5e5; border-color: #e5e5e5; color: #262626; }
.btn--light:hover   { background: #d4d4d4; border-color: #d4d4d4; }

.btn--white     { background: #fff; border-color: #fff; color: #262626; }
.btn--white:hover   { background: hsla(0, 0%, 100%, .75); border-color: hsla(0, 0%, 100%, .75); }

.btn--hollow    { background: #fff; }
.btn--block     { width: 100%; }

.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px #fff, 0 0 0 4px #00add0;
}
```

### 6.5 Accessible corrections

The styles above are **faithful to wcpss.net**, including its contrast failures. If this app must meet
WCAG AA (internal reporting tools usually must, and it is a legal requirement for public-sector work),
apply these two overrides — they change the label color only and leave the brand fills intact:

```css
/* Dark label on the light brand fills — 4.57:1 / 5.68:1 / 10.33:1 / 9.23:1 */
.btn--secondary,
.btn--blue,
.btn--yellow,
.btn--lime { color: #262626; }
```

Alternatively, darken the fill so white passes. These are the closest unchanged-hue options:

| Variant | Original | Darkened fill | White ratio |
|---|---|---|---|
| `.btn--secondary` | `#df6d1c` | `#b25716` | 4.51:1 |
| `.btn--blue` | `#00add0` | `#00809b` | 4.51:1 |
| `.btn--yellow` | `#fed100` | `#8a7100` | 4.54:1 |
| `.btn--lime` | `#BED600` | `#788700` | 4.52:1 |

Darkening also breaks the visual match with the public site, so **prefer the dark-label override** if
brand fidelity matters.

```css
.btn--secondary-dark { background: #b25716; border-color: #b25716; color: #fff; }
.btn--secondary-dark:hover { background: #9a4b12; border-color: #9a4b12; }
```

---

## 7. Cards

`.card` is the primary content container. Base text is `#262626`; variants set a fill and flip text
to white.

```css
.card {
  color: #262626;
  border-radius: var(--radius);   /* project override — source .card is square (§4.1) */
}
.card.primary               { background-color: #165788; color: #fff; }
.card.light-blue            { background-color: #00add0; }
.card.maroon                { background-color: #6e273d; color: #fff; }
.card.pink                  { background-color: #c90062; color: #fff; }
.card.charcoal              { background-color: #262626; color: #fff; }

/* Colored border treatment */
.card.border-primary > .content,
.card.border-light-blue > .content,
.card.border-maroon > .content,
.card.border-pink > .content   { border: 4px solid <accent>; padding: 28px 28px 36px; }

/* Top-rule treatment */
.card.top-border-gray > .content,
.card.top-border-grey > .content { border-top: 4px solid #d4d4d4; padding: 16px 0 0; }
.card.top-border-secondary > .content { border-top: 4px solid #df6d1c; padding: 16px 0 0; }
```

Media inside a card is edge-to-edge: `.card > header img { display: block; width: 100%; }`.

---

## 8. Overlays & Depth

| Value | Count | Use |
|---|---|---|
| `rgba(0,0,0,.2)` | 12 | Scrim |
| `rgba(0,0,0,.06)` | 7 | Faint wash |
| `rgba(0,0,0,.8)` | 6 | Image caption gradient |
| `rgba(0,0,0,.7)` | 4 | Modal scrim |
| `rgba(0,0,0,.12)` | 4 | Divider |

`z-index` values are ad-hoc, not a scale: `-1`, `0`, `1` (×11), `2`, `3`, `4`, `300`, `500`, `999`, `1000` (×3).

```css
/* Recommended explicit scale for a new app */
--z-base:    0;
--z-sticky:  100;
--z-dropdown:200;
--z-overlay: 300;
--z-modal:   400;
--z-toast:   500;
```

---

## 9. Focus & Accessibility

The source CSS has **no `:focus-visible` rules and no visible focus ring** beyond one box-shadow on a
combo box. It also has no `prefers-reduced-motion` guard. If this look is reused for an internal
reporting tool, **keep the palette and type but add real focus states** — WCAG 2.4.7 requires a visible
focus indicator.

```css
:focus-visible {
  outline: 3px solid var(--tertiary-color);
  outline-offset: 2px;
}
```

Also note that **four of the eight brand colors fail WCAG AA for white text** (measured ratios in §1.3):

| Combination | Ratio | Requirement |
|---|---|---|
| white on `#df6d1c` (secondary) | **3.31:1** | 4.5:1 — fails |
| white on `#00add0` (tertiary) | **2.66:1** | 4.5:1 — fails |
| white on `#fed100` (yellow) | **1.47:1** | 4.5:1 — fails badly |
| white on `#BED600` (lime) | **1.64:1** | 4.5:1 — fails badly |
| `#262626` on `#df6d1c` | 4.57:1 | 4.5:1 — **passes** |
| `#262626` on `#00add0` | 5.68:1 | 4.5:1 — **passes** |
| `#262626` on `#fed100` | 10.33:1 | 4.5:1 — **passes** |
| `#262626` on `#BED600` | 9.23:1 | 4.5:1 — **passes** |

Safe with white text: `primary` (7.63), `maroon` (10.39), `pink` (5.74), `slate` (7.72).
For everything else, put `#262626` on the fill — or darken the fill until white passes.

---

## 10. Starter Stylesheet

Drop-in replacement for the theme's tokens and base layer.

```css
/* ============================================================
   Design tokens — derived from wcpss.net
   ============================================================ */
:root {
  /* Brand */
  --primary-color:   #165788;
  --secondary-color: #df6d1c;
  --tertiary-color:  #00add0;
  --yellow:          #fed100;
  --maroon:          #6e273d;
  --lime:            #BED600;
  --pink:            #c90062;
  --slate:           #455560;

  /* Neutrals */
  --white:      #ffffff;
  --neutral-50:  #fafafa;
  --neutral-100: #f5f5f5;
  --neutral-200: #e5e5e5;
  --neutral-300: #d4d4d4;
  --neutral-400: #a3a3a3;
  --neutral-500: #727272;
  --neutral-600: #525252;
  --neutral-700: #404040;
  --neutral-800: #262626;
  --neutral-900: #171717;

  /* Semantic */
  --text-body:      var(--neutral-600);
  --text-heading:   var(--neutral-800);
  --text-on-dark:   #ffffff;
  --text-on-light:  var(--neutral-800);
  --surface:        #ffffff;
  --surface-muted:  var(--neutral-100);
  --border:         var(--neutral-200);

  /* Type */
  --font-body:   'Open Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-accent: 'Solway', Georgia, serif;

  /* Layout */
  --content-width: 1180px;
  --gutter: 40px;

  /* Spacing — 4px rhythm observed in the source */
  --space-1:  4px;
  --space-2:  8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  20px;
  --space-6:  24px;
  --space-8:  32px;
  --space-10: 40px;
  --space-15: 60px;
  --space-20: 80px;

  /* Shape & depth */
  --radius:        3px;   /* project override; source uses 4px on buttons, 0 on cards (§4.1) */
  --radius-sm:     3px;
  --radius-none:   0;
  --radius-pill:   999px;
  --radius-circle: 50%;
  --shadow-sm: 0 4px 24px rgba(0, 0, 0, .06);
  --shadow-md: 0 4px 32px rgba(0, 0, 0, .12);
  --shadow-lg: 0 4px 24px rgba(0, 0, 0, .20);

  /* Motion */
  --transition: .4s all;
}

/* ============================================================
   Base
   ============================================================ */
*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font-body);
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.5556;
  color: var(--text-body);
  background: var(--surface);
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4, h5, h6 {
  margin-top: 0;
  font-family: var(--font-body);
  font-weight: 700;
  color: var(--text-heading);
}

h1 { font-size: 2.5rem;   line-height: 1.3;  margin-bottom: 48px; color: var(--secondary-color); }
h2 { font-size: 2rem;     line-height: 1.25; margin-bottom: 20px; font-weight: 600; }
h3 { font-size: 1.5rem;   line-height: 1.5;  margin-bottom: 10px; }
h4 { font-size: 1.25rem;  line-height: 1.4;  margin-bottom: 10px; }
h5 { font-size: 1.125rem; line-height: 1.333; margin-bottom: 10px; }
h6 { font-size: 1rem;     line-height: 1.5;  margin-bottom: 10px; }

p + h1, p + h2 { margin-top: 40px; }
p:last-child, h1:last-child, h2:last-child { margin-bottom: 0; }

a { color: var(--primary-color); text-decoration: none; transition: var(--transition); }
a:hover, a:focus-visible { color: var(--secondary-color); text-decoration: underline; }

:focus-visible { outline: 3px solid var(--tertiary-color); outline-offset: 2px; }

/* ============================================================
   Shape — 3px on every rectangular surface (project override, §4.1)
   ============================================================ */
.btn, .card, .panel, .input, .select, .textarea, .search,
.dropdown, .modal, .drawer, .tab, .tag, .badge, .toast,
.alert, .code, .table-wrap {
  border-radius: var(--radius);
}

/* Shapes whose identity IS the radius — never collapse these to 3px */
.avatar, .icon-btn--round, .pager-dot { border-radius: var(--radius-circle); }
.pill, .switch, .chip--pill           { border-radius: var(--radius-pill); }
.figure--bleed > img                  { border-radius: var(--radius-none); }

/* ============================================================
   Layout
   ============================================================ */
.container {
  width: 100%;
  max-width: var(--content-width);
  margin: 0 auto;
  padding: 0 var(--space-5);
}

@media (min-width: 600px)  { /* sm */ }
@media (min-width: 800px)  { /* md */ }
@media (min-width: 1024px) { /* lg */ }
@media (min-width: 1200px) { /* xl */ }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 11. Notes for This Application

Context: an **Oracle → Kahua → Turso** integration/reporting app. The brand palette carries over
cleanly, but a few things should be adjusted for a data-dense internal tool.

### What to keep
- The **1180px content width** and §3.3 spacing rhythm — they read as calm and uncluttered.
- **`#165788` primary + `#262626` neutrals** as the workhorse combination.
- **`.4s all`** transitions on interactive elements.
- A **single small radius** on every rectangular surface. This project uses **3px** (§4.1) rather than
  the source's split of `4px` on buttons and `0` on cards.
- **Open Sans** for UI, **Solway** for section lead-ins.

### What to change
| Source behaviour | Why it's a problem here | Recommendation |
|---|---|---|
| Every `h1` is orange `#df6d1c` | On a dashboard, orange headings compete with status colors (warnings, deltas) and pull the eye away from the numbers | Use `#262626` for page titles; keep orange for **accents only** (active nav, key metrics) |
| No spacing scale, only literals | Hard to keep a data table, filter bar and KPI row visually consistent | Adopt the §3.3 4px scale |
| Auto-contrast via `hsl(from …)` | Relative color syntax is still unevenly supported and Safari has bugs with `round()` inside it | Resolve to literal `#fff` / `#262626` (see §6.4) |
| No `:focus-visible`, no reduced-motion | Internal tools are keyboard-driven; accessibility is a requirement, not a nicety | Add both (see §9, §10) |
| White text on yellow / lime | Fails WCAG AA badly (≈1.5:1, ≈1.8:1) | Dark text on light brand fills; reserve white for `primary`/`maroon`/`slate`/`dark` |
| `z-index` ad-hoc (`300`, `500`, `999`, `1000`) | Picking an arbitrary value is how you get a toast under a modal | Use the explicit scale in §8 |

### Suggested semantics for the reporting domain

The generic `cc-fourth … cc-eighth` slots mean nothing. Map them to reporting meaning up front:

```css
:root {
  /* Status — covers Oracle sync state and Kahua contract state */
  --status-ok:      #BED600;  /* was cc-sixth  (lime)   — synced / on track        */
  --status-info:    #00add0;  /* was tertiary  (blue)   — pending / in progress    */
  --status-warning: #fed100;  /* was cc-fourth (yellow) — drifting / needs review  */
  --status-error:   #c90062;  /* was cc-seventh (pink)  — failed / over budget     */
  --status-neutral: #455560;  /* was cc-eighth (slate)  — not applicable / archived */

  /* Deltas in comparison reports */
  --delta-up:   #BED600;
  --delta-down: #c90062;
  --delta-flat: #a3a3a3;
}
```

> ⚠️ Use **dark text on `--status-warning` and `--status-ok`** — white fails contrast on both. If
> badges must carry white text, darken the fill (e.g. `#8a7100` for warning, `#7a8a00` for ok) rather
> than shipping an inaccessible badge.

### Fonts

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wdth,wght@0,75..100,300..800;1,75..100,300..800&family=Solway:wght@300;400;700&display=swap" rel="stylesheet">
```

Self-host these if the app runs on an internal network without Google Fonts egress.

---

## Appendix: Source CSS Inventory

| Metric | Value |
|---|---|
| Theme bundle | 533,688 bytes (5 lines, minified) |
| App bundle | 486,999 bytes (minified) |
| `font-family` declarations | `"bpa-font-icons"` ×246, `"Open Sans"` ×213, `"IcoMoon"` ×58, `"Solway"` ×4 |
| Hex color occurrences | 1,768 total; **40 distinct** |
| Distinct custom properties | 15 (`--primary-color` ×194 … `--cc-sixth-color-hsl` ×1) |
| `:root` blocks in theme CSS | 0 — **tokens are injected inline in the page `<head>`** |
| `border-radius` declarations | 256 total; `4px` in 197, `50%` in 13, `8px` in 9, `3px` in 7. Source value — **overridden to `3px` project-wide on rectangular surfaces** (§4.1) |
| `transition` declarations | 716 total; `.4s all` in 560 of them |
| Color utility classes | 12 variants × 3 sizes + `system`/`light`/`dark`/`white` |
