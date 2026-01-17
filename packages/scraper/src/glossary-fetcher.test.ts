import fetchMock from 'fetch-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchGlossary, GLOSSARY_URL } from './glossary-fetcher';

describe('glossary-fetcher', () => {
  beforeEach(() => {
    fetchMock.mockGlobal();
  });

  afterEach(() => {
    fetchMock.unmockGlobal();
    fetchMock.removeRoutes();
    fetchMock.clearHistory();
  });

  describe('fetchGlossary', () => {
    it('fetches from the correct URL with proper headers', async () => {
      fetchMock.get(GLOSSARY_URL, { body: '' });

      await fetchGlossary();

      const calls = fetchMock.callHistory.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(GLOSSARY_URL);
      expect(calls[0].options?.headers).toHaveProperty('user-agent');
    });

    it('throws an error when response is not ok', async () => {
      fetchMock.get(GLOSSARY_URL, { status: 404 });

      await expect(fetchGlossary()).rejects.toThrow(
        'Failed to fetch glossary: 404',
      );
    });

    it('parses simple CSV entries', async () => {
      const csv = `Japanese,English
スライム,Slime
ドラキー,Dracky`;

      fetchMock.get(GLOSSARY_URL, { body: csv });

      const entries = await fetchGlossary();

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        japanese_text: 'スライム',
        english_text: 'Slime',
      });
      expect(entries[1]).toEqual({
        japanese_text: 'ドラキー',
        english_text: 'Dracky',
      });
    });

    it('skips the header row', async () => {
      const csv = `Japanese,English
テスト,Test`;

      fetchMock.get(GLOSSARY_URL, { body: csv });

      const entries = await fetchGlossary();

      expect(entries).toHaveLength(1);
      expect(entries[0].japanese_text).toBe('テスト');
    });

    it('handles English text containing commas (splits on first comma only)', async () => {
      const csv = `武器,Weapon, including swords, axes, and more`;

      fetchMock.get(GLOSSARY_URL, { body: csv });

      const entries = await fetchGlossary();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        japanese_text: '武器',
        english_text: 'Weapon, including swords, axes, and more',
      });
    });

    it('skips empty lines', async () => {
      const csv = `テスト1,Test1

テスト2,Test2

`;

      fetchMock.get(GLOSSARY_URL, { body: csv });

      const entries = await fetchGlossary();

      expect(entries).toHaveLength(2);
    });

    it('skips lines without commas', async () => {
      const csv = `テスト1,Test1
malformed line without comma
テスト2,Test2`;

      fetchMock.get(GLOSSARY_URL, { body: csv });

      const entries = await fetchGlossary();

      expect(entries).toHaveLength(2);
    });

    it('skips entries with empty Japanese or English text', async () => {
      const csv = `,Empty Japanese
Empty English,
Valid,Entry`;

      fetchMock.get(GLOSSARY_URL, { body: csv });

      const entries = await fetchGlossary();

      expect(entries).toHaveLength(1);
      expect(entries[0].japanese_text).toBe('Valid');
    });

    it('trims whitespace from entries', async () => {
      const csv = `  スペース  ,  Spaces  `;

      fetchMock.get(GLOSSARY_URL, { body: csv });

      const entries = await fetchGlossary();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        japanese_text: 'スペース',
        english_text: 'Spaces',
      });
    });

    it('returns empty array for empty response', async () => {
      fetchMock.get(GLOSSARY_URL, { body: '' });

      const entries = await fetchGlossary();

      expect(entries).toEqual([]);
    });
  });
});
