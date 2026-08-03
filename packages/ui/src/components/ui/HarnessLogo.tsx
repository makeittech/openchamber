import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import type { HarnessId } from '@/types/harness';
import { cn } from '@/lib/utils';

const ENGINE_LOGO_PROVIDER_ID: Record<HarnessId, string> = {
  opencode: 'opencode',
  'claude-code': 'claude-code',
};

interface HarnessLogoProps {
  harnessId: HarnessId | string;
  className?: string;
  alt?: string;
}

/** Brand mark for an execution engine (OpenCode / Claude Code). */
export const HarnessLogo: React.FC<HarnessLogoProps> = ({ harnessId, className, alt }) => {
  const providerId = harnessId === 'claude-code' || harnessId === 'opencode'
    ? ENGINE_LOGO_PROVIDER_ID[harnessId]
    : null;

  if (!providerId) {
    return null;
  }

  return (
    <ProviderLogo
      providerId={providerId}
      alt={alt}
      className={cn('object-contain', className)}
    />
  );
};
