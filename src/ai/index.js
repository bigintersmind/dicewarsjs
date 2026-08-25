/**
 * AI index: re-exports the registry and helpers from aiConfig.js. Strategy
 * implementations are not exported here; they load on demand through
 * getAIImplementation() or the load_* functions.
 */
export * from './aiConfig.js';
