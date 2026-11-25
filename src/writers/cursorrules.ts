import { agentsMarkdown } from "./agents-md.ts";
import type { Store } from "../store.ts";
export function cursorRules(store: Store, project: string): string { return agentsMarkdown(store, project); }
