# Accessibility boundary and text routes

PGSimCity's PostgreSQL lessons are intended to remain usable when the 3D city
is not. This document records the boundary honestly; it is not a claim that the
3D scene itself has a nonvisual equivalent.

## Text-first routes

- In the city, use `/` or `Ctrl/Cmd+K` to search the component inventory. A
  result opens the component's text inspector. The HUD vitals also open the
  matching inspector or a textual latency breakdown when activated.
- Press `T` for the guided tour. Its fourteen chapter titles and explanations
  are live text, and its Previous, Play/Pause, Next, chapter, and Exit controls
  are ordinary buttons.
- [Diagnose](observability/) is a text decision tree over the model. Each step
  states why to read a view, provides the query, renders a table, and offers
  keyboard-operable branches. Each verdict binds its diagnosis to the
  qualification that explains it.
- [The Machine](machine/) provides a labelled SQL prompt, a live psql transcript,
  textual PostgreSQL receipts, and keyboard-contained comparison and index-walk
  dialogs. Its `P` and `M` medallions are exposed as “PostgreSQL source” and
  “Modelled source”; the distinction is not left to colour or the glyph.

With `prefers-reduced-motion: reduce`, the city, Diagnose model, and Machine
board start paused. CSS transitions and animations are reduced, camera moves
cut to their destination, and Machine query replays expose their textual receipt
without requiring an animated playback. Visible playback controls remain
available for deliberate interaction; tour chapters advance by cuts while the
city model stays paused.

## Structural limits

- The WebGL city has no semantic scene graph, nonvisual object map, or
  screen-reader description of every animated event. The command palette and
  inspector expose the component inventory and lesson prose, but they do not
  communicate the city's exact spatial layout.
- First-person walking, swimming, pointer-lock looking, nearby levers, and the
  experience of scale are visual and spatial interactions. There is no honest
  keyboard-only or screen-reader substitute for navigating that geometry.
  Relevant PostgreSQL settings and mechanisms are available in the console,
  inspector, tour, Diagnose, or Machine, but the embodied city lesson is not.
- Some metaphors are geometry-specific: the Slonik-shaped plate, district
  adjacency, the relative height of shared memory and storage, and simultaneous
  particle routes. Text routes teach the underlying mechanisms, but not those
  visual metaphors. Treating an `aria-label` as a replacement would overstate
  what a nonvisual reader receives.
- The Machine announces each modelled replay stage and the final measured
  receipt. Its exact board coordinates and simultaneous A/B path geometry
  remain visual; the comparison finding, aligned timeline, source labels, and
  limitations are the nonvisual lesson.

These are product gaps to consider in future text or structured-data work, not
defects that can be solved by attaching invented descriptions to canvases.
