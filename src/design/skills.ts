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
- Decide the pagination shape before building:
  - FLOWING (default for reports, memos, letters, papers, guides): one continuous text flow that the browser paginates at print time.
  - EXPLICIT pages (one-page résumé, poster, certificate, fixed multi-page layout): one <section class="page"> child per printed page.
- Mount the host shell: put the document inside a single <doc-page size="letter" margin="0.75in"> (size="a4" when metric paper is right; orientation="landscape" when needed; width/height only when the user names a custom sheet). The host owns the desk background, white sheet card, repeating header/footer slots, and @page geometry — do NOT hand-write @page rules, body desk backgrounds, or a spacer-table print frame.
- FLOWING shape: write normal static HTML inside <doc-page>; open with the h1 as the first content (no masthead/eyebrow). Optional repeating chrome: <header slot="header">…</header> / <footer slot="footer">…</footer> only when the type needs them (long formal report, classification mark) — small muted uppercase type, title left, short context right, never a "Page" label.
- EXPLICIT shape: each direct child <section class="page"> is one full sheet; design each page to fill the named page box without overflow.
- Fixed canvas scaled onto paper (poster/infographic onto letter): use content-width / content-height on <doc-page> so the host scales the authored artboard onto the printable area.
- PDF export is window.print() — the print CSS IS the PDF. Prefer print-safe type (14–16px body, line-height 1.55–1.7, 12pt floor), real editable text elements, headered tables with hairline borders, captions on figures/code, and links that resolve to body ink at print. Use break-inside:avoid on cards/figures/tables you need whole; mark screen-only chrome class="screen-only".`,

  presentation: `presentation:
- Ask for the talk's length in minutes and the intended aesthetic if they aren't given. Target a fixed design canvas (e.g. 1920x1080).
- Ship the whole deck as ONE .os.html file: one <deck-stage> that contains every slide as a direct child <section data-label="…">. Never split slides into separate files or separate stages — the host paginates the light-DOM sections of that single stage (arrow / PageUp-Down / Space / Home / End / digit keys, R to restart, plus a dot pager) and contain-fits the stage. Declare the aspect with <meta name="design-fixed-size" content="1920,1080"> or width/height attributes on <deck-stage> so it letterboxes cleanly at any pane size.
- The stage absolutely positions and sizes every slide for you. Forbidden on <section> selectors (and on rules that match those sections): position, top/right/bottom/left/inset, margin that repositions the slide. Prefer filling the slide with width/height 100% (or 100% via host geometry) plus flex/grid for inner layout — background, color, and padding only on the section itself. Inactive slides stay mounted, so any video/form state survives navigation. For entrance animations, make the visible end-state the base style and animate from hidden gated on the [data-deck-active] attribute the host sets on the current slide, so print and reduced-motion still show content.
- Outline the full title sequence first as a storytelling pass — the titles alone should carry the narrative. Commit to one grammatical title style and steer clear of the AI tells (verdict titles, "it's not X, it's Y", manufactured suspense, punchlines).
- Set a type and spacing scale up front and reuse it everywhere; hold to one or two background colors and one or two type pairings; keep section dividers identical and repeated elements in fixed positions.
- Anchor content with align-items:flex-start and leave deliberate open space in the bottom third — resist the web reflex to center everything vertically.
- Keep text per slide sparse and make each slide land its point on its own; decide what becomes a table, a big number, a quote, a diagram, or a full-bleed image. Body text stays large (roughly 24px and up, titles ~48px and up); convert any size given in points to pixels (multiply by 1.333).
- Author slides as static, directly-editable markup — each text run its own leaf element — and reserve scripted slides for behavior plain markup can't deliver. Put per-slide speaker notes in a data-speaker-notes attribute on the <section> — the presenter view reads that attribute to show the current slide's notes to a live speaker.
- Write entrance animations so the visible end-state is the base style and the motion runs from hidden, gated on reduced-motion, so print and reduced-motion still show everything.`,

  wireframe: `wireframe:
