import { useState } from 'react';

import { importGlossary, importGlossaryFromGitHub } from '../lib/api';

export default function GlossaryImport() {
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState('en');
  const [importing, setImporting] = useState(false);
  const [importingGitHub, setImportingGitHub] = useState(false);
  const [preview, setPreview] = useState<string[]>([]);

  async function handleGitHubImport() {
    if (
      !confirm(
        'This will replace all glossary entries with the latest from GitHub. Continue?',
      )
    ) {
      return;
    }

    setImportingGitHub(true);
    try {
      const result = await importGlossaryFromGitHub();
      alert(`Imported ${result.imported} entries from GitHub`);
      window.location.href = '/glossary';
    } catch (err) {
      alert('GitHub import failed. Check console for details.');
      console.error(err);
    }
    setImportingGitHub(false);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = e.target.files?.[0] ?? null;
    setFile(selectedFile);

    if (selectedFile) {
      // Preview first few lines
      const text = await selectedFile.text();
      const lines = text
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 5);
      setPreview(lines);
    } else {
      setPreview([]);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setImporting(true);
    try {
      const result = await importGlossary(file, language);
      alert(`Successfully imported ${result.imported} entries`);
      window.location.href = '/glossary';
    } catch (err) {
      alert('Import failed. Check console for details.');
      console.error(err);
    }
    setImporting(false);
  }

  return (
    <div className="import-container">
      <section className="import-section">
        <h3>Import from GitHub</h3>
        <p className="section-description">
          Import the latest glossary from the{' '}
          <a
            href="https://github.com/dqx-translation-project/dqx-custom-translations"
            target="_blank"
            rel="noopener noreferrer"
          >
            dqx-translation-project
          </a>
          . This replaces all existing entries.
        </p>
        <button
          type="button"
          onClick={handleGitHubImport}
          disabled={importingGitHub || importing}
          className="btn-primary"
        >
          {importingGitHub ? 'Importing...' : 'Import from GitHub'}
        </button>
      </section>

      <hr className="divider" />

      <section className="import-section">
        <h3>Import from CSV File</h3>
        <form onSubmit={handleSubmit} className="import-form">
          <div className="form-group">
            <label>CSV File</label>
            <input
              type="file"
              accept=".csv,.txt"
              onChange={handleFileChange}
              disabled={importingGitHub}
            />
          </div>

          {preview.length > 0 && (
            <div className="preview">
              <label>Preview (first 5 lines):</label>
              <pre>
                {preview.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </pre>
            </div>
          )}

          <div className="form-group">
            <label>Target Language</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={importingGitHub}
            >
              <option value="en">English</option>
            </select>
          </div>

          <div className="form-actions">
            <button
              type="submit"
              disabled={!file || importing || importingGitHub}
            >
              {importing ? 'Importing...' : 'Import CSV'}
            </button>
            <a href="/glossary" className="btn-cancel">
              Cancel
            </a>
          </div>
        </form>
      </section>
    </div>
  );
}
