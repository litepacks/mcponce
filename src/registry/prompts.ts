import type { PromptDefinition } from '../types.js';
import { validatePromptName } from '../utils/validation.js';

export class PromptRegistry<TContext = unknown> {
  private prompts = new Map<string, PromptDefinition<any, TContext>>();

  register(prompt: PromptDefinition<any, TContext>): void {
    validatePromptName(prompt.name);
    this.prompts.set(prompt.name, prompt);
  }

  get(name: string): PromptDefinition<any, TContext> | undefined {
    return this.prompts.get(name);
  }

  getAll(): PromptDefinition<any, TContext>[] {
    return Array.from(this.prompts.values());
  }

  has(name: string): boolean {
    return this.prompts.has(name);
  }
}
