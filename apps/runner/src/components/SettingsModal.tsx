import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { Label } from './Label';
import { Card, CardContent } from './Card';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (scriptsDir: string, templatesDir: string) => Promise<void>;
  currentScriptsDir: string;
  currentTemplatesDir: string;
}

export function SettingsModal({ isOpen, onClose, onSave, currentScriptsDir, currentTemplatesDir }: SettingsModalProps) {
  const [scriptsDir, setScriptsDir] = useState('');
  const [templatesDir, setTemplatesDir] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setScriptsDir(currentScriptsDir);
      setTemplatesDir(currentTemplatesDir);
      setError(null);
    }
  }, [isOpen, currentScriptsDir, currentTemplatesDir]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!scriptsDir.trim()) {
      setError('Please provide a scripts directory path');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await onSave(scriptsDir.trim(), templatesDir.trim());
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-lg mx-4">
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
