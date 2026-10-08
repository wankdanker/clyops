import { Terminal, X, Clock, Play } from 'lucide-react';
import { RunningScript } from '../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './Card';
import { Button } from './Button';
import { formatDate, formatDuration } from '../lib/utils';

interface RunningScriptsProps {
  scripts: RunningScript[];
  onSelectScript: (script: RunningScript) => void;
  onStopScript: (id: string) => void;
  selectedScriptId?: string;
}

export function RunningScripts({
  scripts,
  onSelectScript,
  onStopScript,
  selectedScriptId,
}: RunningScriptsProps) {
  if (scripts.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Terminal className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground">No scripts running</p>
          <p className="text-xs text-muted-foreground mt-1">
            Start a script to see it here
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Running Scripts</h2>
        <span className="text-sm text-muted-foreground">{scripts.length} running</span>
      </div>

      <div className="space-y-2">
        {scripts.map((script) => {
          const isFinished = script.exitCode !== undefined || script.finishedAt !== undefined;
          const isSuccess = script.exitCode === 0;
          const isFailed = script.exitCode !== undefined && script.exitCode !== 0;

          return (
            <Card
              key={script.id}
              className={`cursor-pointer transition-all hover:shadow-md border-2 ${
                selectedScriptId === script.id
                  ? 'border-primary bg-accent'
                  : 'border-transparent hover:border-muted'
              }`}
              onClick={() => onSelectScript(script)}
            >
              <CardHeader className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3 flex-1">
                    <div
                      className={`p-2 rounded-lg ${
                        isSuccess
                          ? 'bg-green-500/10'
                          : isFailed
                          ? 'bg-red-500/10'
                          : 'bg-blue-500/10'
                      }`}
                    >
                      {isFinished ? (
                        <Terminal
                          className={`h-4 w-4 ${
                            isSuccess ? 'text-green-500' : isFailed ? 'text-red-500' : 'text-blue-500'
                          }`}
                        />
                      ) : (
                        <Play className="h-4 w-4 text-blue-500 animate-pulse" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base truncate">{script.name}</CardTitle>
                        {isFinished && (
                          <span
                            className={`px-2 py-0.5 text-xs rounded-full ${
                              isSuccess
                                ? 'bg-green-500/20 text-green-700 dark:text-green-400'
                                : isFailed
                                ? 'bg-red-500/20 text-red-700 dark:text-red-400'
                                : 'bg-gray-500/20 text-gray-700 dark:text-gray-400'
                            }`}
                          >
                            {isSuccess
                              ? 'Done'
                              : script.exitCode !== null
                              ? `Exit ${script.exitCode}`
                              : 'Stopped'}
                          </span>
                        )}
                      </div>
                      <CardDescription className="text-xs mt-1 flex items-center space-x-2">
                        <Clock className="h-3 w-3" />
                        <span>Started {formatDate(script.startedAt)}</span>
                        {!isFinished && (
                          <span className="text-muted-foreground">
                            ({formatDuration(script.startedAt)})
                          </span>
                        )}
                        {isFinished && script.finishedAt && (
                          <span className="text-muted-foreground">
                            (ran for {formatDuration(script.startedAt, script.finishedAt)})
                          </span>
                        )}
                      </CardDescription>
                    </div>
                  </div>
                  {!isFinished && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStopScript(script.id);
                      }}
                      className="hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardHeader>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
