import { describe, expect, it } from 'vitest';
import { deriveGateReason } from '../gate-reason.js';

describe('deriveGateReason', () => {
  it('flags archive/delete/void/remove actions as a destructive action', () => {
    expect(deriveGateReason({ actions: ['contacts.archive_contact'], affectedCount: 3, targetSample: [], description: '' })).toBe(
      'Destructive action',
    );
    expect(deriveGateReason({ actions: ['leads.delete_lead'], affectedCount: 1, targetSample: [], description: '' })).toBe(
      'Destructive action',
    );
    expect(deriveGateReason({ actions: ['coupons.void_coupon'], affectedCount: 2, targetSample: [], description: '' })).toBe(
      'Destructive action',
    );
    expect(deriveGateReason({ actions: ['tags.remove_tag'], affectedCount: 4, targetSample: [], description: '' })).toBe(
      'Destructive action',
    );
  });

  it('flags send/launch/publish actions as an external send', () => {
    expect(
      deriveGateReason({ actions: ['campaigns.launch_segment'], affectedCount: 120, targetSample: [], description: '' }),
    ).toBe('External send');
    expect(deriveGateReason({ actions: ['emails.send_email'], affectedCount: 5, targetSample: [], description: '' })).toBe(
      'External send',
    );
    expect(
      deriveGateReason({ actions: ['posts.publish_announcement'], affectedCount: 1, targetSample: [], description: '' }),
    ).toBe('External send');
  });

  it('falls back to the affected-count threshold sentence for ordinary bulk actions', () => {
    expect(deriveGateReason({ actions: ['leads.bulk_update'], affectedCount: 73, targetSample: [], description: '' })).toBe(
      'Affects 73 records (over the 50-record threshold)',
    );
  });

  it('uses singular "record" for a count of exactly 1', () => {
    expect(deriveGateReason({ actions: ['leads.update_lead_details'], affectedCount: 1, targetSample: [], description: '' })).toBe(
      'Affects 1 record (over the 50-record threshold)',
    );
  });

  it('labels an "un"-prefixed external verb (unpublish) as a retraction, NOT an external send', () => {
    // Regression: the bare `publish` substring in `unpublish` used to
    // mis-label a retraction as "External send".
    expect(
      deriveGateReason({ actions: ['posts.unpublish_announcement'], affectedCount: 1, targetSample: [], description: '' }),
    ).toBe('Destructive action');
    expect(
      deriveGateReason({ actions: ['campaigns.unsend_blast'], affectedCount: 3, targetSample: [], description: '' }),
    ).toBe('Destructive action');
    expect(
      deriveGateReason({ actions: ['posts.unschedule_post'], affectedCount: 2, targetSample: [], description: '' }),
    ).toBe('Destructive action');
  });

  it('still labels a genuine re-publish/re-send as an external send (only the "un" negation is a retraction)', () => {
    expect(
      deriveGateReason({ actions: ['posts.republish_announcement'], affectedCount: 1, targetSample: [], description: '' }),
    ).toBe('External send');
  });

  it('prefers destructive over external when a scope somehow carries both signals', () => {
    expect(
      deriveGateReason({ actions: ['leads.delete_lead', 'emails.send_email'], affectedCount: 2, targetSample: [], description: '' }),
    ).toBe('Destructive action');
  });
});
