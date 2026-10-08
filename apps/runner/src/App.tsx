import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Terminal, FileCode, Loader2, Settings, Pencil, Trash2, Check, X } from 'lucide-react';
import { ScriptInfo, ScriptSchema, RunningScript, ScriptOutputLine, FormValues, Template, AppConfig } from './types';
import { ScriptList } from './components/ScriptList';
import { ScriptForm } from './components/ScriptForm';
import { ScriptOutput } from './components/ScriptOutput';
import { SettingsModal } from './components/SettingsModal';
import { Card, CardContent } from './components/Card';
import { Button } from './components/Button';
import { Input } from './components/Input';
import { formatDate, formatDuration } from './lib/utils';

function App() {
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [selectedScript, setSelectedScript] = useState<ScriptInfo | null>(null);
  const [scriptSchema, setScriptSchema] = useState<ScriptSchema | null>(null);
  const [runningScripts, setRunningScripts] = useState<RunningScript[]>([]);
  const [selectedRunningScript, setSelectedRunningScript] = useState<RunningScript | null>(null);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'scripts' | 'running'>('scripts');
  const [eventUnlisteners, setEventUnlisteners] = useState<Map<string, UnlistenFn>>(new Map());
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [scriptsDir, setScriptsDir] = useState<string>('');
  const [templatesDir, setTemplatesDir] = useState<string>('');
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const MAX_OUTPUT_LINES = 100;

  // Initialize and discover scripts
  useEffect(() => {
    initializeApp();
  }, []);

  // Cleanup all event listeners on unmount
  useEffect(() => {
    return () => {
      eventUnlisteners.forEach((unlisten) => unlisten());
    };
  }, [eventUnlisteners]);

  // Keep selectedRunningScript in sync with runningScripts
  useEffect(() => {
    if (selectedRunningScript) {
      const updated = runningScripts.find(s => s.id === selectedRunningScript.id);
      if (updated) {
        setSelectedRunningScript(updated);
      }
    }
  }, [runningScripts]);

  const initializeApp = async () => {
    try {
      const dir = await invoke<string>('get_scripts_dir');
      setScriptsDir(dir);

      const tplDir = await invoke<string>('get_templates_dir');
      setTemplatesDir(tplDir);

      const discoveredScripts = await invoke<ScriptInfo[]>('discover_scripts', {
        scriptsDir: dir,
      });
      setScripts(discoveredScripts);

      // Load templates
      const loadedTemplates = await invoke<Template[]>('load_templates');
      setTemplates(loadedTemplates);
    } catch (err) {
      setError(String(err));
    }
  };

  const loadScriptSchema = async (script: ScriptInfo) => {
    setIsLoadingSchema(true);
    setError(null);
    setSelectedTemplate(null); // Clear template when loading a new script
    try {
      const schema = await invoke<ScriptSchema>('get_script_schema', {
        scriptPath: script.path,
      });
      setScriptSchema(schema);
      setSelectedScript(script);
    } catch (err) {
      setError(String(err));
      setScriptSchema(null);
    } finally {
      setIsLoadingSchema(false);
    }
  };

  const handleRunScript = async (args: string[]) => {
    if (!selectedScript) return;

    try {
      const id = await invoke<string>('run_script', {
        scriptPath: selectedScript.path,
        args: args,
      });

      const newRunningScript: RunningScript = {
        id,
        name: selectedScript.name,
        scriptPath: selectedScript.path,
        args,
        startedAt: new Date(),
        output: [
          {
            type: 'info',
            data: `Starting ${selectedScript.name}...`,
            timestamp: new Date(),
          },
        ],
      };

      setRunningScripts((prev) => [...prev, newRunningScript]);
      setView('running');
      setSelectedRunningScript(newRunningScript);

      // Setup event listeners for this script (await to ensure they're registered)
      await setupScriptListeners(id);
    } catch (err) {
      setError(String(err));
    }
  };

  const setupScriptListeners = async (scriptId: string) => {
    console.log('Setting up listeners for script:', scriptId);
    
    // Listen for output
    const outputUnlisten = await listen<{ id: string; type: string; data: string }>(
      `output_${scriptId}`,
      (event) => {
        console.log('Received output event:', event.payload);
        const { type, data } = event.payload;
        setRunningScripts((prev) =>
          prev.map((script) => {
            if (script.id === scriptId) {
              const newLine: ScriptOutputLine = {
                type: type as 'stdout' | 'stderr',
                data,
                timestamp: new Date(),
              };
              // Keep only last MAX_OUTPUT_LINES lines
              const newOutput = [...script.output, newLine].slice(-MAX_OUTPUT_LINES);
              return { ...script, output: newOutput };
            }
            return script;
          })
        );
      }
    );

    // Listen for completion
    const completionUnlisten = await listen<{ id: string; exit_code: number | null; name: string }>(
      `process_completed_${scriptId}`,
      (event) => {
        const { exit_code } = event.payload;
        setRunningScripts((prev) =>
          prev.map((script) => {
            if (script.id === scriptId) {
              const completionLine: ScriptOutputLine = {
                type: exit_code === 0 ? 'info' : 'error',
                data:
                  exit_code === 0
                    ? `Process completed successfully`
                    : exit_code === null
                    ? `Process terminated`
                    : `Process exited with code ${exit_code}`,
                timestamp: new Date(),
              };
              const newOutput = [...script.output, completionLine].slice(-MAX_OUTPUT_LINES);
              return {
                ...script,
                output: newOutput,
                exitCode: exit_code ?? undefined,
                finishedAt: new Date(),
              };
            }
            return script;
          })
        );

        // Cleanup listeners
        cleanupScriptListeners(scriptId);
      }
    );

    // Store unlisteners
    setEventUnlisteners((prev) => {
      const newMap = new Map(prev);
      newMap.set(`${scriptId}_output`, outputUnlisten);
      newMap.set(`${scriptId}_completion`, completionUnlisten);
      return newMap;
    });
  };

  const cleanupScriptListeners = (scriptId: string) => {
    const outputKey = `${scriptId}_output`;
    const completionKey = `${scriptId}_completion`;

    eventUnlisteners.get(outputKey)?.();
    eventUnlisteners.get(completionKey)?.();

    setEventUnlisteners((prev) => {
      const newMap = new Map(prev);
      newMap.delete(outputKey);
      newMap.delete(completionKey);
      return newMap;
    });
  };

  const handleStopScript = async (id: string) => {
    try {
      await invoke('stop_script', { id });
      // Note: We don't remove from state immediately - wait for completion event
      // This ensures we capture the final output and exit status
      cleanupScriptListeners(id);
      if (selectedRunningScript?.id === id) {
        setSelectedRunningScript(null);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  // Sanitize a string for use as a filename/ID
  const sanitizeFilename = (name: string): string => {
    return name
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]/g, '_');
  };

  const handleSaveTemplate = async (name: string, values: FormValues) => {
    if (!selectedScript || !scriptSchema) return;

    try {
      // Convert all values to strings for Rust backend
      const stringifiedValues: Record<string, string> = {};
      Object.entries(values).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          stringifiedValues[key] = value.join(',');
        } else if (typeof value === 'boolean') {
          stringifiedValues[key] = value.toString();
        } else {
          stringifiedValues[key] = String(value);
        }
      });

      const templateId = sanitizeFilename(name);
      
      await invoke('save_template', {
        template: {
          id: templateId,
          name,
          script: selectedScript.name,
          formData: {
            arguments: stringifiedValues,
            options: stringifiedValues,
          },
        },
      });
      // Reload templates
      const loadedTemplates = await invoke<Template[]>('load_templates');
      setTemplates(loadedTemplates);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await invoke('delete_template', { id });
      // Reload templates
      const loadedTemplates = await invoke<Template[]>('load_templates');
      setTemplates(loadedTemplates);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRenameTemplate = async (id: string, newName: string) => {
    try {
      await invoke('rename_template', { id, newName });
      // Reload templates
      const loadedTemplates = await invoke<Template[]>('load_templates');
      setTemplates(loadedTemplates);
      // Update selected template if it was the renamed one
      if (selectedTemplate?.id === id) {
        const updatedTemplate = loadedTemplates.find(t => t.name === newName);
        if (updatedTemplate) {
          setSelectedTemplate(updatedTemplate);
        }
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const handleLoadTemplate = async (template: Template) => {
    // Find the script that matches the template
    const script = scripts.find((s) => s.name === template.script);
    if (script) {
      await loadScriptSchema(script);
      setSelectedTemplate(template);
    }
  };

  const handleClearOutput = () => {
    if (!selectedRunningScript) return;

    setRunningScripts((prev) =>
      prev.map((script) => {
        if (script.id === selectedRunningScript.id) {
          return {
            ...script,
            output: [],
          };
        }
        return script;
      })
    );
  };

  const handleSaveSettings = async (newScriptsDir: string, newTemplatesDir: string) => {
    try {
      // Save the config
      await invoke('save_config', {
        config: {
          scripts_dir: newScriptsDir,
          templates_dir: newTemplatesDir || undefined,
        } as AppConfig,
      });

      // Reload the app with new scripts directory
      setScriptsDir(newScriptsDir);
      setError(null);
      await initializeApp();
    } catch (err) {
      throw new Error(String(err));
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Left Sidebar - Script List */}
      <div className="w-80 border-r border-border flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold flex items-center space-x-2">
              <Terminal className="h-5 w-5 text-primary" />
              <span>clyops runner</span>
            </h1>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsSettingsOpen(true)}
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
          {runningScripts.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {runningScripts.length} script{runningScripts.length !== 1 ? 's' : ''} running
            </p>
          )}
        </div>

        {/* Scripts List */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <ScriptList
            scripts={scripts}
            onSelectScript={loadScriptSchema}
            selectedScript={selectedScript || undefined}
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col">
        {/* Error Banner */}
        {error && (
          <div className="bg-destructive/10 border-b border-destructive/50 px-6 py-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {!selectedScript && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <FileCode className="h-16 w-16 text-muted-foreground mb-4 mx-auto" />
                <p className="text-lg text-muted-foreground">Select a script to get started</p>
                <p className="text-sm text-muted-foreground mt-2">
                  Choose a script from the sidebar to view its configuration
                </p>
              </div>
            </div>
          )}

          {selectedScript && isLoadingSchema && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <Loader2 className="h-12 w-12 text-primary animate-spin mb-4 mx-auto" />
                <p className="text-lg text-muted-foreground">Loading script configuration...</p>
              </div>
            </div>
          )}

          {selectedScript && scriptSchema && !isLoadingSchema && (
            <div className="p-6">
              <ScriptForm
                schema={scriptSchema}
                onRun={handleRunScript}
                onSaveTemplate={handleSaveTemplate}
                initialValues={selectedTemplate?.formData?.arguments}
                initialTemplateName={selectedTemplate?.name}
              />
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Running Instances & Actions */}
      {selectedScript && scriptSchema && !isLoadingSchema && (
        <div className="w-96 border-l border-border flex flex-col">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold">Instances & Templates</h2>
          </div>
          
          {/* Running Instances Section */}
          <div className="border-b border-border">
            <div className="px-4 py-2 bg-accent/50">
              <h3 className="text-sm font-medium">
                Running Instances
                {runningScripts.filter((s) => s.scriptPath === selectedScript.path).length > 0 && (
                  <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-primary text-primary-foreground">
                    {runningScripts.filter((s) => s.scriptPath === selectedScript.path).length}
                  </span>
                )}
              </h3>
            </div>
            <div className="max-h-64 overflow-y-auto p-3">
              {runningScripts.filter((s) => s.scriptPath === selectedScript.path).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No instances running
                </p>
              ) : (
                <div className="space-y-2">
                  {runningScripts
                    .filter((s) => s.scriptPath === selectedScript.path)
                    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
                    .map((script) => {
                      const isFinished = script.exitCode !== undefined || script.finishedAt !== undefined;
                      const isSuccess = script.exitCode === 0;
                      const isFailed = script.exitCode !== undefined && script.exitCode !== 0;
                      
                      return (
                        <Card
                          key={script.id}
                          className="cursor-pointer hover:shadow-md transition-all"
                          onClick={() => {
                            setView('running');
                            setSelectedRunningScript(script);
                          }}
                        >
                          <CardContent className="p-3">
                            <div className="flex items-center justify-between">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <div className={`w-2 h-2 rounded-full ${
                                    isSuccess ? 'bg-green-500' : isFailed ? 'bg-red-500' : 'bg-blue-500 animate-pulse'
                                  }`} />
                                  <span className="text-xs text-muted-foreground truncate">
                                    {formatDate(script.startedAt)}
                                  </span>
                                  {isFinished && (
                                    <span className={`px-1.5 py-0.5 text-xs rounded ${
                                      isSuccess
                                        ? 'bg-green-500/20 text-green-700 dark:text-green-400'
                                        : 'bg-red-500/20 text-red-700 dark:text-red-400'
                                    }`}>
                                      {isSuccess ? 'Done' : `Exit ${script.exitCode}`}
                                    </span>
                                  )}
                                </div>
                                {!isFinished && (
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Running for {formatDuration(script.startedAt)}
                                  </p>
                                )}
                              </div>
                              {!isFinished && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleStopScript(script.id);
                                  }}
                                  className="hover:bg-destructive/10 hover:text-destructive"
                                >
                                  Stop
                                </Button>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                </div>
              )}
            </div>
          </div>

          {/* Templates Section */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-4 py-2 bg-accent/50">
              <h3 className="text-sm font-medium">Templates</h3>
            </div>
            <div className="p-3">
              {templates.filter((t) => t.script === selectedScript.name).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No templates saved
                </p>
              ) : (
                <div className="space-y-2">
                  {templates
                    .filter((t) => t.script === selectedScript.name)
                    .map((template) => (
                      <Card
                        key={template.id}
                        className={`cursor-pointer hover:shadow-md transition-all ${
                          selectedTemplate?.id === template.id ? 'ring-2 ring-primary' : ''
                        }`}
                        onClick={() => {
                          if (renamingTemplateId !== template.id) {
                            handleLoadTemplate(template);
                          }
                        }}
                      >
                        <CardContent className="p-3">
                          {renamingTemplateId === template.id ? (
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <Input
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                className="h-8 text-sm"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    handleRenameTemplate(template.id, renameValue);
                                    setRenamingTemplateId(null);
                                  } else if (e.key === 'Escape') {
                                    setRenamingTemplateId(null);
                                  }
                                }}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  handleRenameTemplate(template.id, renameValue);
                                  setRenamingTemplateId(null);
                                }}
                                className="h-8 w-8 p-0"
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setRenamingTemplateId(null)}
                                className="h-8 w-8 p-0"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium truncate flex-1">{template.name}</span>
                              <div className="flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingTemplateId(template.id);
                                    setRenameValue(template.name);
                                  }}
                                  className="h-8 w-8 p-0 hover:bg-accent"
                                  title="Rename template"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteTemplate(template.id);
                                  }}
                                  className="h-8 w-8 p-0 hover:bg-destructive/10 hover:text-destructive"
                                  title="Delete template"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Full Screen Output View Modal */}
      {view === 'running' && selectedRunningScript && (
        <div className="absolute inset-0 bg-background z-50 flex flex-col">
          <div className="flex items-center justify-between px-6 py-3 border-b border-border">
            <h2 className="font-semibold">
              {selectedRunningScript.name} - Output
            </h2>
            <Button
              variant="ghost"
              onClick={() => {
                setView('scripts');
                setSelectedRunningScript(null);
              }}
            >
              Close
            </Button>
          </div>
          <div className="flex-1 overflow-hidden p-6">
            <ScriptOutput script={selectedRunningScript} onClear={handleClearOutput} />
          </div>
        </div>
      )}

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSave={handleSaveSettings}
        currentScriptsDir={scriptsDir}
        currentTemplatesDir={templatesDir}
      />
    </div>
  );
}

export default App;
