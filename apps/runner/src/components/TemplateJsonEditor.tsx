import { useState, useEffect, useMemo, useRef } from 'react';
import Editor, { OnMount, OnValidate } from '@monaco-editor/react';
import { ScriptSchema, FormValues } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from './Card';
import { Button } from './Button';
import { AlertCircle, Check, FileJson } from 'lucide-react';
import { cn } from '../lib/utils';

interface TemplateJsonEditorProps {
  schema: ScriptSchema;
  values: FormValues;
  onChange: (values: FormValues) => void;
  className?: string;
}

/**
 * Generate a JSON Schema from the ScriptSchema for Monaco validation
 */
function generateJsonSchema(schema: ScriptSchema) {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  // Add arguments
  schema.arguments?.forEach((arg) => {
    properties[arg.name] = {
      type: 'string',
      description: arg.description,
      default: arg.default || undefined,
    };
    if (arg.required) {
      required.push(arg.name);
    }
  });

  // Add options
  schema.options?.forEach((opt) => {
    let propDef: any = {
      description: opt.description,
    };

    if (opt.isFlag) {
      propDef.type = 'boolean';
      propDef.default = opt.default === 'true';
    } else if (opt.isArray) {
      propDef.type = 'array';
      propDef.items = { type: 'string' };
    } else if (opt.type === 'choice' && opt.choices?.length > 0) {
      propDef.type = 'string';
      propDef.enum = opt.choices;
    } else if (opt.type === 'integer') {
      propDef.type = 'integer';
      if (opt.default) propDef.default = parseInt(opt.default, 10);
    } else if (opt.type === 'number') {
      propDef.type = 'number';
      if (opt.default) propDef.default = parseFloat(opt.default);
    } else {
      propDef.type = 'string';
      if (opt.default) propDef.default = opt.default;
    }

    properties[opt.name] = propDef;
  });

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    title: `${schema.script} Configuration`,
    description: schema.description,
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

/**
 * Convert FormValues to a JSON-serializable object (handles arrays and booleans properly)
 */
function formValuesToJson(values: FormValues): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(values)) {
    // Skip empty strings and empty arrays
    if (value === '' || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Convert JSON object back to FormValues
 */
function jsonToFormValues(json: Record<string, any>, schema: ScriptSchema): FormValues {
  const result: FormValues = {};
  
  // Initialize with defaults from schema
  schema.arguments?.forEach((arg) => {
    result[arg.name] = json[arg.name] ?? arg.default ?? '';
  });
  
  schema.options?.forEach((opt) => {
    const jsonValue = json[opt.name];
    if (opt.isFlag) {
      result[opt.name] = jsonValue ?? (opt.default === 'true');
    } else if (opt.isArray) {
      result[opt.name] = Array.isArray(jsonValue) ? jsonValue : [];
    } else {
      result[opt.name] = jsonValue ?? opt.default ?? '';
    }
  });

  return result;
}

export function TemplateJsonEditor({ schema, values, onChange, className }: TemplateJsonEditorProps) {
  const [jsonContent, setJsonContent] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [isValid, setIsValid] = useState(true);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  // Generate JSON schema for Monaco
  const jsonSchema = useMemo(() => generateJsonSchema(schema), [schema]);

  // Sync values to JSON content
  useEffect(() => {
    const json = formValuesToJson(values);
    setJsonContent(JSON.stringify(json, null, 2));
  }, [values]);

  // Configure Monaco with JSON schema
  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure JSON schema validation
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [
        {
          uri: 'internal://script-config-schema.json',
          fileMatch: ['*'],
          schema: jsonSchema,
        },
      ],
      enableSchemaRequest: false,
    });
  };

  // Handle validation errors from Monaco
  const handleValidate: OnValidate = (markers) => {
    const errorMessages = markers
      .filter((m) => m.severity === 8) // Error severity
      .map((m) => `Line ${m.startLineNumber}: ${m.message}`);
    setErrors(errorMessages);
    setIsValid(errorMessages.length === 0);
  };

  // Handle content change
  const handleEditorChange = (value: string | undefined) => {
    if (!value) return;
    setJsonContent(value);
  };

  // Apply JSON changes to form
  const handleApplyChanges = () => {
    try {
      const parsed = JSON.parse(jsonContent);
      const formValues = jsonToFormValues(parsed, schema);
      onChange(formValues);
    } catch (e) {
      setErrors([`JSON parse error: ${(e as Error).message}`]);
      setIsValid(false);
    }
  };

  // Format JSON
  const handleFormat = () => {
    if (editorRef.current) {
      editorRef.current.getAction('editor.action.formatDocument')?.run();
    }
  };

  return (
    <Card className={cn('flex flex-col h-full', className)}>
      <CardHeader className="pb-2 flex-shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileJson className="h-4 w-4" />
            JSON Editor
          </CardTitle>
          <div className="flex items-center gap-2">
            {isValid ? (
              <span className="text-xs text-green-500 flex items-center gap-1">
                <Check className="h-3 w-3" />
                Valid
              </span>
            ) : (
              <span className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {errors.length} error{errors.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0 pb-3">
        <div className="flex-1 border rounded-md overflow-hidden" style={{ minHeight: '250px' }}>
          <Editor
            height="100%"
            defaultLanguage="json"
            value={jsonContent}
            onChange={handleEditorChange}
            onMount={handleEditorMount}
            onValidate={handleValidate}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              formatOnPaste: true,
              formatOnType: true,
            }}
          />
        </div>

        {/* Error display */}
        {errors.length > 0 && (
          <div className="mt-2 p-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive max-h-24 overflow-y-auto">
            {errors.map((err, i) => (
              <div key={i}>{err}</div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            onClick={handleApplyChanges}
            disabled={!isValid}
            size="sm"
            className="flex-1"
          >
            <Check className="mr-2 h-4 w-4" />
            Apply to Form
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleFormat}
            size="sm"
          >
            Format
          </Button>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          Edit JSON directly with schema validation and autocomplete. Press Ctrl+Space for suggestions.
        </p>
      </CardContent>
    </Card>
  );
}
