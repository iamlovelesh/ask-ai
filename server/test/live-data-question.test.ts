import { describe, it, expect } from 'vitest';
import { isLiveDataQuestion } from '../src/loop/agent';

describe('isLiveDataQuestion — a count/total/breakdown about live CRM state', () => {
  const live: string[] = [
    'What is the total value of all open opportunities?',
    'How many open opportunities do we have right now?',
    'Break down all our leads by their status.',
    'What is the total number of leads?',
    'How much revenue is in the pipeline?',
    'count of overdue invoices',
    'average deal value this quarter',
  ];
  for (const q of live) {
    it(`true: "${q.slice(0, 40)}…"`, () => {
      expect(isLiveDataQuestion(q)).toBe(true);
    });
  }

  // Durable, memory-groundable questions — NOT live CRM aggregates.
  const notLive: string[] = [
    'what is my quarterly target?',
    'what date format do I prefer?',
    'who manages my team?',
    'remind me to follow up with lead_2025 on Friday',
    'show me lead_2025',
  ];
  for (const q of notLive) {
    it(`false: "${q.slice(0, 40)}…"`, () => {
      expect(isLiveDataQuestion(q)).toBe(false);
    });
  }
});
