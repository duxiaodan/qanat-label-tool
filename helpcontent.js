// helpcontent.js — the Help panel's content + the pure section-state logic.
//
// DOM-free by design (same contract as cellfilter.js / exportscope.js): the
// section structure is plain data and the open/collapsed defaults are pure
// functions, so `node --test` exercises them directly
// (tests/test_helpcontent.mjs). app.js owns all rendering.
//
// The prose below is the user-approved Help draft, reproduced verbatim —
// change the WORDING only with the user, not in passing. Inline markup is
// intentionally limited to <b>; block structure is typed:
//   {t:'p',    html}            paragraph
//   {t:'note', html}            dimmed small-print paragraph (§5 intro)
//   {t:'h3',   html}            sub-heading inside a section ("Filters")
//   {t:'ul',   items:[html,…]}  bullet list
//   {t:'table', head:[…], rows:[[…],…]}  the keyboard/mouse reference

export const HELP_SECTIONS = [
  {
    id: 'start',
    title: '1. Getting started',
    blocks: [
      { t: 'p', html: 'Unlock the tool with three things:' },
      { t: 'ul', items: [
        '<b>Your name</b> — every label you create is attributed to it. Use the same spelling every time, or your work will be split across two identities.',
        '<b>Project</b> — select the project you were asked to label. Labels are kept separate per project.',
        '<b>Passcode</b> — provided by the project organizer.',
      ] },
      { t: 'p', html: 'After unlocking you see the <b>overall view</b>: the full swath image with a grid of cells. The color legend in the top bar applies everywhere: <b>green = your marks, orange = other people\'s marks</b>.' },
    ],
  },
  {
    id: 'overall',
    title: '2. Overall view',
    blocks: [
      { t: 'ul', items: [
        '<b>Pan</b> with either mouse button (drag) · <b>zoom</b> with the wheel · <b>click a cell</b> to open it for labeling.',
        '<b>Layer toggles</b> (top bar): the model\'s probability <b>Heatmap</b>, <b>Existing GT</b> (known shafts and channels), <b>All marks</b> (everyone\'s labels), <b>Accurate TIFs</b> (green = cells whose imagery was verified well-aligned), and <b>Filter mask</b> (see below).',
        '<b>Cell list</b> (left sidebar): all cells sorted by the model\'s shaft probability (p_pos), highest first. A ✓ means you already saved work there. Hovering a row highlights the cell on the map.',
      ] },
      { t: 'h3', html: 'Filters' },
      { t: 'p', html: 'Click <b>Filters</b> above the cell list to expand it:' },
      { t: 'ul', items: [
        '<b>p_pos range</b> — a two-handle slider over the cells ranked by model score. The readout shows both the score values and the corresponding "top X%" of cells.',
        '<b>Labeled by</b> — tick one or more labelers to keep only cells they have labeled. <b>(all users)</b> toggles everyone at once; <b>(unlabeled)</b> selects cells nobody has labeled yet and is exclusive with the name checkboxes.',
      ] },
      { t: 'p', html: 'Both conditions apply together. Matching cells stay bright on the map while everything else dims (the <b>Filter mask</b> toggle hides that dimming if you want the full-color map back). The count next to the summary line tells you how many cells match. <b>reset</b> clears everything.' },
    ],
  },
  {
    id: 'crop',
    title: '3. Labeling in the crop view',
    blocks: [
      { t: 'p', html: 'Open a cell to label it. Pick a draw mode in the toolbar:' },
      { t: 'ul', items: [
        '<b>Point</b> (shaft): click to place a dot.',
        '<b>Polyline</b> (channel): click each vertex; <b>double-click or Enter</b> finishes the line; <b>Esc</b> cancels an unfinished line.',
      ] },
      { t: 'p', html: 'Useful toggles: <b>Autocontrast</b> (stretch the imagery contrast — display only, never affects the data) and <b>Existing GT</b> (show/hide known ground truth).' },
      { t: 'p', html: 'Working with your own marks:' },
      { t: 'ul', items: [
        '<b>Select</b> one by clicking it, or <b>box-select</b> several with a left-drag.',
        '<b>Delete</b> removes the selected marks.',
        '<b>Move</b>: click a mark to select it, then press and drag it. On a polyline, grabbing a vertex moves that vertex; grabbing the line between vertices moves the whole line. <b>Esc during a drag</b> puts it back.',
        '<b>Undo last</b> removes your most recent mark; <b>Clear this crop</b> removes all of your marks in the crop.',
        '<b>Save work</b> uploads your changes. Until you save, changes exist only in your browser.',
      ] },
      { t: 'p', html: 'Getting around:' },
      { t: 'ul', items: [
        '<b>Right-drag or middle-drag</b> pans, <b>wheel</b> zooms.',
        'The translucent <b>edge arrows</b> (or the <b>arrow keys</b>) jump to the adjacent crop. An arrow only appears where a neighboring crop exists.',
        'Close with the <b>Close</b> button, by <b>clicking outside the panel</b>, or with <b>Esc</b>.',
      ] },
      { t: 'p', html: 'Hover any orange mark to see <b>who labeled it</b> (and, if a superuser later corrected it, "edited by …").' },
    ],
  },
  {
    id: 'download',
    title: '4. Downloading GeoJSON',
    blocks: [
      { t: 'p', html: '<b>Download GeoJSON</b> (top bar) opens a dialog with three independent choices:' },
      { t: 'ul', items: [
        '<b>Crops</b> — all crops, or only those matching your current Filters.',
        '<b>Marks by</b> — everyone, just you, or a chosen set of labelers.',
        '<b>Created</b> — any time, this session, or since a date you pick.',
      ] },
      { t: 'p', html: 'The dialog shows a live count of the marks your selection contains before you download. Two files are produced (shafts and channels), and the filename records exactly what you selected.' },
    ],
  },
  {
    id: 'su',
    title: '5. Superuser tools',
    collapsible: true,   // collapsed by default in normal sessions, expanded for S.su
    blocks: [
      { t: 'note', html: 'These tools are available to sessions unlocked with the superuser passcode (any name works with it). Everyone else can read this section to know what a superuser can do — mainly: fix or remove mislabeled marks without losing track of who originally made them.' },
      { t: 'ul', items: [
        '<b>Edit others</b> (top-bar switch, off by default): while it is on (the bar turns amber), other people\'s marks in the crop view become selectable, deletable and movable, with the same gestures as your own. Corrections keep the original labeler\'s name on the mark; the record additionally notes that you edited it.',
        '<b>Snapshots</b> (top-bar button): save the complete current state of all marks as one snapshot, with an optional note. Each snapshot is identified by a short hash (like a git commit). A dim <b>≡ hash</b> badge means that snapshot\'s content is identical to an earlier one. <b>Restore…</b> returns the whole project to a snapshot\'s state — a safety snapshot of the current state is taken automatically first.',
        '<b>History…</b> (crop toolbar, with a single saved mark selected): the mark\'s full change log — who did what, when. Each row is the mark\'s state after that action; the newest row is marked <b>Current</b>. <b>Restore this version</b> returns the mark to any earlier state, including reviving a deleted mark. Rows marked <b>↺ snapshot restore</b> came from a whole-project restore rather than an individual edit.',
      ] },
    ],
  },
  {
    id: 'keys',
    title: '6. Keyboard & mouse reference',
    blocks: [
      { t: 'table',
        head: ['Where', 'Input', 'Action'],
        rows: [
          ['Overall view', 'drag (either button)', 'pan'],
          ['Overall view', 'wheel', 'zoom'],
          ['Overall view', 'click a cell', 'open its crop'],
          ['Crop view', 'click', 'add point / polyline vertex'],
          ['Crop view', 'double-click / Enter', 'finish polyline'],
          ['Crop view', 'left-drag', 'box-select your marks'],
          ['Crop view', 'press + drag a selected mark', 'move it'],
          ['Crop view', 'Delete', 'delete selected marks'],
          ['Crop view', 'right-drag / middle-drag', 'pan'],
          ['Crop view', 'wheel', 'zoom'],
          ['Crop view', 'arrow keys', 'jump to adjacent crop'],
          ['Crop view', 'Esc', 'cancel line/drag → clear selection → close'],
          ['Dialogs', 'Esc', 'close / cancel'],
        ] },
    ],
  },
  {
    id: 'faq',
    title: '7. FAQ',
    blocks: [
      { t: 'p', html: '<b>When do others see my labels?</b> As soon as you hit Save work. Use Refresh (top bar) to pull the latest labels from everyone else.' },
      { t: 'p', html: '<b>Why can\'t I edit or delete someone else\'s mark?</b> Every mark belongs to the person who drew it. If you spot a mistake in someone else\'s work, tell the project organizer — a superuser can correct it without destroying the record of who labeled what.' },
      { t: 'p', html: '<b>I made a mistake — is it gone forever?</b> No. Every change to every mark is recorded permanently. A superuser can restore any mark to any earlier state.' },
      { t: 'p', html: '<b>My save failed.</b> Your marks are kept locally in the browser and the status bar shows "unsynced". Check your connection and save again — nothing is lost as long as you don\'t clear your browser storage.' },
      { t: 'p', html: '<b>Does zooming change my labels?</b> No. Marks keep a constant on-screen size while you zoom; their actual positions are stored in image coordinates and never change unless you move them.' },
    ],
  },
];

/** Is `section` expanded when the panel is (re)built? Non-collapsible sections
 *  are ALWAYS open; the collapsible one (§5 Superuser tools) opens only for a
 *  superuser session. Pure — `su` is the S.su flag, coerced to boolean. */
export function sectionOpenByDefault(section, su) {
  return section.collapsible ? !!su : true;
}

/** Default open/closed state for every section, in order: [{id, open}, …].
 *  app.js applies this when it renders the panel for a session role. */
export function sectionStates(sections, su) {
  return sections.map((s) => ({ id: s.id, open: sectionOpenByDefault(s, su) }));
}
