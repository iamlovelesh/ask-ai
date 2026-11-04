/**
 * Word lists and constant pools used by the standard seed generator
 * (`seed.ts`). Kept separate from the generation logic per the "many small
 * files" convention — this file is pure data, no randomness, no I/O.
 */

export const FIRST_NAMES: readonly string[] = [
  'Ava', 'Liam', 'Maya', 'Noah', 'Priya', 'Ethan', 'Mia', 'Leo', 'Zoe', 'Omar',
  'Isla', 'Kai', 'Nora', 'Arjun', 'Lucia', 'Theo', 'Amara', 'Felix', 'Hana', 'Dante',
  'Elena', 'Sam', 'Ingrid', 'Rohan', 'Chloe', 'Marcus', 'Freya', 'Jian', 'Ruby', 'Tariq',
  'Olivia', 'Yusuf', 'Sofia', 'Declan', 'Aisha', 'Mateo', 'Greta', 'Kenji', 'Lena', 'Victor',
];

export const LAST_NAMES: readonly string[] = [
  'Okafor', 'Nguyen', 'Petrov', 'Garcia', 'Larsen', 'Haddad', 'Kowalski', 'Mehta', 'Dubois', 'Costa',
  'Fischer', 'Silva', 'Novak', 'Osei', 'Rossi', 'Tanaka', 'Ibrahim', 'Schmidt', 'Reyes', 'Lindqvist',
  'Choudhury', 'Kim', 'Moreau', 'Johansson', 'Abara', 'Nakamura', 'Alvarez', 'Berg', 'Hassan', 'Volkov',
];

export const CITIES: readonly { city: string; country: string }[] = [
  { city: 'Austin', country: 'US' },
  { city: 'Denver', country: 'US' },
  { city: 'Seattle', country: 'US' },
  { city: 'Toronto', country: 'CA' },
  { city: 'London', country: 'GB' },
  { city: 'Manchester', country: 'GB' },
  { city: 'Berlin', country: 'DE' },
  { city: 'Munich', country: 'DE' },
  { city: 'Lisbon', country: 'PT' },
  { city: 'Madrid', country: 'ES' },
  { city: 'Amsterdam', country: 'NL' },
  { city: 'Dublin', country: 'IE' },
  { city: 'Singapore', country: 'SG' },
  { city: 'Sydney', country: 'AU' },
  { city: 'Melbourne', country: 'AU' },
  { city: 'Bangalore', country: 'IN' },
  { city: 'Mumbai', country: 'IN' },
  { city: 'Nairobi', country: 'KE' },
  { city: 'Sao Paulo', country: 'BR' },
  { city: 'Mexico City', country: 'MX' },
];

export const COMPANY_PREFIXES: readonly string[] = [
  'Nimbus', 'Bluepeak', 'Vertex', 'Northwind', 'Orbit', 'Granite', 'Cobalt', 'Lumen', 'Harbor', 'Fleet',
  'Ironleaf', 'Clearwater', 'Summit', 'Redstone', 'Beacon', 'Driftwood', 'Anchor', 'Catalyst', 'Meridian', 'Pinecrest',
];

export const COMPANY_SUFFIXES: readonly string[] = [
  'Robotics', 'Systems', 'Software', 'Logistics', 'Health', 'Foods', 'Analytics', 'Studios', 'Dynamics', 'Partners',
  'Labs', 'Works', 'Group', 'Collective', 'Networks', 'Ventures',
];

export const INDUSTRIES: readonly string[] = [
  'Software', 'Healthcare', 'Retail', 'Manufacturing', 'Finance', 'Education', 'Logistics',
  'Real Estate', 'Media', 'Hospitality', 'Nonprofit', 'Energy',
];

export const COMPANY_SIZES: readonly string[] = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];

export const EMAIL_DOMAINS: readonly string[] = ['gmail.com', 'outlook.com', 'yahoo.com', 'proton.me', 'icloud.com'];

export const LEAD_SOURCES: readonly string[] = [
  'facebook', 'google', 'referral', 'website', 'organic', 'event', 'cold_call', 'partner',
];

export const TASK_TITLES: readonly string[] = [
  'Follow up on proposal', 'Send pricing deck', 'Schedule demo call', 'Confirm renewal terms',
  'Review contract redlines', 'Check in after onboarding', 'Prepare QBR deck', 'Collect missing invoice info',
  'Chase overdue payment', 'Draft custom quote', 'Reconnect after trial expiry', 'Update CRM record',
  'Escalate support issue', 'Coordinate implementation kickoff', 'Send satisfaction survey',
];

export const NOTE_SNIPPETS: readonly string[] = [
  'Had a great call, strong interest in the enterprise tier.',
  'Budget approved for next quarter, revisit in January.',
  'Prefers email over phone, mentioned timezone constraints.',
  'Competitor mentioned by name, sent comparison sheet.',
  'Technical stakeholder joined the call, deep product questions.',
  'Asked for case studies in their vertical.',
  'Renewal at risk, champion left the company.',
  'Upsell opportunity flagged for add-on modules.',
];

export const EVENT_NAMES: readonly string[] = [
  'Product Roadmap Webinar', 'Customer Summit', 'Partner Kickoff', 'Regional User Meetup',
  'Quarterly Town Hall', 'Onboarding Workshop', 'Industry Panel', 'Annual Conference',
];

export const PRODUCT_WORDS: readonly string[] = [
  'Starter', 'Growth', 'Pro', 'Enterprise', 'Core', 'Suite', 'Connect', 'Insights',
  'Automation', 'Analytics', 'Essentials', 'Platform',
];

export const BLOG_TOPICS: readonly string[] = [
  'How teams scale customer support', 'Five lessons from our best customers', 'Behind the roadmap',
  'Why automation matters in 2026', 'A guide to onboarding new reps', 'Field notes from our users',
];

export const COURSE_TOPICS: readonly string[] = [
  'CRM Fundamentals', 'Advanced Pipeline Management', 'Customer Success Playbook', 'Sales Negotiation Tactics',
  'Marketing Automation 101', 'Support Ticket Triage', 'Onboarding New Reps', 'Data-Driven Forecasting',
];

export const TEAM_NAMES: readonly string[] = [
  'Enterprise Sales', 'SMB Sales', 'Customer Support', 'Customer Success', 'Marketing', 'Onboarding',
];
