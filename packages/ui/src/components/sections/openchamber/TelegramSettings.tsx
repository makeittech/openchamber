import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  RiTelegramLine,
  RiRefreshLine,
  RiExternalLinkLine,
} from '@remixicon/react';

interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUserIds: string;
  adminUserId: string;
}

export function TelegramSettings() {
  const [config, setConfig] = useState<TelegramConfig>({
    enabled: false,
    botToken: '',
    allowedUserIds: '',
    adminUserId: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  const fetchConfig = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/telegram');
      if (!response.ok) throw new Error('Failed to fetch telegram config');
      const data = await response.json();
      setConfig({
        enabled: data.enabled || false,
        botToken: data.botToken || '',
        allowedUserIds: data.allowedUserIds || '',
        adminUserId: data.adminUserId || '',
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      const response = await fetch('/api/telegram', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save config');
      }

      setSuccess('Telegram settings saved');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  const maskToken = (token: string): string => {
    if (!token || token.length < 10) return token;
    return `${token.substring(0, 8)}${'•'.repeat(20)}`;
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="typography-meta text-muted-foreground">Loading telegram settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <RiTelegramLine className="w-5 h-5" />
          <h2 className="typography-ui-header font-semibold text-foreground">Telegram Bridge</h2>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchConfig}
            className="h-7"
          >
            <RiRefreshLine className="w-4 h-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      {success && (
        <div className="p-3 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded text-sm text-green-800 dark:text-green-200">
          {success}
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Checkbox
            checked={config.enabled}
            onChange={(checked) => setConfig({ ...config, enabled: checked })}
            ariaLabel="Enable telegram bridge"
          />
          <label className="typography-ui-label text-foreground">
            Enable Telegram bridge
          </label>
        </div>

        <div className="p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded text-sm text-blue-800 dark:text-blue-200">
          <div className="font-medium mb-1">Setup Instructions</div>
          <ol className="list-decimal list-inside space-y-1 text-xs">
            <li>
              Create a bot with{' '}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
              >
                @BotFather <RiExternalLinkLine className="w-3 h-3" />
              </a>
            </li>
            <li>Copy the bot token and paste it below</li>
            <li>Message your bot to get your User ID</li>
            <li>Add your User ID to Allowed User IDs</li>
          </ol>
        </div>

        <div>
          <label className="typography-ui-label text-foreground block mb-1">
            Bot Token
          </label>
          <div className="relative">
            <Input
              type={showToken ? 'text' : 'password'}
              value={showToken ? config.botToken : maskToken(config.botToken)}
              onChange={(e) => {
                if (showToken) {
                  setConfig({ ...config, botToken: e.target.value });
                }
              }}
              onFocus={() => {
                if (!showToken && config.botToken) {
                  setShowToken(true);
                }
              }}
              onBlur={() => setShowToken(false)}
              placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
              className="h-7 pr-20"
            />
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setShowToken(!showToken);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="typography-micro text-muted-foreground mt-1">
            Get your bot token from @BotFather on Telegram
          </p>
        </div>

        <div>
          <label className="typography-ui-label text-foreground block mb-1">
            Allowed User IDs
          </label>
          <Input
            value={config.allowedUserIds}
            onChange={(e) => setConfig({ ...config, allowedUserIds: e.target.value })}
            placeholder="123456789,987654321"
            className="h-7"
          />
          <p className="typography-micro text-muted-foreground mt-1">
            Comma-separated list of Telegram user IDs (leave empty to allow all)
          </p>
        </div>

        <div>
          <label className="typography-ui-label text-foreground block mb-1">
            Admin User ID (Optional)
          </label>
          <Input
            value={config.adminUserId}
            onChange={(e) => setConfig({ ...config, adminUserId: e.target.value })}
            placeholder="123456789"
            className="h-7"
          />
          <p className="typography-micro text-muted-foreground mt-1">
            Telegram user ID for admin notifications
          </p>
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="h-7"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>
      </div>
    </div>
  );
}
