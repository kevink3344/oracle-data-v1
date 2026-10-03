import type { MenuIcon } from '../nav/menu';

/**
 * The rail's marks.
 *
 * ★ THE DRAWINGS. There is no icon package in this app and this file is why it
 *   still does not need one: 45 marks, all 24×24, all one stroke width, all drawn
 *   from the same grid so the column reads as a column rather than as a set of
 *   pictures. `currentColor` does the theming and the two sizes are CSS, so
 *   nothing here knows what colour or how big it is.
 *
 * ★ `viewBox="0 0 24 24"` AND A 1.7 STROKE, WHICH IS NOT THE 16px HOUSE STYLE.
 *   `PinButton` and `EditableField` draw at 16 units because they render at 14px;
 *   these render at 16px and 14px from a 24-unit grid so the same drawing stays
 *   crisp if a caller ever wants it at 20. The stroke is 1.7 rather than the 1.9
 *   the top bar's hamburger uses, because on a rail these sit beside 13px text and
 *   1.9 read heavier than the letters did.
 *
 * ★ ONE PATH PER `d`, JOINED BY `|`, RATHER THAN AN ARRAY OF PATHS. The strings
 *   stay readable in a table this long, and `RailIcon` splits them at render. A
 *   `d` that contains a `|` would be a bug, but no SVG path command does.
 */
