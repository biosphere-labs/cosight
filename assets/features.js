// Experimental analyzers are opt-in for the whole app, independently of saved
// per-project enablement. Their existing settings and results are preserved.
export const features={analysisPlugins:process.env.COSIGHT_EXPERIMENTAL_PLUGINS==='1',workspacePlugins:true};
