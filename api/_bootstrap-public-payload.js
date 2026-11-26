import { compactWildfireDashboardPayload } from './_wildfire-dashboard.js';
import { compactNaturalEventsDashboardPayload } from './_natural-events-dashboard.js';

export function restoreWildfireBootstrapMetadata(value, seed) {
  if (seed == null) return value;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    ...value,
    fetchedAt: value.fetchedAt ?? seed?.fetchedAt ?? 0,
    dataAvailable: value.dataAvailable ?? Array.isArray(value.fireDetections),
  };
}

// All bootstrap transports expose the same public payload shape.
export function sanitizeBootstrapValue(name, value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  if (name === 'forecasts') {
    const { enrichmentMeta: _internal, ...rest } = value;
    return rest;
  }
  if (name === 'wildfires') return compactWildfireDashboardPayload(value);
  if (name === 'naturalEvents') return compactNaturalEventsDashboardPayload(value);
  if (name === 'chokepoints' && Array.isArray(value.chokepoints)) {
    return { ...value, chokepoints: value.chokepoints.map(cp => cp?.transitSummary ? {
      ...cp,
      transitSummary: { ...cp.transitSummary, riskSummary: '', riskReportAction: '' },
    } : cp) };
  }
  return value;
}
