import * as React from 'react';
import { useEffect, useRef } from 'react';
import { Terminal, Download, Trash2 } from 'lucide-react';
import Ansi from 'ansi-to-react';
import { RunningScript } from '../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './Card';
import { Button } from './Button';
import { formatDate } from '../lib/utils';

interface ScriptOutputProps {
  script: RunningScript;
  onClear?: () => void;
}

export function ScriptOutput({ script, onClear }: ScriptOutputProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = React.useState(true);

  useEffect(() => {
    if (autoScroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [script.output, autoScroll]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const isAtBottom =
      Math.abs(target.scrollHeight - target.scrollTop - target.clientHeight) < 10;
    setAutoScroll(isAtBottom);
  };

  const handleDownload = () => {
    const text = script.output.map((line) => `[${line.type}] ${line.data}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${script.name}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center space-x-2">
              <Terminal className="h-4 w-4" />
              <span>{script.name}</span>
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Started at {formatDate(script.startedAt)} • {script.output.length} lines
            </CardDescription>
          </div>
          <div className="flex items-center space-x-1">
            <Button variant="ghost" size="icon" onClick={handleDownload} title="Download log">
              <Download className="h-4 w-4" />
            </Button>
            {onClear && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onClear}
                title="Clear output"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        {script.args.length > 0 && (
          <div className="text-xs font-mono bg-muted px-2 py-1 rounded mt-2">
            Args: {script.args.join(' ')}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <div
          ref={outputRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-4 pb-4 terminal-output"
        >
          {script.output.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <p className="text-sm">Waiting for output...</p>
            </div>
          ) : (
            script.output.map((line, index) => (
              <div
                key={index}
                className={`py-0.5 font-mono text-sm ${
                  line.type === 'error'
                    ? 'text-red-500 font-semibold'
                    : line.type === 'info'
                    ? 'text-blue-400'
                    : ''
                }`}
              >
                <span className="text-muted-foreground text-xs mr-2">
                  {formatDate(line.timestamp)}
                </span>
                <span className="text-muted-foreground text-xs mr-2">[{line.type}]</span>
                <Ansi>{line.data}</Ansi>
              </div>
            ))
          )}
        </div>
        {!autoScroll && (
          <div className="absolute bottom-20 right-8">
            <Button
              size="sm"
              onClick={() => {
                setAutoScroll(true);
                if (outputRef.current) {
                  outputRef.current.scrollTop = outputRef.current.scrollHeight;
                }
              }}
            >
              Scroll to bottom
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