const PATHS: Record<MenuIcon, string> = {
  // ---- group headers ---------------------------------------------------
  // A dial with a needle: the at-a-glance screen.
  gauge: 'M3.5 12.2a8.5 8.5 0 0 1 17 0|M12 12l4-3.7',
  briefcase: 'M3.5 8.5h17V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z|M9 8.5V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5v2|M3.5 12.6h17',
  // A note. The one block whose leaf reads no extract at all reads a ledger.
  banknote: 'M3 7h18v10H3z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6.5 10.2h.01|M17.5 13.8h.01',
  // A till receipt with a torn foot: money that has been committed.
  receipt: 'M6.5 3.5h11V20l-2.2-1.4-2.2 1.4-2.2-1.4-2.2 1.4-2.2-1.4z|M9.5 8h5|M9.5 12h5',
  // A trolley. Procurement is ordering, and the order is what moves.
  cart: 'M3 5h2.3l2.4 9.6h10.2|M6.3 9.3h13.2l-1.1 5.3H7.4|M9.5 19.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z|M16.5 19.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z',
  // Two heads. A vendor is a company and a site and a spend total; a party.
  users: 'M9.5 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z|M2.8 20.2v-1.4a5 5 0 0 1 5-5h3.4a5 5 0 0 1 5 5v1.4|M16.2 5.4a3.5 3.5 0 0 1 0 6.8|M17.6 14.3a5 5 0 0 1 3.6 4.8v1.1',
  // Three boxes on a spine: segments branching into values.
  sitemap: 'M9.5 3.5h5v4h-5z|M3.5 16.5h5v4h-5z|M15.5 16.5h5v4h-5z|M12 7.5v4.7|M6 16.5v-4.3h12v4.3',
  // Equalizers: configuration, and the only block with no questions in it.
  sliders: 'M4 7.5h5.5|M13.5 7.5h6.5|M4 16.5h9.5|M17.5 16.5h2.5|M11.5 5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z|M15.5 14.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',

  // ---- leaves ----------------------------------------------------------
  home: 'M4 10.6 12 4l8 6.6|M6.6 9.4V19a1.2 1.2 0 0 0 1.2 1.2h8.4A1.2 1.2 0 0 0 17.4 19V9.4|M10.4 20.2v-5h3.2v5',
  // The register's own pulse: a trace, because Activity is a count of changes.
  pulse: 'M3 12.5h3.8l2.5-6.5 4.2 11.5 2.2-5h5.3',
  pin: 'M9.2 4h5.6l-1.1 4.9 2.9 2.6v1.2H7.4v-1.2l2.9-2.6z|M12 12.7V20',
  eye: 'M2.6 12a10 10 0 0 1 18.8 0|M2.6 12a10 10 0 0 0 18.8 0|M12 14.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z',
  list: 'M4 6.5h16|M4 12h16|M4 17.5h10',
  folder: 'M3.5 6.6A1.5 1.5 0 0 1 5 5.1h3.6l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v7.4A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5z',
  // A tag with a stroke through it: a combination nothing has claimed.
  'tag-slash': 'M20 12.6 12.6 20 4.6 12V4.6H12z|M9.4 14.6 14.6 9.4',
  grid: 'M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z',
  wallet: 'M3.5 8.4h17v8.3a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z|M6.1 8.4 7.8 5.9a1.6 1.6 0 0 1 1.3-.7h5.6a1.6 1.6 0 0 1 1.5 1.6v1.6|M16.2 12.5h1.8',
  // Two arrows crossing: an adjustment moves money out of one line and into another.
  transfer: 'M8 4.5v15|M4.4 8.1 8 4.5l3.6 3.6|M16 19.5v-15|M12.4 15.9 16 19.5l3.6-3.6',
  history: 'M3.8 12a8.2 8.2 0 1 0 2.4-5.8|M3.8 4.6v4.6h4.6|M12 7.8V12l3.2 1.9',
  notebook: 'M6.2 3.5h11.6v17H8.2a2 2 0 0 1-2-2z|M6.2 3.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2|M9.6 8.5h5.2|M9.6 12.5h5.2',
  // A divided circle: a whole sliced into the shares that were allocated to it.
  pie: 'M12 3.5a8.5 8.5 0 0 1 8.5 8.5 8.5 8.5 0 0 1-8.5 8.5 8.5 8.5 0 0 1-8.5-8.5A8.5 8.5 0 0 1 12 3.5z|M12 12V3.5|M12 12h8.5',
  table: 'M4 5.5h16v13H4z|M4 10h16|M9.5 10v8.5',
  lock: 'M6.5 10.8h11v7.7a1.5 1.5 0 0 1-1.5 1.5H8a1.5 1.5 0 0 1-1.5-1.5z|M9 10.8V7.9a3 3 0 0 1 6 0v2.9',
  file: 'M6.2 3.5h7.6L19 8.7V20.5H6.2z|M13.8 3.5v5.2H19|M9.2 12.5h7|M9.2 16h4.6',
  'check-square': 'M4 5.5h16v13H4z|M8.3 11.8l2.6 2.7 4.8-5.2',
  // A balance. The whole screen is one comparison and it refuses to add the two sides.
  scale: 'M12 4.6v14.9|M5 7.6h14|M5 7.6 2.6 14h4.8z|M19 7.6 16.6 14h4.8z|M8.4 19.5h7.2',
  clipboard: 'M9.2 4.6H7.2A1.6 1.6 0 0 0 5.6 6.2v12.7A1.6 1.6 0 0 0 7.2 20.5h9.6a1.6 1.6 0 0 0 1.6-1.6V6.2A1.6 1.6 0 0 0 16.8 4.6h-2|M9.5 3.2h5v3.2h-5z|M8.8 11.2h6.4|M8.8 15h4.2',
  rows: 'M4.6 6.5h.01|M8.4 6.5h11|M4.6 12h.01|M8.4 12h11|M4.6 17.5h.01|M8.4 17.5h11',
  truck: 'M3.2 7.2h9.4v9H3.2z|M12.6 10.4h4.1l3.1 3.1v2.7h-7.2z|M7.1 19.5a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z|M16.9 19.5a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z',
  // Three nodes and two edges: one charge split across accounts.
  share: 'M17 7.7a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z|M7 14.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z|M17 20.7a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z|M9 9.6l5.9-3.1|M9 12.6l5.9 3.1',
  bookmark: 'M6.5 4.5h11v16l-5.5-3.8-5.5 3.8z|M9.5 9h5',
  building: 'M4.2 20.2V5.6a1.6 1.6 0 0 1 1.6-1.6h6a1.6 1.6 0 0 1 1.6 1.6v14.6|M13.4 9.6h4.8a1.6 1.6 0 0 1 1.6 1.6v9|M2.6 20.2h18.8|M7.2 8h3.2|M7.2 11.8h3.2|M7.2 15.6h3.2|M16.4 13h.01|M16.4 16.8h.01',
  'map-pin': 'M12 20.8s6.4-6 6.4-10.3a6.4 6.4 0 1 0-12.8 0C5.6 14.8 12 20.8 12 20.8z|M12 13.1a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z',
  // Out of the register and away: the direction money takes when it leaves.
  outbound: 'M7.4 16.6 16.6 7.4|M10.2 7.4h6.4v6.4',
  columns: 'M4 5.5h16v13H4z|M9.4 5.5v13|M14.6 5.5v13',
  calendar: 'M4.5 6.6h15v13.4h-15z|M4.5 10.8h15|M8.6 4.2v4.4|M15.4 4.2v4.4',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z|M12 7.4V12l3.2 1.9',
  search: 'M10.6 17.6a7 7 0 1 0 0-14 7 7 0 0 0 0 14z|M15.7 15.7 20.4 20.4',
  cog: 'M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z|M12 2.6v2.8|M12 18.6v2.8|M2.6 12h2.8|M18.6 12h2.8|M5.4 5.4l2 2|M16.6 16.6l2 2|M18.6 5.4l-2 2|M7.4 16.6l-2 2',
  layout: 'M3.5 5.5h17v13h-17z|M3.5 9.6h17|M9.6 9.6v8.9',
  cap: 'M12 3.6v10.8|M7.6 10 12 14.4 16.4 10|M4.6 19.6h14.8',
  tag: 'M20 12.6 12.6 20 4.6 12V4.6H12z|M8.6 8.6h.01',
  layers: 'M12 3.6 20 8l-8 4.4L4 8z|M4 12.4 12 16.8l8-4.4|M4 16.4 12 20.8l8-4.4',
  toggle: 'M8.4 8.4h7.2a3.6 3.6 0 0 1 0 7.2H8.4a3.6 3.6 0 0 1 0-7.2z|M15.6 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z',
  database: 'M4.6 6.4c0-1.6 3.3-2.9 7.4-2.9s7.4 1.3 7.4 2.9-3.3 2.9-7.4 2.9-7.4-1.3-7.4-2.9z|M4.6 6.4v11.2c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9V6.4|M4.6 12c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9',
};

export default function RailIcon({ name }: { name: MenuIcon }) {
  return (
    <svg
      className="rail__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].split('|').map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
