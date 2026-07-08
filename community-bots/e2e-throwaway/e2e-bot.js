// Throwaway bot for the post-merge e2e test of the #142 validation split.
// `await` at the top level is valid module syntax (so prettier parses this
// file) but invalid inside the sandbox's function wrapper — so compilation
// FAILS deterministically and the workflow_run commenter must post ❌.
await Promise.resolve();