- Go for breadth over polish: produce several (3-5) genuinely distinct structural approaches — different layouts, flows, or interaction models, never reskins of one idea.
- Lay options as a vertical stack of turns in one .os.html (or one section per turn): newest exploration at the top; tag every option with a stable id the user can cite in chat (e.g. 1a, 1b, 2a). Cross-link later turns back to earlier ids when refining.
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

  resume: `resume:
- Ship a print-ready CV as one continuous .os.html reading column. Use the document host shell: a single <doc-page size="letter" margin="0.75in"> (or size="a4") with either flowing content or one <section class="page"> when the brief is strictly one sheet. Do not invent a different print frame or hand-write @page rules.
- Open with name, target role, and contact. Add a short summary only when it earns the real estate. Standard sections: work history, education, skills; projects or publications only when they carry weight for the brief.
- Work history is newest-first: employer, title, dates, and a few outcome-led bullets with numbers when available. Group skills; do not spray tool names.
- Keep type calm and print-safe (about 10–12pt body). Avoid multi-column games unless the layout is print-proven. Skip ornamental sidebars unless the user wants a designed variant.
- Missing facts stay missing — ask rather than invent employers, dates, or metrics.`,

  research: `research:
- Treat the brief as an investigation, not a design-first exercise. Call web_search and web_fetch until the claim set is grounded; do not design the report from memory alone.
- Breadth before synthesis: several distinct searches (a practical floor is four; keep going while new angles appear), each aimed at a concrete sub-question. Prefer primary material (specs, standards bodies, filings, vendor docs, peer-reviewed work) over secondary recaps. Reconcile conflicting numbers in the prose instead of averaging them away.
- Track claim → URL → as-of date while researching. In the artifact, link substantive statements, stamp time-sensitive figures, and mark inference separately from sourced fact.
- Default artifact: one self-contained .os.html report — open with the takeaways, then evidence-backed sections, then a linked bibliography. Editorial typography, selective pull-quotes, charts only when the data needs them. If PDF export is likely, inherit the document print rules.
- End the search when returns go circular. Thin or contested evidence must be labeled as such.`,

  object3d: `object3d:
- Deliver a single .os.html that mounts the host viewer <three-d-stage> and a module that only builds the model. Do not reimplement the camera chrome, lighting, or exporters — the stage owns orbit/zoom/pan, studio light, ground contact shadow, auto-frame, and OBJ+MTL / GLB download.
- Put a closed import map in <head> pinned to three@0.184.0 for three, OrbitControls, OBJExporter, and GLTFExporter only (the stage loads those modules through the map). No second three copy, no extra addons.
- Page skeleton: full-viewport body, one <three-d-stage name="…"> (optional background / autorotate attrs), then a type=module script that awaits customElements.whenDefined("three-d-stage"), then stage.ready, builds a named THREE.Group, and calls stage.setObject(group).
- Build from composed primitives (box, cylinder, sphere, torus, lathe, extrude) before raw BufferGeometry. Share a small MeshStandardMaterial set (a few materials total) with intentional roughness/metalness. Prefer form and material color over textures — texture detail does not round-trip through OBJ. NAME every mesh and material so exports stay usable.
- Units are meters, y-up, origin-centered, resting on the lowest y. Nudge coplanar faces slightly to avoid z-fighting. Smooth curves need enough radial segments on visible features.
- If the user asks for FBX/USDZ/STEP, say the stage exports OBJ+MTL and GLB only.
- Review via canvas screenshots after module reloads; judge silhouette and material separation first.`,

  email: `email:
- Build one client-resilient HTML mail as .os.html: nested tables for structure, styles inline, content column near 600px, fonts with safe fallbacks. Do not depend on flex/grid for the primary frame.
- Inbox-first hierarchy: scannable open, one clear primary action, controls large enough for touch. Favor opaque backgrounds and explicit text colors — translucent stacks break in many clients.
- Marketing mail may include logo header, body blocks, and a quiet legal/unsubscribe footer; transactional mail stays minimal.
- Images declare width, height, and alt. Critical content must not live only in CSS backgrounds. Assume no script and a narrow CSS subset (Gmail/Outlook class of clients).
- Output should paste cleanly into a mail platform; no authoring comments in the rendered body.`,

  flier: `flier:
- One fixed sheet with a single job: communicate the message at a glance. Hierarchy is headline → supporting line → essentials (time/place/action) → secondary detail.
- Mount the host shell as exactly one explicit page: <doc-page size="letter" margin="0.5in"><section class="page" id="flier">…</section></doc-page> (size/margin may change for A4/square when asked). The host owns the page box and print geometry — do NOT hand-write @page rules or a multi-page flow.
- Composition is bold: large type, real empty space, one dominant visual. Refuse long website-style section stacks. Print-safe contrast and type (body at least ~12pt), margins that survive trim.
- For events and promos, the date or call-to-action must land in the first look.`,

  brochure: `brochure:
- Mount the host shell as a landscape print piece: exactly one <doc-page size="letter" orientation="landscape"> with two explicit children <section class="page"> — first Outside (back / flap / cover in fold order), second Inside (three interior panels). The host owns the sheet, desk, and print geometry — do NOT hand-write @page rules or fake multi-page flows.
- Each page is a three-column panel grid matching letter-landscape stock. Keep load-bearing type off the fold gutters. Sequence copy for how the piece opens, not only left-to-right on the flat.
- Optional dashed fold guides at the 1/3 and 2/3 verticals (export-hideable via a design control when useful). Short blocks, one shared visual system, print-ready contrast.`,

  website: `website:
- Marketing or product landing as responsive .os.html screen(s): hero, supporting sections, footer. Web UI conventions apply; load interface craft for fidelity.
- Above the fold: value proposition and primary action. Section rhythm is deliberate — avoid repeated identical card grids.
- One depth mechanism, a decisive type pair, a hue-led palette. Mobile layout and ≥44px targets are required.
- Keep interactive demos front-end local unless the user asks for multi-screen app state (then prototype).`,

  social: `social:
- Fixed artboards sized to the platform (square post, vertical story, landscape link card, etc.). One idea per frame; type must read on a phone.
- Carousels are a sequence under one system that advances the story. Leave safe margins where platform chrome eats the edge.
- Use provided brand marks; otherwise invent a small system and hold it. No micro type, no cluttered widget piles.
- For imagery the user should supply or replace, mount <image-slot> with a stable unique id and a specific placeholder. Choose shape="rect"|"rounded"|"circle"|"pill" or radius; the host owns file picking, drag-and-drop, replacement, and reload persistence. Size the slot through its container unless the artboard requires fixed dimensions.
- Each frame is its own .os.html artboard; set design-fixed-size when it helps the host frame the canvas.`,

  dataviz: `dataviz:
- Start from the question the graphic must answer, then pick a form that fits (bar, line, area, scatter, heatmap, small multiples). Do not costume weak data as decorative charts.
- Prefer direct labels; always show units, provenance, and date. Position/length beat hue for encoding; keep palettes colorblind-safe; call out the outliers that matter.
- Ship as .os.html: graphic plus a short written takeaway. Draw with SVG or light CSS/JS unless complexity forces a library.
- Placeholder numbers must be labeled as such — request real data before treating the piece as final.`,

  pairing: `pairing:
- Output specimen boards that compare color and type systems, not full marketing pages. Present a few named options (side by side or as separate screens), each with swatches (hex/oklch), display/text samples at several sizes, and a tiny applied snippet.
- Contrast the options deliberately so a direction is choosable (e.g. warm editorial vs cool technical).
- Sample words should relate to the brief; skip filler sections that do not help judgment.`,

  diagram: `diagram:
- Render systems, flows, architecture, org, or journeys as clear HTML/SVG diagrams. Labels first; nodes consistent; edge direction unambiguous.
- Prefer orthogonal flows (left→right or top→bottom). Cluster related nodes. Use line style sparingly (solid primary, dashed secondary). Split overcrowded graphs into layers.
- One visual system for fills, strokes, type, and spacing. Deliver a single .os.html artboard for capture or print.
- If entities or relations are unknown, ask before inventing a large topology.`,
};
