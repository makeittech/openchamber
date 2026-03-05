import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RiAddLine, RiDeleteBinLine, RiRefreshLine } from '@remixicon/react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getSuperwordsConfig, saveSuperwordsConfig, type SuperwordsConfig } from '@/lib/openchamberConfig';
import { toast } from '@/components/ui';

export function SuperwordsSettings() {
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);
  
  const [superwords, setSuperwords] = useState<SuperwordsConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [newTrigger, setNewTrigger] = useState('');
  const [newSkillId, setNewSkillId] = useState('');
  const [editingTrigger, setEditingTrigger] = useState<string | null>(null);
  const [editTriggerValue, setEditTriggerValue] = useState('');
  const [editSkillIdValue, setEditSkillIdValue] = useState('');

  const getProjectById = (id: string) => {
    return projects.find((p) => p.id === id);
  };

  const fetchSuperwords = async () => {
    if (!activeProjectId) {
      setLoading(false);
      return;
    }
    
    const project = getProjectById(activeProjectId);
    if (!project) {
      setLoading(false);
      return;
    }
    
    try {
      setLoading(true);
      setError(null);
      const config = await getSuperwordsConfig({ id: project.id, path: project.path });
      setSuperwords(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load superwords');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSuperwords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, projects]);

  const validateTrigger = (trigger: string): boolean => {
    return trigger.trim().length > 0 && (trigger.startsWith('/') || trigger.startsWith('@'));
  };

  const handleAdd = async () => {
    if (!newTrigger.trim() || !newSkillId.trim()) {
      toast.error('Trigger and skill ID are required');
      return;
    }
    
    if (!validateTrigger(newTrigger)) {
      toast.error('Trigger must start with / or @');
      return;
    }
    
    const project = activeProjectId ? getProjectById(activeProjectId) : null;
    if (!project) {
      toast.error('No active project');
      return;
    }
    
    try {
      setSaving(true);
      const updated = { ...superwords, [newTrigger.trim()]: newSkillId.trim() };
      const success = await saveSuperwordsConfig({ id: project.id, path: project.path }, updated);
      
      if (success) {
        setSuperwords(updated);
        setNewTrigger('');
        setNewSkillId('');
        toast.success('Superword added');
      } else {
        toast.error('Failed to save superword');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add superword');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (trigger: string) => {
    setEditingTrigger(trigger);
    setEditTriggerValue(trigger);
    setEditSkillIdValue(superwords[trigger] || '');
  };

  const handleSaveEdit = async () => {
    if (!editTriggerValue.trim() || !editSkillIdValue.trim()) {
      toast.error('Trigger and skill ID are required');
      return;
    }
    
    if (!validateTrigger(editTriggerValue)) {
      toast.error('Trigger must start with / or @');
      return;
    }
    
    const project = activeProjectId ? getProjectById(activeProjectId) : null;
    if (!project) {
      toast.error('No active project');
      return;
    }
    
    try {
      setSaving(true);
      const updated: SuperwordsConfig = {};
      
      for (const [key, value] of Object.entries(superwords)) {
        if (key === editingTrigger) {
          continue;
        }
        updated[key] = value;
      }
      
      updated[editTriggerValue.trim()] = editSkillIdValue.trim();
      
      const success = await saveSuperwordsConfig({ id: project.id, path: project.path }, updated);
      
      if (success) {
        setSuperwords(updated);
        setEditingTrigger(null);
        setEditTriggerValue('');
        setEditSkillIdValue('');
        toast.success('Superword updated');
      } else {
        toast.error('Failed to update superword');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update superword');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (trigger: string) => {
    if (!confirm(`Delete superword "${trigger}"?`)) {
      return;
    }
    
    const project = activeProjectId ? getProjectById(activeProjectId) : null;
    if (!project) {
      toast.error('No active project');
      return;
    }
    
    try {
      setSaving(true);
      const updated: SuperwordsConfig = {};
      
      for (const [key, value] of Object.entries(superwords)) {
        if (key !== trigger) {
          updated[key] = value;
        }
      }
      
      const success = await saveSuperwordsConfig({ id: project.id, path: project.path }, updated);
      
      if (success) {
        setSuperwords(updated);
        toast.success('Superword deleted');
      } else {
        toast.error('Failed to delete superword');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete superword');
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    setEditingTrigger(null);
    setEditTriggerValue('');
    setEditSkillIdValue('');
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="typography-meta text-muted-foreground">Loading superwords...</div>
      </div>
    );
  }

  const triggerEntries = Object.entries(superwords);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="typography-ui-header font-semibold text-foreground">Superwords</h2>
          <p className="typography-meta text-muted-foreground mt-1">
            Configure trigger words that automatically activate skills
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchSuperwords}
          disabled={loading}
          className="h-7"
        >
          <RiRefreshLine className="w-4 h-4 mr-1" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      <div className="space-y-3">
        <div className="typography-ui-label text-foreground">Add New Superword</div>
        <div className="flex gap-2 items-start">
          <div className="flex-1">
            <Input
              value={newTrigger}
              onChange={(e) => setNewTrigger(e.target.value)}
              placeholder="/plan or @debug"
              className="h-8"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleAdd();
                }
              }}
            />
          </div>
          <div className="flex-1">
            <Input
              value={newSkillId}
              onChange={(e) => setNewSkillId(e.target.value)}
              placeholder="skill-id"
              className="h-8"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleAdd();
                }
              }}
            />
          </div>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={saving || !newTrigger.trim() || !newSkillId.trim()}
            className="h-8"
          >
            <RiAddLine className="w-4 h-4" />
          </Button>
        </div>
        <div className="typography-micro text-muted-foreground">
          Triggers must start with / or @
        </div>
      </div>

      {triggerEntries.length === 0 ? (
        <div className="typography-meta text-muted-foreground text-center py-8">
          No superwords configured. Add one above to get started.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="typography-ui-label text-foreground">Configured Superwords</div>
          {triggerEntries.map(([trigger, skillId]) => (
            <div
              key={trigger}
              className="flex items-start justify-between p-3 border rounded-lg hover:bg-muted/20"
            >
              {editingTrigger === trigger ? (
                <div className="flex-1 space-y-2">
                  <div className="flex gap-2">
                    <Input
                      value={editTriggerValue}
                      onChange={(e) => setEditTriggerValue(e.target.value)}
                      placeholder="/plan or @debug"
                      className="h-7 flex-1"
                    />
                    <Input
                      value={editSkillIdValue}
                      onChange={(e) => setEditSkillIdValue(e.target.value)}
                      placeholder="skill-id"
                      className="h-7 flex-1"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={handleSaveEdit}
                      disabled={saving}
                      className="h-7"
                    >
                      Save
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={cancelEdit}
                      disabled={saving}
                      className="h-7"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="typography-ui-label text-foreground font-medium font-mono">
                        {trigger}
                      </span>
                      <span className="typography-meta text-muted-foreground">
                        →
                      </span>
                      <span className="typography-meta text-muted-foreground font-mono">
                        {skillId}
                      </span>
                    </div>
                    <div className="typography-micro text-muted-foreground">
                      Messages starting with "{trigger}" will activate the "{skillId}" skill
                    </div>
                  </div>
                  <div className="flex gap-1 ml-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(trigger)}
                      className="h-7 px-2"
                      disabled={saving}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleDelete(trigger)}
                      className="h-7 px-2 text-red-600 hover:text-red-700"
                      disabled={saving}
                    >
                      <RiDeleteBinLine className="w-4 h-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
