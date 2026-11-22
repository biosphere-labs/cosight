// Example additions. They never replace shared guidance or apply themselves.
export const STARTER_PRESETS=Object.freeze([
 {name:'Application overview',instructions:'Explain the purpose of this application, its main modules and boundaries. Start with a diagram of the whole system, then follow one representative request through the relevant code.'},
 {name:'Trace a request',instructions:'Trace one representative request from its entry point to storage or an external service and back. Show the code at each important boundary, including errors and relevant tests.'},
 {name:'Architecture and tradeoffs',instructions:'Explain the architectural patterns already present, dependency direction, cohesion and coupling. Ground possible improvements in actual code and compare useful alternatives with their costs.'},
 {name:'Review a change',instructions:'Explain what the selected change adds, affected callers and data, recorded intent and decisions, compatibility and operational impact. Separate evidence from inferred rationale and proposed alternatives.'},
 {name:'Read a handover',instructions:'Read the selected existing handover document section by section. Explain progress, checkpoints, unresolved work and decisions with diagrams. Find pertinent code and Git evidence where available; use diagram-only stops for conceptual sections.'},
 {name:'Tests and confidence',instructions:'Explain the important behavior and how existing tests exercise it. Identify concrete gaps, error cases and assumptions, and suggest small checks that would improve confidence without duplicating the implementation.'}
]);
