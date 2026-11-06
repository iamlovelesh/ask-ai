/**
 * Memory-layer types (design §4.1). A memory is a durable, user-scoped fact
 * about the user — a preference, a stated fact, a goal, or context — that
 * is NOT in the CRM. `profile` memories are overwrite-in-place (one live row
 * per `(userId, category, key)`); `collection` memories are deduped-many.
 */

export type MemoryCategory = 'preference' | 'fact' | 'goal' | 'context';
export type MemoryKind = 'profile' | 'collection';
export type MemorySource = 'tool' | 'extract' | 'user';

export interface Memory {
  id: string;
  userId: string;
  scopeRef?: string;
  category: MemoryCategory;
  kind: MemoryKind;
  key?: string;
  body: string;
  source: MemorySource;
  sourceSession?: string;
  sourceSeq?: number;
  createdAt: number;
  updatedAt: number;
  supersededBy?: string;
  invalidAt?: number;
}

export interface NewMemory {
  userId: string;
  category: MemoryCategory;
  kind: MemoryKind;
  key?: string;
  body: string;
  source: MemorySource;
  scopeRef?: string;
  sourceSession?: string;
  sourceSeq?: number;
}

export interface MemoryPatch {
  body?: string;
  category?: MemoryCategory;
}
