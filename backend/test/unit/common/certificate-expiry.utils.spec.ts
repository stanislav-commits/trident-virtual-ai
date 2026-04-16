import {
  extractCertificateExpiryEntries,
  extractCertificateExpiryTimestamps,
  extractFirstCertificateExpiryTimestamp,
  isBroadCertificateSoonQuery,
  parseCertificateDateToken,
  stripHtmlLikeMarkup,
} from '../../../src/common/certificate-expiry.utils';

describe('certificate-expiry utils', () => {
  it('detects broad upcoming certificate expiry questions', () => {
    expect(isBroadCertificateSoonQuery('which certificates expire soon?')).toBe(
      true,
    );
    expect(isBroadCertificateSoonQuery('show certificate details')).toBe(false);
  });

  it('parses numeric and month-name certificate date tokens as UTC dates', () => {
    expect(parseCertificateDateToken('09.01.2026')).toBe(
      Date.UTC(2026, 0, 9),
    );
    expect(parseCertificateDateToken('9 January 2026')).toBe(
      Date.UTC(2026, 0, 9),
    );
  });

  it('extracts sorted unique expiry timestamps from text', () => {
    const text =
      'Expiry date: 09.01.2026. Valid until 10 February 2025. Expires on 09.01.2026.';

    expect(extractCertificateExpiryTimestamps(text)).toEqual([
      Date.UTC(2025, 1, 10),
      Date.UTC(2026, 0, 9),
    ]);
  });

  it('keeps first-match behavior for citation ranking callers', () => {
    const text =
      'Expiry date: 09.01.2026. Valid until 10 February 2025.';

    expect(extractFirstCertificateExpiryTimestamp(text)).toBe(
      Date.UTC(2026, 0, 9),
    );
  });

  it('strips simple HTML-like markup before extraction', () => {
    const text = '<p>Valid&nbsp;until: 10 February 2025</p>';

    expect(stripHtmlLikeMarkup(text)).toBe('Valid until: 10 February 2025');
    expect(extractCertificateExpiryEntries(text)).toEqual([
      {
        timestamp: Date.UTC(2025, 1, 10),
        displayDate: '10 February 2025',
      },
    ]);
  });
});
