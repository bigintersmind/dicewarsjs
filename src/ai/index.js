/**
 * AI index: re-exports aiConfig.js in full (the registry, its helpers, and the
 * load_* loaders). Strategy implementations are not exported here; they load
 * on demand through getAIImplementation() or the loaders.
 */
export * from './aiConfig.js';
