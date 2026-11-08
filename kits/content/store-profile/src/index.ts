export { analyzeStore, shapeProfile, factsFromProfile, PROFILER_PROMPT } from "./profile.js";
export type { StoreInput, StyleProfile, Product, Fact, AnalyzeOptions, StoreProfileResult } from "./profile.js";
export { openAiAsk, askJson, extractJson, userMessage, AskError } from "./openai-ask.js";
export type { Ask, AskOptions, Message, ContentPart, UserInput, OpenAiAskOptions, AskJsonRequest } from "./openai-ask.js";
export { block, RULES } from "./text.js";
