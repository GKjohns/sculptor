export default defineAppConfig({
  ui: {
    colors: { primary: 'amber', neutral: 'stone' }
  },
  // A commission's defaults, as the study's gate left them (implementation plan, Sprint 2).
  // ?model=, ?planner=, ?ref=0|1, ?turns=, ?usd= and ?speed= override them for one page load.
  sculptor: {
    toolSet: 'formed' as 'direct' | 'formed',
    // Draw a hidden reference sheet before the first cut. ?ref=1 also shows it in the Sculptor's eye.
    reference: true,
    model: 'opus',
    // A second sculptor for the opening turns (plan, form, first rough-out); '' for none. ?planner= overrides it.
    planner: '',
    maxTurns: 60,
    maxUsd: 8,
    // The transport's speed a commission opens on.
    speed: 4
  }
})
