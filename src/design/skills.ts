export const DESIGN_SKILLS: Record<string, string> = {
  interface: `interface:
- When a brand or design system governs the work, read it in full first and pull real color, type, and assets from it; never invent token values. Harmonize additions in a perceptual color space such as oklch rather than eyeballing hex.
- When nothing governs the work, pick one extreme tone — editorial, brutalist, refined-minimal, maximalist — execute it with conviction, and decide up front the single thing a viewer will remember it by; never settle into the same look twice across requests. Set a characterful display face against a quieter text face (the ubiquitous defaults — Inter, Roboto, Arial — read as unfinished), favor deliberate, often asymmetric composition with real depth, and steer clear of the auto-generated tells (gradient-on-everything, the accent-striped card, stock emoji, scratch-drawn SVG).
- Spacing, Grids & Radii: Enforce a strict 4px grid spacing scale: [4, 8, 12, 16, 20, 24, 32, 48]. Compute nested corner radius curves mathematically: Inner Radius = Outer Radius - Padding, using CSS calc(). Calculate grid layouts dynamically (e.g., a 12-column desktop structure or 4-column mobile structure) using CSS variables and calc() instead of hardcoding absolute widths.
- Depth Isolation: Restrict the interface to exactly ONE depth mechanism (borders, or shadows, or tonal layering) and forbid the others. Never mix depth styles on the same canvas.
- Anchor the palette on a single hue that carries the screen, with a couple of sharp accents doing the punctuation; an even, democratic spread reads as timid. Drive it all from variables so every screen stays in lockstep.
- Scale the implementation to the vision: maximalism earns elaborate effects; minimalism earns restraint and precise spacing. Every element earns its place — no filler sections, no decorative data; an empty-feeling region is a layout problem to solve, not a cue to invent content.
- Compose rows and groups with gap-based layout primitives; keep raw inline flow for text runs, not for arranging UI elements. Spend the motion budget on one strong load-moment over scattered micro-interactions. Give icon buttons, switches, and dialogs their semantic roles and labels, and keep touch targets at roughly 44px or larger.
- When extending an existing interface, match its vocabulary first — copy tone, palette, hover and press states, shadow and card patterns, density — before adding anything; when recreating a real product's screens, replicate faithfully from its source, never from memory or a screenshot, and don't invent a new look.
- For mobile work, put <meta name="design-device" content="mobile"> in every screen. The workspace supplies the 390×844 handset shell; author only the full-bleed app screen, including in-screen status or navigation bars when needed, and never draw the outer handset or bezel inside the file.
- Target a chosen device or form-factor width.`,

  prototype: `prototype:
- For unfamiliar flows, ask plenty up front — including the target platform (iOS, Android, or web) — since interaction can't be read from static visuals alone.
- Build real state, transitions, hover/press/validation/loading. Persist shared application state — cart, auth, selections, form entries, alongside scroll/step/playback position — in a shared localStorage store and re-read it on every screen's load: each navigation between .os.html screens is a full page load, so any state kept only in memory is lost when the user moves between screens (add-to-cart on one screen then navigating to the cart must still show the item). Never clear or overwrite stored entries you didn't set this turn.
- Add variants as separate screens on the canvas rather than forking files or hiding them inside one screen.
- For mobile work, put <meta name="design-device" content="mobile"> in every screen. The workspace supplies the 390×844 handset shell; author only the full-bleed app screen, including in-screen status or navigation bars when needed, and never draw the outer handset or bezel inside the file.`,

  animation: `animation:
- The playable HTML is the video; export happens through the host or a screen capture, so design to a fixed aspect ratio (16:9 or 9:16).
- Wrap the piece in a single <anim-stage duration="N" loop> element. The host drives a rAF clock and a play/pause + scrub playback bar (Space toggles, ← → seek, 0 restarts), contain-fits the stage (declare the aspect with <meta name="design-fixed-size" content="1920,1080"> or width/height attributes on <anim-stage>), exposes the timeline as CSS custom properties --t (seconds elapsed) and --progress (0..1) on the stage, shows/hides any descendant by its data-anim-start / data-anim-end seconds, and persists the playhead across reloads for you — so build to the clock and don't reimplement transport or persistence.
- Lead with story: name the arc, the tension, and the point before animating; for substantial pieces, float the concept past the user first.
- Borrow from classical animation craft — telegraph a move before it lands, give transitions weight on the way in and out, and push poses far enough to read — without naming the principles as a checklist.
- Ground every scene in a real context — a background, or a device/app UI frame — so elements never float in empty space.
- Keep the frame alive: a shot with nothing moving usually reads as a defect. Open on an establishing shot for context, then cut or push hard into the action; let the camera drift, pan, or push in, and give stills a slow Ken Burns move. Hold text and images long enough to land.
- For product walkthroughs, follow the pointer with a damped, zoomed viewport that reads real element positions through refs, so the cursor lands exactly on its target.
- Drive motion from the stage timeline: read --t / --progress in CSS (calc, transforms, opacity) or in a small rAF/JS reader, and gate scenes with data-anim-start / data-anim-end rather than a fixed keyframe run that ignores the scrubbable clock. Compose reusable per-element pieces, favor transform and opacity for a smooth ~60fps, and tune the timeline iteratively.
- Respect prefers-reduced-motion: don't force aggressive motion on a viewer who opted out — fall back to a calm or static state.`,

  document: `document:
- Author the body as one continuous column the browser paginates at print time: wrap the whole document in a single <main class="doc"> whose first element is the h1 — never a masthead or eyebrow. If pasted source opens with a header or banner line, drop it. Target a print sheet (Letter or A4).
- The Save/Export-to-PDF button calls window.print(); there is no rasterization — the PDF IS the print CSS. Everything below is the load-bearing mechanism; keep it intact.
- Structure the body inside a spacer table so every printed page gets a top and bottom margin even though @page margin is 0:
    <main class="doc">
      <table class="doc-frame" role="presentation">
        <thead><tr><td class="hdr-space"></td></tr></thead>
        <tbody><tr><td> ...entire document body as static HTML... </td></tr></tbody>
        <tfoot><tr><td class="ftr-space"></td></tr></tfoot>
      </table>
    </main>
  The thead/tfoot repeat on every printed page, so their spacer cells ARE the per-page top/bottom margin. The whole body goes in the single tbody>tr>td cell; spacer cells stay empty.
- Base CSS: body { margin:0; background: <the sheet color — #fff unless the design calls for a tinted sheet> }. .doc { box-sizing:border-box; max-width:8.5in; margin:0 auto; background:inherit; padding:48px clamp(24px,5vw,0.75in) 96px } — border-box + 8.5in + 0.75in padding = a 7in column on screen matching the sheet; keep .doc's background identical to body (a different one paints a visible gutter on wide windows) and add no box-shadow or border. .doc-frame { width:100%; border-collapse:collapse } and .doc-frame td { padding:0 }. Hide print-only chrome on screen: .running-hdr,.running-ftr,.hdr-space,.ftr-space { display:none }. Headings text-wrap:balance; body p/li text-wrap:pretty.
- @page { size:letter; margin:0 } — the 0 is load-bearing: any nonzero @page margin re-opens the slot Chrome stamps its own date/URL/page-count into. Change size freely (letter/A4); keep margin 0 and supply margins as padding.
- @media print block:
    html { -webkit-print-color-adjust:exact; print-color-adjust:exact }
    html, body { margin:0; padding:0; height:auto !important }
    .doc { max-width:none !important; margin:0 !important; padding:0 0.75in !important; box-shadow:none !important; border:none !important }
  Full-bleed background: when the sheet background is anything other than white, set that SAME color on html, body AND .doc (screen and print) — a tinted .doc over a white body leaves white bands at the page edges and between printed pages. The spacer cells (.hdr-space/.ftr-space) inherit the table background; give .doc-frame the sheet color too so the top/bottom margin bands print tinted, not white.
    .hdr-space, .ftr-space { display:table-cell; height:0.75in !important }
    h1,h2,h3,h4,h5,h6 { break-after:avoid }
    figure, pre, blockquote, img, svg, tr { break-inside:avoid }
    p, li { orphans:3; widows:3 }
    .screen-only { display:none !important }
  CRITICAL height reset: the preview is pinned to one viewport tall on screen, so any full-height container (html/body above, plus every 100vh/100dvh/min-height:100vh wrapper YOU add for on-screen centering) must be reset to height:auto here — otherwise the whole multi-page flow is trapped inside a single printed page and the PDF comes out as one crammed sheet. Add each block container you create (cards, callouts, stat tiles, multi-column groups) to the break-inside:avoid list so it stays whole across a page boundary; mark on-screen-only chrome (toolbars, download buttons) class="screen-only".
- Running header/footer OFF by default — the body's own h1 already names the document. Only add them when asked or when the type calls for it (a long formal report, a brief needing a classification mark on every page): small muted uppercase type, no rule, position:fixed inside the 0.75in spacer band (.running-hdr top:0; padding:0.35in 0.75in 0 — .running-ftr bottom:0; padding:0 0.75in 0.35in), title left, short context right, footer different from header, never a "Page" label.
- Page numbers OFF by default (they only render via @page margin boxes, which need a nonzero @page margin that re-opens Chrome's own header slot). Only when explicitly asked: switch to @page { size:letter; margin:0.6in; @bottom-right { content: counter(page) " of " counter(pages); font:10px sans-serif; color:#999 } }, move the .doc print padding to 0, and tell the user to untick "Headers and footers" in the print dialog.
- Typography: 14-16px body, line-height 1.55-1.7, clear hierarchy, restrained palette, 12pt floor for print. Tables get a header row and hairline borders; figures and code blocks each carry a short caption. Links resolve to body ink at print. Keep body copy in real, editable elements so the user can retype directly.`,

  presentation: `presentation:
- Ask for the talk's length in minutes and the intended aesthetic if they aren't given. Target a fixed design canvas (e.g. 1920x1080).
- Author the deck as a single <deck-stage> element with one <section data-label="…"> per slide. The host shows one slide at a time and paginates it (arrow / PageUp-Down / Space / Home / End / digit keys, R to restart, plus a dot pager), and contain-fits the whole stage — declare the aspect with <meta name="design-fixed-size" content="1920,1080"> or width/height attributes on <deck-stage>, so it letterboxes cleanly at any pane size.
- The stage absolutely positions and sizes every slide for you: do NOT set position/inset/width/height on the <section> elements — just give each its own background and content. Inactive slides stay mounted, so any video/form state survives navigation. For entrance animations, make the visible end-state the base style and animate from hidden gated on the [data-deck-active] attribute the host sets on the current slide, so print and reduced-motion still show content.
- Outline the full title sequence first as a storytelling pass — the titles alone should carry the narrative. Commit to one grammatical title style and steer clear of the AI tells (verdict titles, "it's not X, it's Y", manufactured suspense, punchlines).
- Set a type and spacing scale up front and reuse it everywhere; hold to one or two background colors and one or two type pairings; keep section dividers identical and repeated elements in fixed positions.
- Anchor content with align-items:flex-start and leave deliberate open space in the bottom third — resist the web reflex to center everything vertically.
- Keep text per slide sparse and make each slide land its point on its own; decide what becomes a table, a big number, a quote, a diagram, or a full-bleed image. Body text stays large (roughly 24px and up, titles ~48px and up); convert any size given in points to pixels (multiply by 1.333).
- Author slides as static, directly-editable markup — each text run its own leaf element — and reserve scripted slides for behavior plain markup can't deliver. Put per-slide speaker notes in a data-speaker-notes attribute on the <section> — the presenter view reads that attribute to show the current slide's notes to a live speaker.
- Write entrance animations so the visible end-state is the base style and the motion runs from hidden, gated on reduced-motion, so print and reduced-motion still show everything.`,

  wireframe: `wireframe:
- Go for breadth over polish: produce several (3-5) genuinely distinct structural approaches — different layouts, flows, or interaction models, never reskins of one idea — each as its own screen so they sit side-by-side on the canvas for comparison.
- Keep fidelity deliberately low — black-and-white with at most a single accent, simple boxes and lines standing in for components, greeked or generic placeholder copy instead of finished words, system or sketchy hand-drawn-but-readable type — so attention stays on structure and flow, not surface.
- Storyboard a journey as a sequence of separate screens showing each step or state, not a single isolated screen.
- Label each approach clearly so every option is identifiable when the user weighs them against each other.
- Treat low fidelity as a layout-and-functionality guide; once the user picks a direction, real styling and the design system come later at higher fidelity.`,

  tweakable: `tweakable:
- Declare 2-3 high-impact controls as JSON in <script type="application/json" data-design-controls>{...}</script>. The JSON object is keyed by a stable control name. Each entry has label, type ("text"|"color"|"number"|"range"|"boolean"|"select"), default, and may add options [{ label, value }], min/max/step, section, cssVar, or attr.
- Use controls for modes, layout treatments, behavior, and coordinated visual shifts that direct text or color editing cannot express. Do not expose one control per raw CSS property.
- The host applies cssVar to :root and attr to <html>, then dispatches design-control-change on window with { name, value } in event.detail. Prefer CSS bindings; listen for the event only when behavior requires JavaScript.
- Give every control a working default and keep the document's ordinary CSS and markup aligned with it so the screen is correct before host boot.`,

  api_integration: `api_integration:
- Integrate real-time AI capabilities by calling window.ai.complete(prompt), which returns a Promise<string> containing the response. Always handle Promise rejection/errors gracefully and provide local canned fallbacks.
- Model realistic loading states, latency, and streaming: use loading skeletons, progress indicators, and character-by-character text reveals to keep the experience smooth.
- Never call external network APIs from the prototype; use window.ai.complete(prompt) or fall back to local scripted state machines.
- Build robust failure and error paths, including input resets, error message UI, and fallback responses if the query fails or is not supported.
- Keep the logic focused on the interface: update lists, toggle modes, and echo responses directly in context; the goal is demonstrating high-fidelity interaction.`,

  design_system: `design_system:
- Establish the foundations first as design tokens: a typography scale, spacing units, shadow levels, and a semantic color system (background/surface/text/accent roles, not raw color names).
- Present the system as specimen pages — one section per foundation (type ramp, color swatches with roles, spacing scale) and one per component family, each shown in its real states (default/hover/disabled).
- Declare every token as a CSS custom property on :root so pages built on the system inherit it directly, and expose the key ones through window.DESIGN_TOKENS for host editor tweaks.
- Provide reusable component and layout patterns (headers, cards, grids, section starters) styled exclusively through the tokens so brand alignment survives reuse.`,
};
