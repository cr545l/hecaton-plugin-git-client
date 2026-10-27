// Existing command/UI tests supply a result-producing host double. Keep those
// tests at the command boundary; git-process.test.js covers spawn/event transport
// (including real Git) and verifies that production never falls back to exec.
require('../../git-process').run = params => require('../../permissions').execGit(params);
