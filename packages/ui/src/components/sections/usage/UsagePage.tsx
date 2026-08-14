import React from 'react';
import { USAGE_ADD_PROVIDER_ID } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { UsageAddProvider } from './UsageAddProvider';
import { UsageOverview } from './UsageOverview';
import { UsageProviderDetail } from './UsageProviderDetail';

export const UsagePage: React.FC = () => {
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);

  if (selectedProviderId === USAGE_ADD_PROVIDER_ID) {
    return <UsageAddProvider />;
  }

  if (selectedProviderId) {
    return <UsageProviderDetail providerId={selectedProviderId} />;
  }

  return <UsageOverview />;
};
