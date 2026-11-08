export { findOpportunities, marketQueries, OPPORTUNITY_PROMPT, OPPORTUNITY_KINDS } from "./ideas.js";
export type { StyleProfile, Item, SearchResult, Search, ShopperDemand, Opportunity, OpportunityKind, QueryOptions, FindInput, FindOptions, FindResult } from "./ideas.js";
export { openAiAsk, askJson, extractJson, userMessage, AskError } from "./openai-ask.js";
export type { Ask, AskOptions, Message, ContentPart, UserInput, OpenAiAskOptions, AskJsonRequest } from "./openai-ask.js";
export { block, RULES } from "./text.js";
