// helpcontent.js — the Help panel's content + the pure section-state logic.
//
// DOM-free by design (same contract as cellfilter.js / exportscope.js): the
// section structure is plain data and the open/collapsed defaults are pure
// functions, so `node --test` exercises them directly
// (tests/test_helpcontent.mjs). app.js owns all rendering.
//
// This is the in-app User Guide. Keep it complete and aligned with user-visible
// behavior in the same change that adds or updates a feature. Inline markup is
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
        'On maps with detailed overview imagery, zooming automatically loads sharper views at <b>50, 25, 12.5 and 6.25 m/pixel</b>. Allow the imagery to load as you zoom. Open a cell for the full <b>2 m/pixel</b> crop and labeling tools; the overall map stops at a coarser level.',
        '<b>Layer toggles</b> (top bar): the model\'s probability <b>Heatmap</b>, <b>Existing GT</b> (known shafts and channels), <b>All marks</b> (everyone\'s labels), <b>Accurate TIFs</b> (green = cells whose imagery was verified well-aligned), and <b>Filter mask</b> (see below).',
        '<b>Cell list</b> (left sidebar): all cells sorted by the model\'s shaft probability (p_pos), highest first. With completion controls, a green ✓ means finished and a blue shield check means approved. Otherwise, ✓ indicates saved marks. Hovering a row highlights the cell on the map.',
      ] },
      { t: 'h3', html: 'Filters' },
      { t: 'p', html: 'Click <b>Filters</b> above the cell list to expand it:' },
      { t: 'ul', items: [
        '<b>p_pos range</b> — a two-handle slider over the cells ranked by model score. The readout shows both the score values and the corresponding "top X%" of cells.',
        '<b>Labeled by</b> — tick one or more labelers to keep only cells they have labeled. <b>(all users)</b> toggles everyone at once; <b>(unlabeled)</b> selects cells nobody has labeled yet and is exclusive with the name checkboxes.',
        '<b>Finished by</b> — when completion controls are available, filter by who currently marked a crop finished. Choose <b>(no restriction)</b>, <b>(anyone)</b>, specific names, or <b>(unfinished)</b>. A crop can be finished with no labels, and an approved crop still matches its original finisher.',
        '<b>Approved by</b> — filter by who currently approved a crop. Choose <b>(no restriction)</b>, <b>(anyone)</b>, specific names, or <b>(unapproved)</b>. Everyone can use this filter; approval actions require a superuser.',
      ] },
      { t: 'p', html: 'Names within one group match <b>any</b> selected person. Across groups, a crop must match <b>every</b> enabled group and the p_pos range. For example, Finished by <b>(anyone)</b> plus Approved by <b>(unapproved)</b> shows the review queue. Status filters use current attribution; earlier finish and approval actions remain in Status history.' },
      { t: 'p', html: 'Matching cells stay bright on the map while everything else dims (the <b>Filter mask</b> toggle hides that dimming if you want the full-color map back). The count next to the summary line tells you how many cells match. <b>reset</b> clears all filter restrictions.' },
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
        '<b>Delete</b> (or <b>Backspace</b>) removes the selected marks.',
        '<b>Move</b>: click a mark to select it, then press and drag it. On a polyline, grabbing a vertex moves that vertex; grabbing the line between vertices moves the whole line. <b>Esc during a drag</b> puts it back.',
        '<b>Undo last</b> removes your most recent mark; <b>Clear this crop</b> removes all of your marks in the crop.',
        'The blue <b>Save work</b> button uploads your changes and leaves the crop unfinished. Wait for the saved status to confirm synchronization. Until then, changes exist locally in your browser.',
      ] },
      { t: 'h3', html: 'Completion and approval' },
      { t: 'p', html: 'The following controls and recovery steps apply when crop completion is enabled for your site.' },
      { t: 'ul', items: [
        'Completion is shared by everyone in the project. After checking the entire crop, mark it finished when all qanats are labeled or no qanats are present. Another user cannot add a second finish while that status remains active. Saving labels alone does not give the crop a finished check.',
        'The green button reads <b>Save &amp; mark finished</b> when there are unsaved edits and <b>Mark finished</b> when there are none. It always asks for confirmation before the initial completion request. Confirm saves any edits and marks completion together; <b>Cancel</b> keeps your edits and sends no save or completion request.',
        'Finished and approved crops are read-only, including for superusers. You can still inspect imagery, select marks and read Status history. Use <b>Reopen crop</b> to resume editing your own finished work before approval; a superuser can reopen any finished or approved crop.',
        'Only superusers can <b>Approve</b> a finished crop, including one they finished themselves, or <b>Cancel approval</b>. Cancelling approval keeps the crop finished and read-only. Reopening an approved crop removes both approval and completion. A green ✓ means finished; a blue shield check means approved.',
        '<b>Status history</b> is available to everyone and records finishing, reopening, approval and cancellation with the user and time. Reopening an approved crop records both status removals. Earlier events remain available after a status changes.',
        'Shared data refreshes when you unlock, open a crop, or click <b>Refresh</b>. Other users may have changed a crop since you opened it. If its state cannot be confirmed, editing and completion stay disabled until a successful refresh.',
      ] },
      { t: 'h3', html: 'Saving and recovery' },
      { t: 'ul', items: [
        'Complete or cancel a one-vertex polyline before saving or marking finished. A line with at least two vertices is completed when you save.',
        'If a save result is uncertain, use <b>Retry save</b> and wait for confirmation before leaving the crop. A completion retry uses your original confirmation without asking again. After reloading the page, use the same name, project and passcode role, then open the original crop to recover the pending save.',
        'If a message says the pending save belongs to another role, sign in with that original normal or superuser role. An older pending save without a recorded role requires superuser recovery; ask the project organizer if you do not have that access.',
        '<b>Refresh</b> reloads shared marks and crop status together. If the crop has not changed, your local draft resumes. If someone changed it or a restore replaced it, the old draft is kept separately and can be saved with <b>Download local draft</b>; compare it with the current crop before reapplying edits.',
        'Keep the same browser and site address during recovery, and keep browser storage intact. If the tool reports that it cannot store a draft, keep the page open until you have saved or exported your work.',
      ] },
      { t: 'p', html: 'Getting around:' },
      { t: 'ul', items: [
        '<b>Right-drag or middle-drag</b> pans, <b>wheel</b> zooms.',
        'The translucent <b>edge arrows</b> (or the <b>arrow keys</b>) jump to the adjacent crop. An arrow only appears where a neighboring crop exists.',
        'Close with the <b>Close</b> button, by <b>clicking outside the panel</b>, or with <b>Esc</b>.',
        'Leaving a crop with unsaved edits offers <b>Save</b>, <b>Discard</b> or <b>Cancel</b>. Saving on exit uploads labels without marking the crop finished. An uncertain save must be resolved before leaving.',
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
      { t: 'note', html: 'These tools are available to sessions unlocked with the superuser passcode (any name works with it). Everyone else can read this section to understand review, corrections and restoration. Use your usual name so your actions keep the same attribution.' },
      { t: 'ul', items: [
        '<b>Review completed crops</b>: use Finished by <b>(anyone)</b> and Approved by <b>(unapproved)</b>, open a crop, inspect it, then <b>Approve</b> or <b>Reopen crop</b>. To correct marks in a finished or approved crop, reopen it first. <b>Cancel approval</b> leaves completion in place.',
        '<b>Edit others</b> (top-bar switch, off by default): while it is on (the bar turns amber), other people\'s marks in the crop view become selectable, deletable and movable, with the same gestures as your own. Corrections keep the original labeler\'s name on the mark; the record additionally notes that you edited it.',
        '<b>Snapshots</b> (top-bar button): save the complete current state of all marks as one snapshot, with an optional note. Each snapshot is identified by a short hash (like a git commit). A dim <b>≡ hash</b> badge means that snapshot\'s content is identical to an earlier one. <b>Restore…</b> returns the whole project to a snapshot\'s state — a safety snapshot of the current state is taken automatically first.',
        '<b>History…</b> (crop toolbar, with a single saved mark selected): the mark\'s full change log — who did what, when. Each row is the mark\'s state after that action; the newest row is marked <b>Current</b>. <b>Restore this version</b> returns the mark to any earlier state, including reviving a deleted mark. Rows marked <b>↺ snapshot restore</b> came from a whole-project restore rather than an individual edit.',
      ] },
      { t: 'p', html: 'With completion controls enabled, restoring a snapshot reopens every finished or approved crop in that project, including crops with no marks. Restoring a mark version reopens its affected crop. Previous completion and approval events remain in Status history; review restored work before marking it finished again.' },
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
          ['Crop view', 'Delete / Backspace', 'delete selected marks'],
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
      { t: 'p', html: '<b>When do others see my labels?</b> After a save succeeds. Other users can open the crop or use Refresh to read the latest shared data. Save &amp; mark finished also saves labels when its confirmation is accepted and the operation succeeds.' },
      { t: 'p', html: '<b>Why can\'t I edit or delete someone else\'s mark?</b> Every mark belongs to the person who drew it. If you spot a mistake in someone else\'s work, tell the project organizer — a superuser can correct it without destroying the record of who labeled what.' },
      { t: 'p', html: '<b>I made a mistake — is it gone forever?</b> Saved changes have a history. A superuser can use History… or snapshots to restore earlier saved work. Unsaved edits are not part of that shared history.' },
      { t: 'p', html: '<b>My save failed.</b> Check the status message and your connection. Use Retry save when offered; otherwise follow the refresh or recovery instruction. Keep the page and browser storage intact until your work is confirmed saved. Download local draft can preserve a recovery copy when available. Browser storage can fill up or be cleared, so local drafts are not a substitute for a confirmed save.' },
      { t: 'p', html: '<b>Why does a labeled crop have no check?</b> With completion controls enabled, saved marks and completion are separate. A green check appears only after someone marks the whole crop finished; approval changes it to a blue shield check.' },
      { t: 'p', html: '<b>Why is this crop read-only?</b> It may be finished or approved, a save may still need confirmation, or shared status may be unavailable. Read the crop status message for the next step. Your own unapproved finish can be reopened; other users\' finishes and approved crops require a superuser.' },
      { t: 'p', html: '<b>Does zooming change my labels?</b> No. Mark symbols keep a constant on-screen size while you zoom; their locations on the ground stay the same.' },
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
