import React from 'react';
import { Radio } from '@/components/ui/radio';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { RiAddLine, RiDeleteBinLine, RiArrowUpLine, RiArrowDownLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { ModelMode, ModelModeRule, ModelPriority, ModelModeCondition } from '@/lib/modelModes';
import { MODEL_MODES, MODEL_MODE_CONDITIONS, MODEL_PRIORITY_RETRY_OPTIONS } from '@/lib/modelModes';

interface ModelModeSettingsProps {
  className?: string;
}

export const ModelModeSettings: React.FC<ModelModeSettingsProps> = ({ className }) => {
  const [config, setConfig] = React.useState({
    mode: 'default' as ModelMode,
    defaultModel: '',
    rules: [] as ModelModeRule[],
    priorities: [] as ModelPriority[],
  });
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch('/api/model-mode');
        if (response.ok) {
          const data = await response.json();
          setConfig({
            mode: data.mode || 'default',
            defaultModel: data.defaultModel || '',
            rules: data.rules || [],
            priorities: data.priorities || [],
          });
        }
      } catch (error) {
        console.warn('Failed to load model mode config:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadConfig();
  }, []);

  const saveConfig = React.useCallback(async (newConfig: typeof config) => {
    try {
      const response = await fetch('/api/model-mode', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig),
      });
      if (!response.ok) {
        console.warn('Failed to save model mode config:', response.status);
      }
    } catch (error) {
      console.warn('Failed to save model mode config:', error);
    }
  }, []);

  const handleModeChange = React.useCallback((mode: string) => {
    const newConfig = { ...config, mode: mode as ModelMode };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  const handleDefaultModelChange = React.useCallback((providerId: string, modelId: string) => {
    const newValue = providerId && modelId ? `${providerId}/${modelId}` : '';
    const newConfig = { ...config, defaultModel: newValue };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  const parsedDefaultModel = React.useMemo(() => {
    if (!config.defaultModel) return { providerId: '', modelId: '' };
    const parts = config.defaultModel.split('/');
    return parts.length === 2 ? { providerId: parts[0], modelId: parts[1] } : { providerId: '', modelId: '' };
  }, [config.defaultModel]);

  const addRule = React.useCallback(() => {
    const newRule: ModelModeRule = {
      condition: 'topic',
      value: '',
      model: '',
    };
    const newConfig = { ...config, rules: [...config.rules, newRule] };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  const removeRule = React.useCallback((index: number) => {
    const newRules = config.rules.filter((_, i) => i !== index);
    const newConfig = { ...config, rules: newRules };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  const updateRule = React.useCallback((index: number, updates: Partial<ModelModeRule>) => {
    const newRules = [...config.rules];
    newRules[index] = { ...newRules[index], ...updates };
    const newConfig = { ...config, rules: newRules };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  const addPriority = React.useCallback(() => {
    const newPriority: ModelPriority = {
      model: '',
    };
    const newConfig = { ...config, priorities: [...config.priorities, newPriority] };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  const removePriority = React.useCallback((index: number) => {
    const newPriorities = config.priorities.filter((_, i) => i !== index);
    const newConfig = { ...config, priorities: newPriorities };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  const updatePriority = React.useCallback((index: number, updates: Partial<ModelPriority>) => {
    const newPriorities = [...config.priorities];
    newPriorities[index] = { ...newPriorities[index], ...updates };
    const newConfig = { ...config, priorities: newPriorities };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  const movePriority = React.useCallback((index: number, direction: 'up' | 'down') => {
    const newPriorities = [...config.priorities];
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= newPriorities.length) return;
    [newPriorities[index], newPriorities[newIndex]] = [newPriorities[newIndex], newPriorities[index]];
    const newConfig = { ...config, priorities: newPriorities };
    setConfig(newConfig);
    saveConfig(newConfig);
  }, [config, saveConfig]);

  if (isLoading) {
    return null;
  }

  return (
    <div className={cn('mb-6', className)}>
      <div className="mb-0.5 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">Model Mode</h3>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-4">
        <div className="mt-0 mb-1 typography-meta text-muted-foreground">
          Configure how models are selected for operations
        </div>

        <div className="flex flex-col gap-2 py-1">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">Mode</span>
          </div>
          <div className="flex flex-col gap-2">
            {MODEL_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => handleModeChange(mode)}
                className="flex w-full items-center gap-2 py-0.5 text-left"
              >
                <Radio
                  checked={config.mode === mode}
                  onChange={() => handleModeChange(mode)}
                  ariaLabel={`Mode: ${mode}`}
                />
                <span className={cn('typography-ui-label font-normal capitalize', config.mode === mode ? 'text-foreground' : 'text-foreground/50')}>
                  {mode}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">Default Model</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
            <ModelSelector
              providerId={parsedDefaultModel.providerId}
              modelId={parsedDefaultModel.modelId}
              onChange={handleDefaultModelChange}
            />
          </div>
        </div>

        {config.mode === 'smart' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="typography-ui-label text-foreground font-medium">Rules</span>
              <Button onClick={addRule} size="sm" variant="outline">
                <RiAddLine className="h-4 w-4 mr-1" />
                Add Rule
              </Button>
            </div>
            {config.rules.length === 0 ? (
              <div className="typography-meta text-muted-foreground">No rules configured. Add rules to route requests based on conditions.</div>
            ) : (
              <div className="space-y-2">
                {config.rules.map((rule, index) => (
                  <div key={index} className="flex flex-col gap-2 p-3 border border-border/40 rounded-lg bg-[var(--surface-elevated)]">
                    <div className="flex items-center gap-2">
                      <Select
                        value={rule.condition}
                        onValueChange={(value) => updateRule(index, { condition: value as ModelModeCondition })}
                      >
                        <SelectTrigger className="w-[140px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MODEL_MODE_CONDITIONS.map((condition) => (
                            <SelectItem key={condition} value={condition}>
                              {condition}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={rule.value}
                        onChange={(e) => updateRule(index, { value: e.target.value })}
                        placeholder="Value"
                        className="flex-1"
                      />
                      <Button onClick={() => removeRule(index)} size="sm" variant="ghost">
                        <RiDeleteBinLine className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="typography-micro text-muted-foreground">Model:</span>
                      <ModelSelector
                        providerId={rule.model.split('/')[0] || ''}
                        modelId={rule.model.split('/')[1] || ''}
                        onChange={(providerId, modelId) => updateRule(index, { model: `${providerId}/${modelId}` })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {config.mode === 'prioritised' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="typography-ui-label text-foreground font-medium">Priority List</span>
              <Button onClick={addPriority} size="sm" variant="outline">
                <RiAddLine className="h-4 w-4 mr-1" />
                Add Priority
              </Button>
            </div>
            {config.priorities.length === 0 ? (
              <div className="typography-meta text-muted-foreground">No priorities configured. Add models to create a failover list.</div>
            ) : (
              <div className="space-y-2">
                {config.priorities.map((priority, index) => (
                  <div key={index} className="flex flex-col gap-2 p-3 border border-border/40 rounded-lg bg-[var(--surface-elevated)]">
                    <div className="flex items-center gap-2">
                      <span className="typography-micro text-muted-foreground w-6">#{index + 1}</span>
                      <ModelSelector
                        providerId={priority.model.split('/')[0] || ''}
                        modelId={priority.model.split('/')[1] || ''}
                        onChange={(providerId, modelId) => updatePriority(index, { model: `${providerId}/${modelId}` })}
                      />
                      <div className="flex gap-1">
                        <Button
                          onClick={() => movePriority(index, 'up')}
                          size="sm"
                          variant="ghost"
                          disabled={index === 0}
                        >
                          <RiArrowUpLine className="h-4 w-4" />
                        </Button>
                        <Button
                          onClick={() => movePriority(index, 'down')}
                          size="sm"
                          variant="ghost"
                          disabled={index === config.priorities.length - 1}
                        >
                          <RiArrowDownLine className="h-4 w-4" />
                        </Button>
                        <Button onClick={() => removePriority(index)} size="sm" variant="ghost">
                          <RiDeleteBinLine className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-2">
                        <span className="typography-micro text-muted-foreground">Timeout (ms):</span>
                        <Input
                          type="number"
                          value={priority.timeout || ''}
                          onChange={(e) => updatePriority(index, { timeout: parseInt(e.target.value) || undefined })}
                          placeholder="60000"
                          className="w-[100px] h-7"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="typography-micro text-muted-foreground">Retry on:</span>
                        {MODEL_PRIORITY_RETRY_OPTIONS.map((option) => (
                          <label key={option} className="flex items-center gap-1">
                            <Checkbox
                              checked={priority.retryOn?.includes(option) ?? false}
                              onChange={(checked) => {
                                const currentRetryOn = priority.retryOn || [];
                                const newRetryOn = checked
                                  ? [...currentRetryOn, option]
                                  : currentRetryOn.filter((o) => o !== option);
                                updatePriority(index, { retryOn: newRetryOn.length > 0 ? newRetryOn : undefined });
                              }}
                            />
                            <span className="typography-micro">{option}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
