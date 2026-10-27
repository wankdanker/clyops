import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { Label } from './Label';
import { Card, CardContent } from './Card';
import { SCHEMA_SETTINGS_DEFAULTS, type SchemaSettings } from '../lib/schemas';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (scriptsDir: string, templatesDir: string, schemas: SchemaSettings) => Promise<void>;
  currentScriptsDir: string;
  currentTemplatesDir: string;
  currentSchemas?: SchemaSettings;
}

const NUMBERS: { key: 'depth' | 'cache_secs' | 'timeout_secs' | 'max_bytes'; label: string; min: number }[] = [
  { key: 'depth', label: 'Reference depth (0: fetch none)', min: 0 },
  { key: 'cache_secs', label: 'Cache seconds (0: every load)', min: 0 },
  { key: 'timeout_secs', label: 'Timeout seconds', min: 1 },
  { key: 'max_bytes', label: 'Largest schema, bytes', min: 1 },
];

export function SettingsModal({ isOpen, onClose, onSave, currentScriptsDir, currentTemplatesDir, currentSchemas }: SettingsModalProps) {
  const [scriptsDir, setScriptsDir] = useState('');
  const [templatesDir, setTemplatesDir] = useState('');
  const [schemas, setSchemas] = useState<Required<SchemaSettings>>(SCHEMA_SETTINGS_DEFAULTS);
  const [hostsText, setHostsText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setScriptsDir(currentScriptsDir);
      setTemplatesDir(currentTemplatesDir);
      const current = { ...SCHEMA_SETTINGS_DEFAULTS, ...currentSchemas };
      setSchemas(current);
      setHostsText(current.hosts.join(', '));
      setError(null);
    }
  }, [isOpen, currentScriptsDir, currentTemplatesDir, currentSchemas]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!scriptsDir.trim()) {
      setError('Please provide a scripts directory path');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const hosts = hostsText.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
      await onSave(scriptsDir.trim(), templatesDir.trim(), { ...schemas, hosts });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold">Settings</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={isSaving}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          <div className="space-y-6">
            {/* Scripts Directory */}
            <div>
              <Label htmlFor="scriptsDir">Scripts Directory</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Directory containing your clyops tools. Every executable in it is listed.
              </p>
              <Input
                id="scriptsDir"
                type="text"
                value={scriptsDir}
                onChange={(e) => setScriptsDir(e.target.value)}
                placeholder="/path/to/tools"
                disabled={isSaving}
                className="w-full"
              />
              <div className="bg-accent/50 rounded px-3 py-2 mt-2">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">Priority:</span> CLYOPS_RUNNER_DIR env → saved config
                </p>
              </div>
            </div>

            {/* Templates Directory */}
            <div>
              <Label htmlFor="templatesDir">Templates Directory</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Path where templates are stored. Leave empty to use the default app data directory.
              </p>
              <Input
                id="templatesDir"
                type="text"
                value={templatesDir}
                onChange={(e) => setTemplatesDir(e.target.value)}
                placeholder="(default: app data directory)"
                disabled={isSaving}
                className="w-full"
              />
              <div className="bg-accent/50 rounded px-3 py-2 mt-2">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">Priority:</span> CLYOPS_RUNNER_TEMPLATES_DIR env → saved config → app data dir
                </p>
              </div>
            </div>

            {/* URL schemas */}
            <div>
              <Label>URL schemas</Label>
              <p className="text-xs text-muted-foreground mb-2">
                A json:SCHEMA input's URL schema is fetched when a tool loads, so the form checks it, as clyops-api does.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={schemas.fetch} disabled={isSaving}
                  onChange={(e) => setSchemas({ ...schemas, fetch: e.target.checked })} className="h-4 w-4 rounded border-input" />
                Fetch URL schemas
              </label>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {NUMBERS.map(({ key, label, min }) => (
                  <div key={key}>
                    <Label htmlFor={`schema-${key}`} className="text-xs">{label}</Label>
                    <Input id={`schema-${key}`} type="number" min={min} step={1} value={schemas[key]} disabled={isSaving || !schemas.fetch}
                      onChange={(e) => setSchemas({ ...schemas, [key]: Math.max(min, Math.floor(Number(e.target.value) || 0)) })} />
                  </div>
                ))}
              </div>
              <Label htmlFor="schema-hosts" className="text-xs mt-2 block">Allowed hosts (empty: any; *.example.com for subdomains)</Label>
              <Input id="schema-hosts" type="text" value={hostsText} disabled={isSaving || !schemas.fetch}
                onChange={(e) => setHostsText(e.target.value)} placeholder="schemas.example.com, *.example.org" />
            </div>

            {error && (
              <div className="bg-destructive/10 border border-destructive/50 rounded px-4 py-3">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
