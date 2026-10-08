import { useState, useMemo } from 'react';
import { FileCode, ChevronRight, Search, X } from 'lucide-react';
import { ScriptInfo } from '../types';
import { Card, CardDescription, CardTitle } from './Card';
import { cn } from '../lib/utils';

interface ScriptListProps {
  scripts: ScriptInfo[];
  onSelectScript: (script: ScriptInfo) => void;
  selectedScript?: ScriptInfo;
}

export function ScriptList({ scripts, onSelectScript, selectedScript }: ScriptListProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredScripts = useMemo(() => {
    if (!searchQuery.trim()) return scripts;
    const query = searchQuery.toLowerCase();
    return scripts.filter(
      (script) =>
        script.name.toLowerCase().includes(query) ||
        script.description?.toLowerCase().includes(query)
    );
  }, [scripts, searchQuery]);

  return (
    <div className="space-y-2">
      {/* Search Input */}
      <div className="relative mb-3">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search scripts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-8 pr-8 py-1.5 text-sm bg-input border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Results count */}
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
        <span>
          {filteredScripts.length === scripts.length
            ? `${scripts.length} scripts`
            : `${filteredScripts.length} of ${scripts.length}`}
        </span>
      </div>

      {/* Script List */}
      <div className="space-y-1">
        {filteredScripts.map((script) => (
          <Card
            key={script.path}
            className={cn(
              'cursor-pointer transition-all hover:shadow-sm border',
              selectedScript?.path === script.path
                ? 'border-primary bg-accent'
                : 'border-transparent hover:border-muted hover:bg-accent/50'
            )}
            onClick={() => onSelectScript(script)}
          >
            <div className="flex items-center justify-between px-2.5 py-2">
              <div className="flex items-center space-x-2 min-w-0">
                <div className="p-1.5 rounded bg-primary/10 flex-shrink-0">
                  <FileCode className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-sm font-medium truncate">{script.name}</CardTitle>
                  {script.description && (
                    <CardDescription className="text-xs truncate mt-0.5">
                      {script.description}
                    </CardDescription>
                  )}
                </div>
              </div>
              <ChevronRight
                className={cn(
                  'h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform',
                  selectedScript?.path === script.path && 'rotate-90 text-primary'
                )}
              />
            </div>
          </Card>
        ))}

        {filteredScripts.length === 0 && searchQuery && (
          <div className="text-center py-6 text-muted-foreground text-sm">
            No scripts match "{searchQuery}"
          </div>
        )}
      </div>
    </div>
  );
}
