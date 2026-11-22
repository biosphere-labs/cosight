// Docker/SSH-worker entry point: launches only headless Chromium and a real Node
// tour-server, with ephemeral port and isolated temporary project/app-data.
// Requires the matching Playwright Chromium binary and Linux system dependencies.
// This does not start Electron, access the desktop preload, or alter an installed app.
process.env.COSIGHT_TEST_HEADLESS='1';
const {runWorkspacePluginsTest}=require('./workspace-plugins-electron.cjs');
runWorkspacePluginsTest().catch(error=>{console.error(error);process.exitCode=1;});
