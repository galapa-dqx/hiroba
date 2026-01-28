import { useState } from 'react';

import { lookupGlossary, type GlossaryMatch } from '../lib/api';

export default function GlossaryLookup() {
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<GlossaryMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleLookup() {
    if (!text.trim()) return;

    setLoading(true);
    try {
      const { matches } = await lookupGlossary(text.trim());
      setMatches(matches);
      setSearched(true);
    } catch (err) {
      alert('Failed to lookup glossary terms');
      console.error(err);
    }
    setLoading(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && e.metaKey) {
      handleLookup();
    }
  }

  return (
    <div className="glossary-lookup">
      <div className="input-section">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Paste Japanese text here to find matching glossary terms..."
          rows={8}
        />
        <div className="actions">
          <button onClick={handleLookup} disabled={loading || !text.trim()}>
            {loading ? 'Searching...' : 'Find Matches'}
          </button>
          <span className="hint">Cmd+Enter to search</span>
        </div>
      </div>

      {searched && (
        <div className="results-section">
          <h3>
            {matches.length === 0
              ? 'No matches found'
              : `Found ${matches.length} matching term${matches.length === 1 ? '' : 's'}`}
          </h3>

          {matches.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Japanese</th>
                  <th>English</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match) => (
                  <tr key={match.sourceText}>
                    <td className="jp-text">{match.sourceText}</td>
                    <td>{match.translatedText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
