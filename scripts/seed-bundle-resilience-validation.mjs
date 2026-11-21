#!/usr/bin/env node
// Railway: dockerfilePath=Dockerfile.seed-bundle-resilience-validation.
// Hosted bundle images set NODE_OPTIONS for TypeScript imports; personal mode
// enables the same loader for this member through useTsxLoader in the bundle map.
import { runBundle } from './_bundle-runner.mjs';
import {
  RESILIENCE_VALIDATION_BUNDLE_MEMBERS,
  RESILIENCE_VALIDATION_BUNDLE_NAME,
} from './resilience-validation-bundle.mjs';

await runBundle(RESILIENCE_VALIDATION_BUNDLE_NAME, RESILIENCE_VALIDATION_BUNDLE_MEMBERS);
