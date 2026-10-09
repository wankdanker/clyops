import { useState, useEffect, useMemo } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Play, Save, Loader2, X, RotateCcw, Search, Plus, Trash2, ChevronDown, ChevronUp, ChevronsDownUp, ChevronsUpDown, Copy, FileJson, Check, Terminal, AlertTriangle } from 'lucide-react';
import { ScriptSchema, FormValues } from '../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './Card';
import { Button } from './Button';
import { Input } from './Input';
import { Label } from './Label';
import { buildCommandArgs, constraintIssues, expandCommands, formatCommandLine, isTextType, parseCommandLine } from '../lib/utils';
import { TemplateJsonEditor } from './TemplateJsonEditor';

/** Where a run's stdin comes from and its binary stdout goes (spec section 1.3). */
export interface RunIo {
  stdin?: string;
  stdinFile?: string;
  stdoutFile?: string;
}

interface ScriptFormProps {
  schema: ScriptSchema;
  onRun: (args: string[], io: RunIo) => void;
  onSaveTemplate: (name: string, values: FormValues) => void;
  isRunning?: boolean;
  initialValues?: FormValues;
  initialTemplateName?: string;
}

export function ScriptForm({ schema: program, onRun, onSaveTemplate, isRunning, initialValues, initialTemplateName }: ScriptFormProps) {
  // A program with commands gets a form per command (spec section 1.7).
  const commands = useMemo(() => expandCommands(program), [program]);
  const [commandKey, setCommandKey] = useState('');
  const command = commands.find((c) => c.words.join(' ') === commandKey) ?? commands[0];
  const schema = command ? command.schema : program;
  const words = command ? command.words : [];
  const [stdinText, setStdinText] = useState('');
  const [stdinFile, setStdinFile] = useState('');
  const [stdoutFile, setStdoutFile] = useState('');
  const binaryOut = schema.stdout && !isTextType(schema.stdout.contentType);
  const effects = schema.effects ?? [];
  const [values, setValues] = useState<FormValues>({});
  const [templateName, setTemplateName] = useState('');
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showJsonEditor, setShowJsonEditor] = useState(false);
  const [showCommandParser, setShowCommandParser] = useState(false);
  const [commandInput, setCommandInput] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // Copy command to clipboard
  const handleCopyCommand = async () => {
    const args = [...words, ...buildCommandArgs(schema, values)];
    const commandLine = formatCommandLine(schema.path, args);
    try {
      await writeText(commandLine);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Parse a command line string and fill in the form
  const handleParseCommand = () => {
    setParseError(null);
    try {
      const parsed = parseCommandLine(commandInput, schema);
      setValues(prev => ({ ...prev, ...parsed }));
      setCommandInput('');
      setShowCommandParser(false);
    } catch (err) {
      setParseError((err as Error).message);
    }
  };

  // Handle values change from JSON editor
  const handleJsonEditorChange = (newValues: FormValues) => {
    setValues(newValues);
  };

  // Helper function to get default values from schema
  const getDefaultValues = (): FormValues => {
    const defaultValues: FormValues = {};

    schema.arguments.forEach((arg) => {
      defaultValues[arg.name] = arg.isVariadic ? [] : arg.default || '';
    });

    schema.options.forEach((opt) => {
      if (opt.isFlag) {
        defaultValues[opt.name] = opt.default === 'true';
      } else if (opt.isArray) {
        defaultValues[opt.name] = [];
      } else {
        defaultValues[opt.name] = opt.default || '';
      }
    });

    return defaultValues;
  };

  // Initialize form with default values or template values
  useEffect(() => {
    const defaultValues = getDefaultValues();

    // Merge with initialValues if provided
    if (initialValues) {
      Object.entries(initialValues).forEach(([key, value]) => {
        // Convert string values back to proper types based on schema
        const option = schema.options.find(opt => opt.name === key);
        const isVariadic = schema.arguments.some(arg => arg.name === key && arg.isVariadic);
        if (option || isVariadic) {
          if (option?.isFlag) {
            defaultValues[key] = value === 'true' || value === true;
          } else if (option?.isArray || isVariadic) {
            defaultValues[key] = typeof value === 'string' ? value.split(',').filter(Boolean) : value;
          } else {
            defaultValues[key] = value;
          }
        } else {
          defaultValues[key] = value;
        }
      });
    }

    setValues(defaultValues);
  }, [schema, initialValues]);

  // Initialize collapsed state for all groups when schema changes
  useEffect(() => {
    const groups: Record<string, boolean> = {};
    schema.options.forEach((opt) => {
      if (!groups.hasOwnProperty(opt.group)) {
        groups[opt.group] = true; // Start collapsed
      }
    });
    // Arguments section
    if (schema.arguments.length > 0) {
      groups['Arguments'] = true;
    }
    setCollapsedGroups(groups);
  }, [schema]);

  // Update template name when initialTemplateName changes
  useEffect(() => {
    if (initialTemplateName) {
      setTemplateName(initialTemplateName);
    } else {
      setTemplateName('');
    }
  }, [initialTemplateName]);

  const handleChange = (name: string, value: any) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (effects.includes('destructive') && !window.confirm(`${schema.script} is marked destructive: it deletes or overwrites things. Run it?`)) return;
    const args = [...words, ...buildCommandArgs(schema, values)];
    onRun(args, {
      stdin: schema.stdin && stdinText && !stdinFile ? stdinText : undefined,
      stdinFile: schema.stdin && stdinFile ? stdinFile : undefined,
      stdoutFile: binaryOut && stdoutFile ? stdoutFile : undefined,
    });
  };

  const handleSaveTemplate = () => {
    if (templateName.trim()) {
      // Secrets are never written to a template file.
      const secrets = new Set(schema.options.filter((o) => o.secret).map((o) => o.name));
      onSaveTemplate(templateName, Object.fromEntries(Object.entries(values).filter(([name]) => !secrets.has(name))));
      setTemplateName('');
      setShowSaveTemplate(false);
    }
  };

  const handleClearForm = () => {
    const clearedValues: FormValues = {};
    
    schema.arguments.forEach((arg) => {
      clearedValues[arg.name] = arg.isVariadic ? [] : '';
    });

    schema.options.forEach((opt) => {
      if (opt.isFlag) {
        clearedValues[opt.name] = false;
      } else if (opt.isArray) {
        clearedValues[opt.name] = [];
      } else {
        clearedValues[opt.name] = '';
      }
    });

    setValues(clearedValues);
  };

  const handleResetForm = () => {
    setValues(getDefaultValues());
  };

  const handleExpandAll = () => {
    const allExpanded: Record<string, boolean> = {};
    Object.keys(collapsedGroups).forEach(group => {
      allExpanded[group] = false;
    });
    setCollapsedGroups(allExpanded);
  };

  const handleCollapseAll = () => {
    const allCollapsed: Record<string, boolean> = {};
    Object.keys(collapsedGroups).forEach(group => {
      allCollapsed[group] = true;
    });
    setCollapsedGroups(allCollapsed);
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups(prev => ({
      ...prev,
      [group]: !prev[group]
    }));
  };

  // Filter function for search
  const matchesSearch = (item: { name: string; description?: string }) => {
    if (!searchFilter) return true;
    const search = searchFilter.toLowerCase();
    return (
      item.name.toLowerCase().includes(search) ||
      (item.description?.toLowerCase().includes(search) ?? false)
    );
  };

  // Group options by category
  const groupedOptions: Record<string, typeof schema.options> = {};
  schema.options.forEach((opt) => {
    if (!groupedOptions[opt.group]) {
      groupedOptions[opt.group] = [];
    }
    groupedOptions[opt.group].push(opt);
  });

  const renderField = (opt: typeof schema.options[0]) => {
    const value = values[opt.name];

    if (opt.isFlag) {
      return (
        <div className="flex items-center space-x-2">
          <input
            type="checkbox"
            id={opt.name}
            checked={value as boolean}
            onChange={(e) => handleChange(opt.name, e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <Label htmlFor={opt.name} className="cursor-pointer">
            {opt.description}
          </Label>
        </div>
      );
    }

    if (opt.isArray) {
      const arrayValue = (value as string[]) || [];
      
      return (
        <div className="space-y-2">
          <Label htmlFor={opt.name}>
            {opt.name}
            {opt.required && <span className="text-destructive ml-1">*</span>}
          </Label>
          <p className="text-xs text-muted-foreground">{opt.description}</p>
          
          <div className="space-y-2">
            {arrayValue.map((item, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="text"
                  value={item}
                  onChange={(e) => {
                    const newArray = [...arrayValue];
                    newArray[index] = e.target.value;
                    handleChange(opt.name, newArray);
                  }}
                  placeholder={`${opt.name} #${index + 1}`}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const newArray = arrayValue.filter((_, i) => i !== index);
                    handleChange(opt.name, newArray);
                  }}
                  className="hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                handleChange(opt.name, [...arrayValue, '']);
              }}
              className="w-full"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add {opt.name}
            </Button>
          </div>
        </div>
      );
    }

    if (opt.type === 'choice') {
      return (
        <div>
          <Label htmlFor={opt.name}>
            {opt.name}
            {opt.required && <span className="text-destructive ml-1">*</span>}
          </Label>
          <select
            id={opt.name}
            value={value as string}
            onChange={(e) => handleChange(opt.name, e.target.value)}
            required={opt.required}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 mt-1"
          >
            <option value="">Select...</option>
            {opt.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground mt-1">{opt.description}</p>
        </div>
      );
    }

    return (
      <div>
        <Label htmlFor={opt.name}>
          {opt.name}
          {opt.required && <span className="text-destructive ml-1">*</span>}
        </Label>
        <Input
          id={opt.name}
          type={opt.secret ? 'password' : opt.type === 'integer' || opt.type === 'number' ? 'number' : 'text'}
          autoComplete={opt.secret ? 'off' : undefined}
          value={value as string}
          onChange={(e) => handleChange(opt.name, e.target.value)}
          placeholder={opt.default || ''}
          required={opt.required}
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">{opt.description}</p>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{schema.script}</CardTitle>
        <CardDescription>{schema.description}</CardDescription>
        {effects.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {effects.map((effect) => (
              <span
                key={effect}
                className={`rounded px-2 py-0.5 text-xs font-medium ${effect === 'destructive' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'}`}
              >
                {effect}
              </span>
            ))}
          </div>
        )}
        {commands.length > 0 && (
          <div className="pt-2">
            <Label htmlFor="command">Command</Label>
            <select
              id="command"
              value={words.join(' ')}
              onChange={(e) => setCommandKey(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm mt-1"
            >
              {commands.map((c) => (
                <option key={c.words.join(' ')} value={c.words.join(' ')}>
                  {c.words.join(' ')}{c.schema.description ? ` — ${c.schema.description.split('\n')[0]}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Sticky Action Buttons Section */}
          <div className="sticky top-0 bg-card z-10 -mx-6 px-6 pt-0 pb-4 border-b space-y-3">
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={isRunning} className="flex-1">
                {isRunning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Run Script
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleCopyCommand}
                title="Copy command to clipboard"
              >
                {copyFeedback ? (
                  <>
                    <Check className="mr-2 h-4 w-4 text-green-500" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowSaveTemplate(!showSaveTemplate)}
              >
                <Save className="mr-2 h-4 w-4" />
                Save Template
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleClearForm}
                size="sm"
                className="flex-1"
              >
                <X className="mr-2 h-4 w-4" />
                Clear
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleResetForm}
                size="sm"
                className="flex-1"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleExpandAll}
                size="sm"
                className="flex-1"
              >
                <ChevronsDownUp className="mr-2 h-4 w-4" />
                Expand
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleCollapseAll}
                size="sm"
                className="flex-1"
              >
                <ChevronsUpDown className="mr-2 h-4 w-4" />
                Collapse
              </Button>
              <Button
                type="button"
                variant={showJsonEditor ? 'default' : 'outline'}
                onClick={() => setShowJsonEditor(!showJsonEditor)}
                size="sm"
                className="flex-1"
                title="Toggle JSON Editor"
              >
                <FileJson className="mr-2 h-4 w-4" />
                JSON
              </Button>
              <Button
                type="button"
                variant={showCommandParser ? 'default' : 'outline'}
                onClick={() => setShowCommandParser(!showCommandParser)}
                size="sm"
                className="flex-1"
                title="Parse command line"
              >
                <Terminal className="mr-2 h-4 w-4" />
                Paste
              </Button>
            </div>

            {/* Save Template Section */}
            {showSaveTemplate && (
              <div className="flex items-center space-x-2 pt-2">
                <Input
                  placeholder="Template name..."
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                />
                <Button type="button" onClick={handleSaveTemplate} size="sm">
                  Save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowSaveTemplate(false)}
                >
                  Cancel
                </Button>
              </div>
            )}

            {/* Command Line Parser */}
            {showCommandParser && (
              <div className="pt-2 space-y-2">
                <Label className="text-sm">Paste a command line to fill the form:</Label>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="./tool --option value --flag ..."
                    value={commandInput}
                    onChange={(e) => {
                      setCommandInput(e.target.value);
                      setParseError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleParseCommand();
                      }
                    }}
                    className="flex-1 font-mono text-sm"
                  />
                  <Button type="button" onClick={handleParseCommand} size="sm">
                    Parse
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowCommandParser(false);
                      setCommandInput('');
                      setParseError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                {parseError && (
                  <p className="text-xs text-destructive">{parseError}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Supports: --option value, --option=value, -o value, --flag (boolean)
                </p>
              </div>
            )}

            {/* JSON Editor - moved outside sticky area for better height */}
          </div>

          {/* Relationships the values break (spec section 1.6): flagged, not enforced. */}
          {constraintIssues(schema, values).map((issue) => (
            <p key={issue} className="flex items-center gap-2 text-sm text-amber-600">
              <AlertTriangle className="h-4 w-4" />
              {issue}
            </p>
          ))}

          {/* Standard input and binary output (spec section 1.3). */}
          {(schema.stdin || binaryOut) && (
            <div className="space-y-4">
              {schema.stdin && (
                <div>
                  <Label htmlFor="stdin">
                    Input{schema.stdin.description ? `: ${schema.stdin.description}` : ''}
                    {schema.stdin.contentType && <span className="text-muted-foreground ml-1">({schema.stdin.contentType})</span>}
                  </Label>
                  <textarea
                    id="stdin"
                    value={stdinText}
                    onChange={(e) => setStdinText(e.target.value)}
                    disabled={Boolean(stdinFile)}
                    rows={4}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono mt-1"
                  />
                  <Input
                    value={stdinFile}
                    onChange={(e) => setStdinFile(e.target.value)}
                    placeholder="…or read it from this file"
                    className="mt-2"
                  />
                </div>
              )}
              {binaryOut && (
                <div>
                  <Label htmlFor="stdout">
                    Save output{schema.stdout?.description ? ` (${schema.stdout.description}, ${schema.stdout.contentType})` : ` (${schema.stdout?.contentType})`} to
                  </Label>
                  <Input
                    id="stdout"
                    value={stdoutFile}
                    onChange={(e) => setStdoutFile(e.target.value)}
                    placeholder="/path/to/output file"
                    className="mt-1"
                  />
                </div>
              )}
            </div>
          )}

          {/* JSON Editor - full height section */}
          {showJsonEditor && (
            <div className="h-[400px] mb-4">
              <TemplateJsonEditor
                schema={schema}
                values={values}
                onChange={handleJsonEditorChange}
                className="h-full"
              />
            </div>
          )}

            {/* Search Filter */}
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Filter fields by name or description..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="pl-9"
              />
            </div>

          {/* Positional Arguments */}
          {schema.arguments.length > 0 && schema.arguments.filter(matchesSearch).length > 0 && (() => {
            const filteredArgs = schema.arguments.filter(matchesSearch);
            const isCollapsed = collapsedGroups['Arguments'] && !searchFilter;
            const hasMatches = filteredArgs.length > 0;
            
            return (
              <div className="space-y-4">
                <button
                  type="button"
                  onClick={() => toggleGroup('Arguments')}
                  className="flex items-center justify-between w-full text-left hover:opacity-70 transition-opacity"
                >
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    Arguments {hasMatches && searchFilter && `(${filteredArgs.length})`}
                  </h3>
                  {isCollapsed ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                
                {!isCollapsed && (
                  <div className="space-y-4">
                    {filteredArgs.map((arg) => arg.isVariadic ? (
                      // A variadic argument edits like a repeatable option.
                      <div key={arg.name}>
                        {renderField({ name: arg.name, shortName: '', variableName: arg.name, description: arg.description,
                          default: '', group: 'Arguments', type: 'string', isFlag: false, isArray: true, required: false,
                          validation: arg.validation, choices: [] })}
                      </div>
                    ) : (
                      <div key={arg.name}>
                        <Label htmlFor={arg.name}>
                          {arg.name}
                          {arg.required && <span className="text-destructive ml-1">*</span>}
                        </Label>
                        <Input
                          id={arg.name}
                          value={values[arg.name] as string}
                          onChange={(e) => handleChange(arg.name, e.target.value)}
                          placeholder={arg.default || ''}
                          required={arg.required}
                          className="mt-1"
                        />
                        <p className="text-xs text-muted-foreground mt-1">{arg.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Options grouped by category */}
          {Object.entries(groupedOptions).map(([group, options]) => {
            const filteredOptions = options.filter(matchesSearch);
            if (filteredOptions.length === 0) return null;
            
            // Auto-expand if there's a search filter and matches
            const isCollapsed = collapsedGroups[group] && !searchFilter;
            const hasMatches = filteredOptions.length > 0;
            
            return (
              <div key={group} className="space-y-4">
                <button
                  type="button"
                  onClick={() => toggleGroup(group)}
                  className="flex items-center justify-between w-full text-left hover:opacity-70 transition-opacity"
                >
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    {group} {hasMatches && searchFilter && `(${filteredOptions.length})`}
                  </h3>
                  {isCollapsed ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                
                {!isCollapsed && (
                  <div className="space-y-4">{filteredOptions.map(renderField)}</div>
                )}
              </div>
            );
          })}
        </form>
      </CardContent>
    </Card>
  );
}
